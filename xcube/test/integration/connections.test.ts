/**
 * Slice 6 end to end, in one Cube process: a model's data source pushed as a
 * connection with its password sealed to xcube's credential key, queried
 * through it, tested, swapped while Cube runs, and dropped; then an overlay's
 * own data sources, previewed apart from the published ones (AC-280). The
 * warehouse is the test Postgres itself, and a second database on it. Runs
 * when XCUBE_TEST_DATABASE_URL names one.
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

// Widens what the runtime keeps protected: replaced revisions retire now, not after their grace.
class TestRuntime extends XcubeRuntime {
  public retireNow() {
    for (const revision of this.served.values()) {
      if (revision.state === 'retiring') {
        revision.retireAfter = 0;
      }
    }
    this.retireDue();
  }

  public overlayOrchestratorIds() {
    return [...this.overlayOrchestrators.values()].flatMap((ids) => [...ids]);
  }
}
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-connections';

describeWithDatabase('connections: data sources served from sealed credentials', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const schema = `xcube_t_${suffix}`;
  const warehouse = `conn_w_${suffix}`;
  const role = `conn_r_${suffix}`;
  const workspaceDb = `conn_ws_${suffix}`;
  const url = new URL(DATABASE_URL ?? 'postgres://x@localhost/x');
  const target = { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), ssl: false };
  let keysDir: string;
  let key: ReturnType<typeof generateCredentialKey>;
  let modelDir: string;
  let runtime: TestRuntime;
  let core: XcubeServerCore;
  let options: any;
  let server: http.Server;

  const sql = async (text: string, database?: string) => {
    const at = new URL(DATABASE_URL!);
    if (database) {
      at.pathname = `/${database}`;
    }
    const client = new Client({ connectionString: at.toString() });
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
    runtime = new TestRuntime(settings, { logger: () => undefined });
    await runtime.start();
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    // No driverFactory in cube.js and no CUBEJS_DB_TYPE: every data source is a connection.
    options = createConfig(runtime, { modelClaim: 'wechartModel', revisionClaim: 'wechartRevision' }, {
      apiSecret: API_SECRET,
      schemaPath: path.relative(process.cwd(), modelDir),
      cacheAndQueueDriver: 'memory',
      devServer: false,
      telemetry: false,
      logger: () => undefined,
      contextToApiScopes: async (_securityContext: any, defaults: any) => [...defaults, 'introspection'],
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
    fs.rmSync(modelDir, { recursive: true, force: true });
    fs.rmSync(keysDir, { recursive: true, force: true });
    await sql(`DROP DATABASE IF EXISTS ${workspaceDb} WITH (FORCE)`).catch(() => undefined);
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
  // An instance reports a connection's state in the background: wait for the report `until` accepts.
  const reported = async (name: string, until: (instance: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const health = (await admin('get', `/connections/${name}/health`).expect(200)).body;
      if (health.instances[0] && until(health.instances[0])) {
        return health;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return (await admin('get', `/connections/${name}/health`).expect(200)).body;
  };
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
    // Verification turned off, the stored secret kept: it no longer opens (TLS settings are bound).
    const unverified = await admin('put', '/connections/other', {
      ...connection(url.username, 'x'), fields: { ...target, user: url.username, ssl: true, sslRejectUnauthorized: false },
    }).expect(422);
    expect(unverified.body).toMatchObject({ code: 'invalid_secret' });
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
    const health = await reported('default', (i) => i.state === 'live');
    expect(health.instances).toEqual([expect.objectContaining({ instance: runtime.instanceId, state: 'live', current: true })]);
  });

  test('a changed connection is swapped in while Cube runs, with no restart', async () => {
    const before = (await admin('get', '/connections/default/health').expect(200)).body.version;
    const res = await admin('put', '/connections/default', connection(role, 'second-password')).expect(200);
    expect(res.body.version).toBeGreaterThan(before);
    const health = await reported('default', (i) => i.version === res.body.version);
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

  test('a connection\'s driver can\'t change, nor can one published cubes use be dropped', async () => {
    const changed = await admin('put', '/connections/default', {
      folderId: 'froot', driver: 'mysql', authMethod: 'password', fields: { ...target, user: 'x' }, sealed: { password: seal('x', target, 'password', 'mysql') },
    }).expect(409);
    expect(changed.body.code).toBe('driver_change');

    // orders names no data source: it uses the root's default.
    const used = await admin('delete', '/connections/default').expect(409);
    expect(used.body).toMatchObject({ code: 'in_use', problems: ['froot/orders uses it'] });
    const res = await admin('post', '/changesets', { baseRevision: revision, deletes: [{ folderId: 'froot', name: 'orders' }] }).expect(201);
    revision = res.body.revision;
    await admin('delete', '/connections/default').expect(204);
    await admin('get', '/connections/default/health').expect(404);
  });

  test('a dropped connection pushed again serves again, with no restart', async () => {
    await admin('put', '/connections/default', connection(role, 'second-password')).expect(200);
    const res = await admin('post', '/changesets', {
      baseRevision: revision,
      upserts: [{
        folderId: 'froot',
        name: 'orders',
        kind: 'cube',
        yaml: `cubes:\n  - name: orders\n    sql_table: ${warehouse}.orders\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n`,
      }],
    }).expect(201);
    revision = res.body.revision;
    const answer = await load();
    expect({ status: answer.status, error: answer.body.error }).toEqual({ status: 200, error: undefined });
    expect(answer.body.data[0]['orders.total']).toBe('42');
  });

  test('a cube in a folder names its data source by its short name, bound at publish to the nearest one (AC-273)', async () => {
    await admin('put', '/folders', { folders: [{ id: 'froot', parentId: null }, { id: 'fa', parentId: 'froot' }] }).expect(200);
    await admin('put', '/connections/fa__warehouse', { ...connection(role, 'second-password'), folderId: 'fa' }).expect(200);
    const res = await admin('post', '/changesets', {
      baseRevision: revision,
      upserts: [{
        folderId: 'fa',
        name: 'sales',
        kind: 'cube',
        yaml: `cubes:\n  - name: sales\n    data_source: warehouse\n    sql_table: ${warehouse}.orders\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n`,
      }],
    }).expect(201);
    revision = res.body.revision;
    const answer = await request(server).get('/cubejs-api/v1/load')
      .query({ query: JSON.stringify({ measures: ['fa__sales.total'] }) })
      .set('Authorization', jwt.sign({ wechartModel: 'dev', wechartRevision: revision }, API_SECRET));
    expect({ status: answer.status, error: answer.body.error }).toEqual({ status: 200, error: undefined });
    expect(answer.body.data[0]['fa__sales.total']).toBe('42');
    const health = await reported('fa__warehouse', (i) => i.state === 'live');
    expect(health.instances[0]).toMatchObject({ state: 'live', current: true });

    const unknown = await admin('post', '/changesets', {
      baseRevision: revision,
      upserts: [{ folderId: 'fa', name: 'lost', kind: 'cube', yaml: 'cubes:\n  - name: lost\n    data_source: nowhere\n    sql_table: t\n' }],
    }).expect(422);
    expect(unknown.body.errors[0].message).toMatch(/uses the data source "nowhere", which no folder on this item's path holds/);

    // Browsable in introspection, and in use: fa's sales won't let it go.
    const listed = await request(server).get('/cubejs-api/v1/introspection/data-sources')
      .set('Authorization', jwt.sign({ wechartModel: 'dev' }, API_SECRET))
      .expect(200);
    expect(listed.body.dataSources).toEqual(expect.arrayContaining([
      { dataSource: 'default', dbType: 'postgres' }, { dataSource: 'fa__warehouse', dbType: 'postgres' },
    ]));
    expect((await admin('delete', '/connections/fa__warehouse').expect(409)).body.problems).toEqual(['fa/sales uses it']);
  });

  describe('an overlay\'s own data sources (AC-280)', () => {
    const preview = (overlay: string, measure = 'orders.total') => request(server).get('/cubejs-api/v1/load')
      .query({ query: JSON.stringify({ measures: [measure] }) })
      .set('Authorization', jwt.sign({ wechartModel: 'dev', wechartRevision: revision, xcubeOverlay: overlay }, API_SECRET));
    // The workspace's copy of `default`: the same host, another database, the published envelope byte for byte.
    const copy = (fields: object = {}) => ({
      folderId: 'froot',
      name: 'default',
      driver: 'postgres',
      authMethod: 'password',
      fields: { ...target, user: role, database: workspaceDb, ...fields },
      sealed: { password: seal('second-password') },
    });
    let copyVersion = 0;
    const connectionsTo = async (database: string) => {
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      try {
        const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [database]);
        return n as number;
      } finally {
        await client.end();
      }
    };

    beforeAll(async () => {
      await sql(`CREATE DATABASE ${workspaceDb}`);
      await sql(`CREATE SCHEMA ${warehouse};
        CREATE TABLE ${warehouse}.orders (id int PRIMARY KEY, amount int);
        INSERT INTO ${warehouse}.orders VALUES (1, 3), (2, 4);
        GRANT USAGE ON SCHEMA ${warehouse} TO ${role};
        GRANT SELECT ON ${warehouse}.orders TO ${role};`, workspaceDb);
    });

    test('a copy pointed at another database is previewed on it, the same SQL never answered from the other\'s cache', async () => {
      const pushed = await admin('put', '/overlays/ws-copy', { upserts: [], deletes: [], connections: [copy()] }).expect(201);
      expect(pushed.body.version).toBeGreaterThan(0);
      copyVersion = pushed.body.version;

      const first = await preview('ws-copy').expect(200);
      expect(first.body.data[0]['orders.total']).toBe('7');
      // The published model's answer, and the overlay's again: Cube caches by SQL, which is the same.
      expect((await load().expect(200)).body.data[0]['orders.total']).toBe('42');
      expect((await preview('ws-copy').expect(200)).body.data[0]['orders.total']).toBe('7');

      const status = await admin('get', '/overlays/ws-copy').expect(200);
      expect(status.body.connections).toEqual([expect.objectContaining({
        folderId: 'froot', name: 'default', fullName: 'default', driver: 'postgres', secrets: ['password'],
      })]);
      expect(JSON.stringify(status.body)).not.toContain('"enc"');
      // Its own orchestrator, which no model's id can name: model ids have no capitals.
      expect(runtime.overlayOrchestratorIds()).toContain(`STANDALONE_dev_O_ws-copy_${copyVersion}`);
    });

    test('a copy aimed at another host, or with verification turned off, needs its secret again', async () => {
      const moved = await admin('put', '/overlays/ws-copy', { connections: [copy({ host: 'elsewhere.example.com' })] }).expect(422);
      expect(moved.body).toMatchObject({ code: 'invalid_secret' });
      expect(moved.body.error).toContain('froot/default');
      await admin('put', '/overlays/ws-copy', { connections: [copy({ ssl: true, sslRejectUnauthorized: false })] }).expect(422);
      const wrong = await admin('put', '/overlays/ws-copy', { connections: [{ ...copy(), driver: 'nope' }] }).expect(400);
      expect(wrong.body.code).toBe('invalid_connection');
      // Refused, the overlay stays as it was.
      expect((await preview('ws-copy').expect(200)).body.data[0]['orders.total']).toBe('7');
    });

    test('a data source only the workspace has binds the workspace\'s cubes, in its own dialect', async () => {
      const res = await admin('put', '/overlays/ws-new', {
        upserts: [{
          folderId: 'froot',
          name: 'ws_orders',
          kind: 'cube',
          yaml: `cubes:\n  - name: ws_orders\n    data_source: scratch\n    sql_table: ${warehouse}.orders\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n`,
        }],
        connections: [{ ...copy(), name: 'scratch' }],
      }).expect(201);
      expect(res.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ws_orders' })]));
      expect((await preview('ws-new', 'ws_orders.total').expect(200)).body.data[0]['ws_orders.total']).toBe('7');
      // Published, nothing names it.
      expect((await load().expect(200)).body.data[0]['orders.total']).toBe('42');
    });

    test('an overlay brings data sources only once no older xcube, which would ignore them, serves', async () => {
      const older = new Client({ connectionString: DATABASE_URL, application_name: 'xcube:v6:older-instance' });
      await older.connect();
      try {
        const refused = await admin('put', '/overlays/ws-old', { connections: [copy()] }).expect(409);
        expect(refused.body).toMatchObject({ code: 'older_instances', instances: ['xcube:v6:older-instance'] });
        await admin('put', '/overlays/ws-old', {}).expect(201);
      } finally {
        await older.end();
      }
      await admin('delete', '/overlays/ws-old').expect(204);
    });

    test('dropped, an overlay\'s data sources are released with the orchestrator its previews had', async () => {
      expect(await connectionsTo(workspaceDb)).toBeGreaterThan(0);
      await admin('delete', '/overlays/ws-copy').expect(204);
      await admin('delete', '/overlays/ws-new').expect(204);
      runtime.retireNow();
      for (let i = 0; i < 100 && await connectionsTo(workspaceDb) > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await connectionsTo(workspaceDb)).toBe(0);
      await preview('ws-copy').expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
      // Cube asks a compiled model's dialect with the context that compiled it, maybe a preview's
      // long gone: answered. A driver for that preview is refused, never a published one.
      const gone = {
        securityContext: { wechartModel: 'dev' }, xcubePin: { model: 'dev', appId: `xcube:dev:o:ws-copy:${copyVersion}:t0@x` }, dataSource: 'default',
      };
      await expect(options.driverFactory(gone)).resolves.toEqual({ type: 'postgres' });
      await expect(core.resolveDriver(gone)).rejects.toThrow(/no longer compiled here/);
      expect((await load().expect(200)).body.data[0]['orders.total']).toBe('42');
    });
  });
});
