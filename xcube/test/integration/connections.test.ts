/**
 * Slice 6 end to end, in one Cube process: a model's data source pushed as a
 * connection with its password sealed to xcube's credential key, queried
 * through it, tested, swapped while Cube runs, and dropped. The warehouse is
 * the test Postgres itself. Runs when XCUBE_TEST_DATABASE_URL names one.
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

const API_SECRET = 'connections-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-connections';

describeWithDatabase('connections: data sources served from sealed credentials', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const schema = `xcube_t_${suffix}`;
  const warehouse = `conn_w_${suffix}`;
  const role = `conn_r_${suffix}`;
  const url = new URL(DATABASE_URL ?? 'postgres://x@localhost/x');
  const target = { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), ssl: false };
  let keysDir: string;
  let key: ReturnType<typeof generateCredentialKey>;
  let modelDir: string;
  let runtime: XcubeRuntime;
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
      INSERT INTO ${warehouse}.orders VALUES (1, 10), (2, 32);
      CREATE ROLE ${role} LOGIN PASSWORD 'second-password';
      GRANT USAGE ON SCHEMA ${warehouse} TO ${role};
      GRANT SELECT ON ${warehouse}.orders TO ${role};`);
    keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-credential-keys-'));
    key = generateCredentialKey();
    fs.writeFileSync(path.join(keysDir, `${key.kid}.pem`), key.pem);
    fs.writeFileSync(path.join(keysDir, `${key.kid}.check`), key.check);
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-connections-'));

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
    // No driverFactory in cube.js and no CUBEJS_DB_TYPE: every data source is a connection.
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
    await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${warehouse} CASCADE;
      DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role};`).catch(() => undefined);
  });

  const base = '/cubejs-api/v1/semantic/models/dev';
  const admin = (method: 'put' | 'post' | 'get' | 'delete', route: string, body?: object) => {
    const req = request(server)[method](`${base}${route}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    return body ? req.send(body) : req;
  };
  const seal = (secret: string, fields: object = target, field = 'password', driver: any = 'postgres') => sealSecretV1(key.jwk.x, key.kid, driver, field, fields as any, secret);
  const connection = (user: string, password: string) => ({
    folderId: 'froot',
    driver: 'postgres',
    authMethod: 'password',
    fields: { ...target, user },
    sealed: { password: seal(password) },
    revisions: { password: `rev-${user}` },
  });
  let revision = 0;
  const load = () => request(server).get('/cubejs-api/v1/load')
    .query({ query: JSON.stringify({ measures: ['orders.total'] }) })
    .set('Authorization', jwt.sign({ wechartModel: 'dev', wechartRevision: revision }, API_SECRET));

  test('the client gets xcube\'s credential key to seal to', async () => {
    const res = await request(server).get('/cubejs-api/v1/semantic/credential-keys').set('Authorization', `Bearer ${ADMIN_TOKEN}`).expect(200);
    expect(res.body).toEqual({ keys: [{ kid: key.kid, x: key.jwk.x, active: true }] });
  });

  test('a connection is taken once its fields are right and its secret opens for its target', async () => {
    const res = await admin('put', '/connections/default', connection(url.username, decodeURIComponent(url.password))).expect(200);
    expect(res.body).toMatchObject({ model: 'dev', name: 'default', driver: 'postgres', secrets: ['password'], revisions: { password: `rev-${url.username}` } });
    // What was sealed comes back only as the fields' names: no envelope, no password.
    expect(res.body.fields).not.toHaveProperty('password');
    expect(res.body).not.toHaveProperty('sealed');
    expect(JSON.stringify(res.body)).not.toContain('"enc"');

    const moved = await admin('put', '/connections/other', {
      ...connection(url.username, 'x'), sealed: { password: seal('x', { ...target, host: 'elsewhere.example.com' }) },
    }).expect(422);
    expect(moved.body).toMatchObject({ code: 'invalid_secret' });
    const wrong = await admin('put', '/connections/other', { ...connection(url.username, 'x'), fields: { ...target, password: 'plain' } }).expect(400);
    expect(wrong.body.problems).toContain('password is a secret: send it sealed, never in the fields');
    await admin('put', '/connections/fnope__other', { ...connection(url.username, 'x'), folderId: 'fnope' }).expect(400);
    const listed = await admin('get', '/connections').expect(200);
    expect(listed.body.connections.map((c: any) => c.name)).toEqual(['default']);
    expect(JSON.stringify(listed.body)).not.toContain('"enc"');
  });

  test('a model\'s cubes query their data source through its connection', async () => {
    const res = await admin('put', '/snapshot', {
      baseRevision: null,
      folders: [{ id: 'froot', parentId: null }],
      items: [{
        folderId: 'froot',
        name: 'orders',
        kind: 'cube',
        yaml: `cubes:\n  - name: orders\n    sql_table: ${warehouse}.orders\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n`,
      }],
    }).expect(201);
    revision = res.body.revision;
    const answer = await load().expect(200);
    expect(answer.body.data[0]['orders.total']).toBe('42');
    const health = await admin('get', '/connections/default/health').expect(200);
    expect(health.body.instances).toEqual([expect.objectContaining({ instance: runtime.instanceId, state: 'live', current: true })]);
  });

  test('a changed connection is swapped in while Cube runs, with no restart', async () => {
    const before = (await admin('get', '/connections/default/health').expect(200)).body.version;
    const res = await admin('put', '/connections/default', connection(role, 'second-password')).expect(200);
    expect(res.body.version).toBeGreaterThan(before);
    for (let i = 0; i < 50; i++) {
      const health = (await admin('get', '/connections/default/health')).body;
      if (health.instances[0]?.version === res.body.version) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const health = (await admin('get', '/connections/default/health').expect(200)).body;
    expect(health.instances[0]).toMatchObject({ version: res.body.version, state: 'live', current: true });
    expect((await load().expect(200)).body.data[0]['orders.total']).toBe('42');
  });

  test('the test route connects as Cube would, and never echoes a secret', async () => {
    const good = await admin('post', '/connections/test', { driver: 'postgres', authMethod: 'password', fields: { ...target, user: role }, sealed: { password: seal('second-password') } }).expect(200);
    expect(good.body.ok).toBe(true);
    expect(good.body.checks.map((c: any) => [c.id, c.status])).toEqual([['secrets', 'passed'], ['config', 'passed'], ['connect', 'passed'], ['schemas', 'passed']]);

    const bad = await admin('post', '/connections/test', { driver: 'postgres', authMethod: 'password', fields: { ...target, user: role }, sealed: { password: seal('not-the-password-123') } }).expect(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.checks.find((c: any) => c.id === 'connect')).toMatchObject({ status: 'failed', error: expect.stringMatching(/password authentication failed/) });
    expect(JSON.stringify(bad.body)).not.toContain('not-the-password-123');

    const unopened = await admin('post', '/connections/test', { driver: 'postgres', authMethod: 'password', fields: { ...target, host: 'other', user: role }, sealed: { password: seal('x') } }).expect(200);
    expect(unopened.body.checks[0]).toMatchObject({ id: 'secrets', status: 'failed', error: expect.stringMatching(/can't be used for this connection target/) });
  });

  test('a secret is re-wrapped to the active key with the same binding, and never returned opened', async () => {
    const res = await request(server).post('/cubejs-api/v1/semantic/credentials/rewrap')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({
        items: [
          { ref: 'a', driver: 'postgres', field: 'password', fields: target, envelope: seal('hunter2') },
          { ref: 'b', driver: 'postgres', field: 'password', fields: { ...target, host: 'x' }, envelope: seal('hunter2') },
        ],
      })
      .expect(200);
    expect(res.body.items[0]).toMatchObject({ ref: 'a', envelope: { v: 1, kid: key.kid } });
    expect(res.body.items[1]).toMatchObject({ ref: 'b', error: expect.stringMatching(/doesn't open/) });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  test('a connection\'s driver can\'t change; one dropped is refused by Cube at once', async () => {
    const changed = await admin('put', '/connections/default', {
      folderId: 'froot', driver: 'mysql', authMethod: 'password', fields: { ...target, user: 'x' }, sealed: { password: seal('x', target, 'password', 'mysql') },
    }).expect(409);
    expect(changed.body.code).toBe('driver_change');

    await admin('delete', '/connections/default').expect(204);
    await admin('get', '/connections/default/health').expect(404);
    let answer: any;
    for (let i = 0; i < 50; i++) {
      answer = await load();
      if (answer.status !== 200) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(answer.status).not.toBe(200);
    expect(answer.body.error).toMatch(/Connection "default" was removed|Data source "default" of model "dev" has no connection/);
  });

  test('a dropped connection pushed again serves again, with no restart', async () => {
    await admin('put', '/connections/default', connection(role, 'second-password')).expect(200);
    let answer: any;
    for (let i = 0; i < 50; i++) {
      answer = await load();
      if (answer.status === 200) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect({ status: answer.status, error: answer.body.error }).toEqual({ status: 200, error: undefined });
    expect(answer.body.data[0]['orders.total']).toBe('42');
  });
});
