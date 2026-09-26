/**
 * Connections to real data sources, one per driver we can run: each
 * connection's password sealed, tested through the test route, and queried
 * through Cube's own driver. Each runs when its server is given:
 *
 *   XCUBE_TEST_DATABASE_URL        xcube's store (Postgres), always needed
 *   XCUBE_TEST_DREMIO_URL          a Dremio, e.g. http://127.0.0.1:9047 (docker run dremio/dremio-oss);
 *                                  its first user is made here
 *   INTROSPECTION_TEST_MYSQL       a MySQL as host:port (user root, password test, database test), as CI's
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import bodyParser from 'body-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { Client } from 'pg';

import {
  createConfig, generateCredentialKey, sealSecretV1, XcubeRuntime, XcubeServerCore, type DriverType, type XcubeSettings,
} from '../../src';

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;

jest.setTimeout(300 * 1000);

const API_SECRET = 'drivers-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-drivers-01';

interface DriverCase {
  driver: DriverType;
  /** The connection's fields, secrets excepted, and its password. */
  fields: Record<string, string | number | boolean>;
  password: string;
  /** A cube's SQL the source answers with ids 1 and 2, amounts 10 and 32. */
  sql: string;
  setup?: () => Promise<void>;
}

function suite(title: string, available: boolean, make: () => DriverCase) {
  (DATABASE_URL && available ? describe : describe.skip)(title, () => {
    const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
    const c = available ? make() : ({} as DriverCase);
    let keysDir: string;
    let key: ReturnType<typeof generateCredentialKey>;
    let modelDir: string;
    let runtime: XcubeRuntime;
    let core: XcubeServerCore;
    let server: http.Server;

    beforeAll(async () => {
      await c.setup?.();
      keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-credential-keys-'));
      key = generateCredentialKey();
      fs.writeFileSync(path.join(keysDir, `${key.kid}.pem`), key.pem);
      fs.writeFileSync(path.join(keysDir, `${key.kid}.check`), key.check);
      modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-drivers-'));
      const settings: XcubeSettings = {
        databaseUrl: DATABASE_URL!,
        schema,
        migrate: true,
        pollIntervalMs: 60000,
        pollIntervalDownMs: 1000,
        retireGraceMs: 60000,
        keepRevisions: 10,
        limits: { maxBytes: 1024 * 1024, maxFileBytes: 256 * 1024, maxFiles: 100, fileTypes: 'yaml' },
        compileQueue: 4,
        compileWaitMs: 60000,
        catchUpMs: 10000,
        adminTokens: [ADMIN_TOKEN],
        maxModels: 100,
        modules: { packMin: 1, packMax: 300 },
        credentials: { dir: keysDir, kids: [key.kid], activeKid: key.kid },
      };
      runtime = new XcubeRuntime(settings, { logger: () => undefined });
      await runtime.start();
      const nodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      core = new XcubeServerCore(createConfig(runtime, { modelClaim: 'wechartModel', revisionClaim: 'wechartRevision' }, {
        apiSecret: API_SECRET,
        schemaPath: path.relative(process.cwd(), modelDir),
        cacheAndQueueDriver: 'memory',
        devServer: false,
        telemetry: false,
        logger: () => undefined,
      }) as any);
      process.env.NODE_ENV = nodeEnv;
      await runtime.attach(core);
      const app = express();
      app.use(bodyParser.json({ limit: '50mb' }));
      await core.initApp(app);
      server = app.listen(0);
    });

    afterAll(async () => {
      server?.close();
      await runtime?.stop();
      await core?.shutdown();
      fs.rmSync(modelDir, { recursive: true, force: true });
      fs.rmSync(keysDir, { recursive: true, force: true });
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    });

    const base = '/cubejs-api/v1/semantic/models/dev';
    const admin = (method: 'put' | 'post', route: string, body: object) => request(server)[method](`${base}${route}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(body);
    const connection = (password: string) => ({
      driver: c.driver,
      authMethod: 'password',
      fields: c.fields,
      sealed: { password: sealSecretV1(key.jwk.x, key.kid, c.driver, 'password', c.fields, password) },
    });

    test('the test route connects as Cube would, and refuses a wrong password without echoing it', async () => {
      const good = await admin('post', '/connections/test', connection(c.password)).expect(200);
      expect(good.body.checks.filter((k: any) => k.id !== 'schemas').map((k: any) => [k.id, k.status]))
        .toEqual([['secrets', 'passed'], ['config', 'passed'], ['connect', 'passed']]);
      const bad = await admin('post', '/connections/test', connection('wrong-password-123')).expect(200);
      expect(bad.body.checks.find((k: any) => k.id === 'connect')).toMatchObject({ status: 'failed' });
      expect(JSON.stringify(bad.body)).not.toContain('wrong-password-123');
    });

    test('a model\'s cube queries the source through the connection', async () => {
      await admin('put', '/connections/default', { folderId: 'froot', ...connection(c.password) }).expect(200);
      const res = await admin('put', '/snapshot', {
        baseRevision: null,
        folders: [{ id: 'froot', parentId: null }],
        items: [{
          folderId: 'froot',
          name: 'orders',
          kind: 'cube',
          yaml: `cubes:\n  - name: orders\n    sql: ${JSON.stringify(c.sql)}\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n`,
        }],
      }).expect(201);
      const answer = await request(server).get('/cubejs-api/v1/load')
        .query({ query: JSON.stringify({ measures: ['orders.total'] }) })
        .set('Authorization', jwt.sign({ wechartModel: 'dev', wechartRevision: res.body.revision }, API_SECRET));
      expect({ status: answer.status, error: answer.body.error }).toEqual({ status: 200, error: undefined });
      expect(Number(answer.body.data[0]['orders.total'])).toBe(42);
    });
  });
}

const DREMIO_URL = process.env.XCUBE_TEST_DREMIO_URL;
suite('a Dremio Software data source', Boolean(DREMIO_URL), () => {
  const url = new URL(DREMIO_URL!);
  const user = 'xcube';
  const password = 'xcube-dremio-pass1';
  return {
    driver: 'dremio',
    fields: { host: url.hostname, port: Number(url.port || 9047), ssl: false, user },
    password,
    sql: 'SELECT * FROM (VALUES (1, 10), (2, 32)) AS t(id, amount)',
    // Dremio's first user; answered 400 once it exists.
    setup: async () => {
      await fetch(`${DREMIO_URL}/apiv2/bootstrap/firstuser`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: '_dremionull' },
        body: JSON.stringify({ userName: user, firstName: 'x', lastName: 'cube', email: 'xcube@example.com', createdAt: Date.now(), password }),
      });
    },
  };
});

const MYSQL = process.env.INTROSPECTION_TEST_MYSQL;
suite('a MySQL data source', Boolean(MYSQL), () => {
  const [host, port] = MYSQL!.split(':');
  return {
    driver: 'mysql',
    fields: { host, port: Number(port || 3306), database: 'test', ssl: false, user: 'root' },
    password: 'test',
    sql: 'SELECT 1 AS id, 10 AS amount UNION ALL SELECT 2, 32',
  };
});
