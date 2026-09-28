/**
 * A model served first from Cube's environment, then from a connection stored
 * under the same name: its cubes keep their names (and rollup tables) only if
 * the connection reaches where the environment did. Runs when
 * XCUBE_TEST_DATABASE_URL names a database, which is also the environment's.
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
  createConfig, generateCredentialKey, sealSecretV1, XcubeRuntime, XcubeServerCore, type XcubeSettings,
} from '../../src';

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(180 * 1000);

const API_SECRET = 'environment-bases-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-environment';

// Widens what the runtime keeps protected: the key a model is served under now.
class TestRuntime extends XcubeRuntime {
  public servedKey(model: string) {
    return this.models.get(model)?.active?.key;
  }
}

describeWithDatabase('a data source served from Cube\'s environment, then from a stored connection', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const schema = `xcube_t_${suffix}`;
  const warehouse = `env_w_${suffix}`;
  const url = new URL(DATABASE_URL ?? 'postgres://x@localhost/x');
  const target = { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), ssl: false };
  const environment: Record<string, string> = {
    CUBEJS_DB_TYPE: 'postgres',
    CUBEJS_DB_HOST: url.hostname,
    CUBEJS_DB_PORT: url.port || '5432',
    CUBEJS_DB_NAME: url.pathname.slice(1),
    CUBEJS_DB_USER: decodeURIComponent(url.username),
    CUBEJS_DB_PASS: decodeURIComponent(url.password),
  };
  let keysDir: string;
  let key: ReturnType<typeof generateCredentialKey>;
  let modelDir: string;
  let runtime: TestRuntime;
  let core: XcubeServerCore;
  let server: http.Server;

  const sql = async (text: string) => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query(text);
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    await sql(`CREATE SCHEMA ${warehouse};
      CREATE TABLE ${warehouse}.orders (id int PRIMARY KEY, amount int);
      INSERT INTO ${warehouse}.orders VALUES (1, 10), (2, 32);`);
    Object.assign(process.env, environment);
    keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-credential-keys-'));
    key = generateCredentialKey();
    fs.writeFileSync(path.join(keysDir, `${key.kid}.pem`), key.pem);
    fs.writeFileSync(path.join(keysDir, `${key.kid}.check`), key.check);
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-environment-'));

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
    runtime = new TestRuntime(settings, { logger: () => undefined });
    await runtime.start();
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const options = createConfig(runtime, { modelClaim: 'wechartModel', revisionClaim: 'wechartRevision' }, {
      apiSecret: API_SECRET,
      schemaPath: path.relative(process.cwd(), modelDir),
      cacheAndQueueDriver: 'memory',
      devServer: false,
      telemetry: false,
      logger: () => undefined,
    });
    core = new XcubeServerCore(options);
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
    Object.keys(environment).forEach((name) => delete process.env[name]);
    fs.rmSync(modelDir, { recursive: true, force: true });
    fs.rmSync(keysDir, { recursive: true, force: true });
    await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${warehouse} CASCADE;`).catch(() => undefined);
  });

  const admin = (model: string, method: 'put' | 'get' | 'post' | 'delete', route: string, body?: object) => {
    const req = request(server)[method](`/cubejs-api/v1/semantic/models/${model}${route}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    return body ? req.send(body) : req;
  };
  const token = (model: string, revision: number) => jwt.sign({ wechartModel: model, wechartRevision: revision }, API_SECRET);
  const rollupOf = async (model: string, revision: number) => (await request(server).get('/cubejs-api/v1/sql')
    .query({ query: JSON.stringify({ measures: ['orders.total'] }) })
    .set('Authorization', token(model, revision))
    .expect(200)).body.sql.preAggregations[0]?.tableName as string;
  const ids = async (model: string, revision: number) => (await request(server).get('/cubejs-api/v1/load')
    .query({ query: JSON.stringify({ dimensions: ['orders.id'], order: { 'orders.id': 'asc' } }) })
    .set('Authorization', token(model, revision))
    .expect(200)).body.data.map((row: any) => row['orders.id']);
  const orders = {
    folderId: 'froot',
    name: 'orders',
    kind: 'cube',
    yaml: `cubes:\n  - name: orders\n    sql_table: ${warehouse}.orders\n    dimensions:\n      - name: id\n        sql: id\n        type: number\n        primary_key: true\n        public: true\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n    pre_aggregations:\n      - name: by_all\n        measures:\n          - CUBE.total\n`,
  };
  const publish = async (model: string) => (await admin(model, 'put', '/snapshot', {
    baseRevision: null,
    folders: [{ id: 'froot', parentId: null }],
    items: [orders],
  }).expect(201)).body.revision as number;
  // Stores the model's `default`, then waits for it to be served over it.
  const store = async (model: string, fields: object, served = true) => {
    await admin(model, 'put', '/connections/default', {
      folderId: 'froot',
      driver: 'postgres',
      authMethod: 'password',
      fields,
      sealed: { password: sealSecretV1(key.jwk.x, key.kid, 'postgres', 'password', fields as any, environment.CUBEJS_DB_PASS) },
      revisions: { password: 'r1' },
    }).expect(200);
    if (!served) {
      return;
    }
    for (let i = 0; i < 100 && !runtime.servedKey(model)?.includes('~'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(runtime.servedKey(model)).toContain('~');
  };

  test('a connection stored reaching where the environment did: the cubes keep their names and rollup tables', async () => {
    const revision = await publish('same');
    expect(await ids('same', revision)).toEqual(['1', '2']);
    const before = await rollupOf('same', revision);
    expect(before).toMatch(/\.orders_by_all/);

    await store('same', { ...target, user: environment.CUBEJS_DB_USER });
    expect(await rollupOf('same', revision)).toBe(before);
    expect(await ids('same', revision)).toEqual(['1', '2']);
  });

  test('a connection stored aimed elsewhere: the cubes are served under new names, never the environment\'s tables', async () => {
    const revision = await publish('elsewhere');
    const before = await rollupOf('elsewhere', revision);
    expect(before).toMatch(/\.orders_by_all/);

    await store('elsewhere', { ...target, database: 'template1', user: environment.CUBEJS_DB_USER });
    const after = await rollupOf('elsewhere', revision);
    expect(after).toBeTruthy();
    expect(after).not.toMatch(/\.orders_by_all/);
  });

  // Drops the model's `default` (its cube first, which uses it), then publishes the cube again, on the environment.
  const toEnvironment = async (model: string, revision: number) => {
    const emptied = (await admin(model, 'post', '/changesets', { baseRevision: revision, deletes: [{ folderId: 'froot', name: 'orders' }] }).expect(201)).body.revision;
    await admin(model, 'delete', '/connections/default').expect(204);
    const republished = (await admin(model, 'post', '/changesets', {
      baseRevision: emptied,
      upserts: [orders],
    }).expect(201)).body.revision as number;
    return republished;
  };

  test('served by the environment again once its connection goes: its own names where the environment reaches the base\'s target', async () => {
    // `same`'s base is its connection's now, which reaches where the environment does.
    const head = (await admin('same', 'get', '/revision').expect(200)).body.current.revision;
    const again = await toEnvironment('same', head);
    expect(await rollupOf('same', again)).toMatch(/\.orders_by_all/);
    expect(await ids('same', again)).toEqual(['1', '2']);

    // A model whose `default` was stored first, aimed elsewhere: the environment serving it is a move.
    await store('third', { ...target, database: 'template1', user: environment.CUBEJS_DB_USER }, false);
    const revision = await publish('third');
    expect(await rollupOf('third', revision)).toMatch(/\.orders_by_all/);
    const moved = await toEnvironment('third', revision);
    expect(await rollupOf('third', moved)).not.toMatch(/\.orders_by_all/);
    expect(await ids('third', moved)).toEqual(['1', '2']);
  });
});
