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
import type { SnapshotFile } from '../../src/model/snapshot';
import type { Probe } from '../../src/model/validate';
import type { Priority } from '../../src/runtime/lane';
import type { ModelHead, StoredModule } from '../../src/store/revisions';

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

  /** Runs once, as the next check of a publish begins: another writer, just then. */
  public beforeValidate: (() => Promise<void>) | null = null;

  protected override async validateModules(
    model: string,
    head: ModelHead | null,
    files: SnapshotFile[],
    modules: StoredModule[],
    priority: Priority,
    securityContext: Record<string, unknown>,
    probes: Probe[],
  ) {
    const hook = this.beforeValidate;
    this.beforeValidate = null;
    await hook?.();
    return super.validateModules(model, head, files, modules, priority, securityContext, probes);
  }

  /** A file as the model is served now, and as it was published. */
  public servedFile(model: string, filePath: string) {
    const active = this.models.get(model)?.active;
    const find = (files?: SnapshotFile[]) => files?.find((f) => f.path === filePath)?.content;
    return { served: find(active?.data.files), published: find(active?.source.files) };
  }

  public async storeAt(model: string) {
    const store = this.requireStore();
    const head = await store.head(model);
    return { store, head, items: head ? await this.itemsAt(head) : [] };
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

  test('an instance re-reports the connections it holds, keeping what it reported, so a report within the hour means running', async () => {
    const before = (await reported('default', (i) => i.state === 'live')).instances[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.connections.heartbeat();
    const after = (await admin('get', '/connections/default/health').expect(200)).body.instances[0];
    expect(new Date(after.reportedAt).getTime()).toBeGreaterThan(new Date(before.reportedAt).getTime());
    expect(after).toMatchObject({ instance: before.instance, version: before.version, state: 'live', current: true });
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
    // The heartbeat doesn't bring back the reports of a connection that is gone.
    await runtime.connections.heartbeat();
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { rows: [{ n }] } = await client.query(`SELECT count(*)::int AS n FROM ${schema}.connection_reports WHERE model = 'dev' AND name = 'default'`);
      expect(n).toBe(0);
    } finally {
      await client.end();
    }
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

  test('a publish checked while another folder\'s data source goes is told its base moved, never refused over it', async () => {
    // Another writer, just as this publish is checked: removes fa's sales, then the data source it alone used.
    let moved = 0;
    const other = async () => {
      const gone = await admin('post', '/changesets', { baseRevision: revision, deletes: [{ folderId: 'fa', name: 'sales' }] }).expect(201);
      await admin('delete', '/connections/fa__warehouse').expect(204);
      moved = gone.body.revision;
    };
    // It joins fa's sales, so its check compiles sales, bound to that data source.
    const joined = {
      folderId: 'fa',
      name: 'joined',
      kind: 'cube',
      yaml: `cubes:\n  - name: joined\n    sql_table: ${warehouse}.orders\n    joins:\n      - name: sales\n        relationship: many_to_one\n        sql: "{CUBE}.id = {sales}.id"\n    measures:\n      - name: count\n        type: count\n`,
    };

    runtime.beforeValidate = other;
    const dry = await admin('post', '/changesets?dryRun=true', { baseRevision: revision, upserts: [joined] }).expect(200);
    // Checked again against what is published now: refused for what it names, not for a data source it never did.
    expect(dry.body).toMatchObject({ valid: false, currentRevision: moved });
    expect(JSON.stringify(dry.body.errors)).not.toMatch(/has no connection/);
    revision = moved;

    // Once more for a publish: sales and its data source back, then gone again during the check.
    await admin('put', '/connections/fa__warehouse', { ...connection(role, 'second-password'), folderId: 'fa' }).expect(200);
    const back = await admin('post', '/changesets', {
      baseRevision: revision,
      upserts: [{ folderId: 'fa', name: 'sales', kind: 'cube', yaml: `cubes:\n  - name: sales\n    data_source: warehouse\n    sql_table: ${warehouse}.orders\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n` }],
    }).expect(201);
    revision = back.body.revision;
    runtime.beforeValidate = other;
    const refused = await admin('post', '/changesets', { baseRevision: revision, upserts: [joined] }).expect(409);
    expect(refused.body).toMatchObject({ code: 'conflict', currentRevision: moved });
    revision = moved;
  });

  test('a publish binding to a data source removed after its check is not stored; a removal waits out a publish', async () => {
    const { store, head, items } = await runtime.storeAt('dev');
    const stored = await store.importItems({
      model: 'dev', baseRevision: head!.revision, items, itemsHash: 'f'.repeat(64), source: {}, dataSources: ['fa__gone'],
    });
    expect(stored).toMatchObject({ outcome: 'conflict' });
    expect((await store.head('dev'))!.revision).toBe(head!.revision);
    // A removal checked at a revision since replaced is checked again.
    expect(await store.deleteConnection('dev', 'default', head!.revision - 1)).toBe('moved');
    await admin('get', '/connections/default/health').expect(200);
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
      // Its own orchestrator, of its base's connection settings, which no model's id can name: model ids have no capitals.
      expect(runtime.overlayOrchestratorIds()).toEqual([expect.stringMatching(new RegExp(`^STANDALONE_dev_O_ws-copy_${copyVersion}_[0-9a-f]{12}$`))]);
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

    test('a cube published again onto a nearer data source answers from it at once, never from the old one\'s cache (AC-273)', async () => {
      await admin('put', '/folders', {
        folders: [{ id: 'froot', parentId: null }, { id: 'fa', parentId: 'froot' }, { id: 'fab', parentId: 'fa' }],
      }).expect(200);
      await admin('put', '/connections/fa__warehouse', { ...connection(role, 'second-password'), folderId: 'fa' }).expect(200);
      const where = {
        folderId: 'fab',
        name: 'where',
        kind: 'cube',
        yaml: 'cubes:\n  - name: where\n    data_source: warehouse\n    sql: SELECT current_database() AS db\n    dimensions:\n      - name: db\n        sql: db\n        type: string\n        primary_key: true\n        public: true\n',
      };
      // A cube extending it, published once and then left alone.
      const twin = { folderId: 'fab', name: 'twin', kind: 'cube', yaml: 'cubes:\n  - name: twin\n    extends: where\n' };
      // As a client does that takes what is cached and has it renewed behind (or Cube with background renewal on).
      const ask = (cube = 'fab__where') => request(server).get('/cubejs-api/v1/load')
        .query({ query: JSON.stringify({ dimensions: [`${cube}.db`], cacheMode: 'stale-while-revalidate' }) })
        .set('Authorization', jwt.sign({ wechartModel: 'dev', wechartRevision: revision }, API_SECRET));
      // The SQL Cube keys its cached results by.
      const sqlOf = async (cube: string) => (await request(server).get('/cubejs-api/v1/sql')
        .query({ query: JSON.stringify({ dimensions: [`${cube}.db`] }) })
        .set('Authorization', jwt.sign({ wechartModel: 'dev', wechartRevision: revision }, API_SECRET))
        .expect(200)).body.sql.sql[0];
      revision = (await admin('post', '/changesets', { baseRevision: revision, upserts: [where, twin] }).expect(201)).body.revision;
      expect((await ask().expect(200)).body.data[0]['fab__where.db']).toBe(target.database);
      expect((await ask('fab__twin').expect(200)).body.data[0]['fab__twin.db']).toBe(target.database);
      const [whereBefore, twinBefore] = [await sqlOf('fab__where'), await sqlOf('fab__twin')];
      let { items } = (await admin('get', '/items').expect(200)).body;
      expect(items.find((i: any) => i.fullName === 'fab__where')).toMatchObject({ kind: 'cube', dataSource: 'fa__warehouse' });
      expect(items.find((i: any) => i.fullName === 'orders')).toMatchObject({ dataSource: 'default' });

      // fab gets its own warehouse, on the other database; the cube, published again, binds to it.
      const { name: _name, ...onOther } = copy();
      await admin('put', '/connections/fab__warehouse', { ...onOther, folderId: 'fab' }).expect(200);
      revision = (await admin('post', '/changesets', { baseRevision: revision, upserts: [where] }).expect(201)).body.revision;
      // Straight after, well within Postgres's 10-second refresh key: the same query, from the new database.
      expect((await ask().expect(200)).body.data[0]['fab__where.db']).toBe(workspaceDb);
      // The twin, never published again, follows its parent onto it too: another SQL, so no cached answer of the old one's.
      expect(await sqlOf('fab__where')).not.toBe(whereBefore);
      expect(await sqlOf('fab__twin')).not.toBe(twinBefore);
      expect((await ask('fab__twin').expect(200)).body.data[0]['fab__twin.db']).toBe(workspaceDb);
      ({ items } = (await admin('get', '/items').expect(200)).body);
      expect(items.find((i: any) => i.fullName === 'fab__where').dataSource).toBe('fab__warehouse');
      // What the twin queries, and where it gets it.
      expect(items.find((i: any) => i.fullName === 'fab__twin')).toMatchObject({ dataSource: 'fab__warehouse', extends: 'fab__where' });
    });

    test('a whole-model snapshot keeps what is published as it was bound; only what it changes binds afresh (AC-273)', async () => {
      const folders = [
        { id: 'froot', parentId: null }, { id: 'fa', parentId: 'froot' }, { id: 'fab', parentId: 'fa' }, { id: 'fabc', parentId: 'fab' },
      ];
      await admin('put', '/folders', { folders }).expect(200);
      const early = { folderId: 'fabc', name: 'early', kind: 'cube', yaml: `cubes:\n  - name: early\n    data_source: warehouse\n    sql_table: ${warehouse}.orders\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n` };
      revision = (await admin('post', '/changesets', { baseRevision: revision, upserts: [early] }).expect(201)).body.revision;
      const boundOf = async (fullName: string) => (await admin('get', '/items').expect(200)).body.items.find((i: any) => i.fullName === fullName).dataSource;
      expect(await boundOf('fabc__early')).toBe('fab__warehouse');

      // A nearer warehouse comes, then the whole model is sent again as it is: nothing published moves.
      const { name: _name, ...onOther } = copy();
      await admin('put', '/connections/fabc__warehouse', { ...onOther, folderId: 'fabc' }).expect(200);
      const whole = async () => (await runtime.storeAt('dev')).items.map(({ folderId, name, kind, yaml }) => ({ folderId, name, kind, yaml }));
      const again = await admin('put', '/snapshot', { baseRevision: revision, folders, items: await whole() });
      expect([200, 201]).toContain(again.status);
      revision = again.body.revision;
      expect(await boundOf('fabc__early')).toBe('fab__warehouse');

      // Sent changed, it is resolved afresh, and binds to the nearest now.
      const changed = (await whole()).map((i) => (i.name === 'early' ? { ...i, yaml: i.yaml.replace('type: sum', 'type: max') } : i));
      revision = (await admin('put', '/snapshot', { baseRevision: revision, folders, items: changed }).expect(201)).body.revision;
      expect(await boundOf('fabc__early')).toBe('fabc__warehouse');
    });

    test('a data source changed in place is served from its new target at once, never its old one\'s cache or rollups (AC-161)', async () => {
      const sold = {
        folderId: 'fa',
        name: 'sold',
        kind: 'cube',
        yaml: 'cubes:\n  - name: sold\n    data_source: warehouse\n    sql: SELECT current_database() AS db\n    dimensions:\n      - name: db\n        sql: db\n        type: string\n        primary_key: true\n        public: true\n      - name: at\n        sql: db\n        type: string\n    measures:\n      - name: count\n        type: count\n    pre_aggregations:\n      - name: by_db\n        dimensions:\n          - CUBE.db\n        measures:\n          - CUBE.count\n',
      };
      const token = () => jwt.sign({ wechartModel: 'dev', wechartRevision: revision }, API_SECRET);
      // Served from cache while it renews: what would answer from the old target, if anything could.
      // (`at`, which the rollup doesn't hold: its query reads the source.)
      const ask = () => request(server).get('/cubejs-api/v1/load')
        .query({ query: JSON.stringify({ dimensions: ['fa__sold.at'], cacheMode: 'stale-while-revalidate' }) })
        .set('Authorization', token());
      const sqlOf = async (query: object) => (await request(server).get('/cubejs-api/v1/sql')
        .query({ query: JSON.stringify(query) })
        .set('Authorization', token())
        .expect(200)).body.sql;
      const rollupOf = async () => (await sqlOf({ measures: ['fa__sold.count'], dimensions: ['fa__sold.db'] })).preAggregations[0]?.tableName;
      const push = async (fields: object, state = 'live', name = 'fa__warehouse', folderId = 'fa') => {
        const res = await admin('put', `/connections/${name}`, {
          ...connection(role, 'second-password'), folderId, fields: { ...target, user: role, ...fields },
        }).expect(200);
        const health = await reported(name, (i) => i.version === res.body.version && i.state === state);
        expect(health.instances[0]).toMatchObject({ version: res.body.version, state });
      };

      revision = (await admin('post', '/changesets', { baseRevision: revision, upserts: [sold] }).expect(201)).body.revision;
      expect((await ask().expect(200)).body.data[0]['fa__sold.at']).toBe(target.database);
      const [sqlBefore, rollupBefore] = [(await sqlOf({ dimensions: ['fa__sold.at'] })).sql[0], await rollupOf()];
      expect(rollupBefore).toBeTruthy();
      // On the target it was first served with (its base): served as published, under its own names.
      const asPublished = () => {
        const { served, published } = runtime.servedFile('dev', 'fa__sold.yml');
        return Boolean(published) && served === published;
      };
      expect(asPublished()).toBe(true);

      // A new password, sealed again, to the same target: served as it was, nothing to rebuild.
      await push({});
      expect((await sqlOf({ dimensions: ['fa__sold.at'] })).sql[0]).toBe(sqlBefore);
      expect(await rollupOf()).toBe(rollupBefore);

      // The same data source, now on the other database: from its new target at once, however asked.
      await push({ database: workspaceDb });
      expect((await ask().expect(200)).body.data[0]['fa__sold.at']).toBe(workspaceDb);
      expect((await sqlOf({ dimensions: ['fa__sold.at'] })).sql[0]).not.toBe(sqlBefore);
      // Its rollup is another table, to be built from the new target; the old one is never read for it.
      expect(await rollupOf()).not.toBe(rollupBefore);
      expect(asPublished()).toBe(false);

      // Back again: the first target's, at once, under its own names again, and its own tables.
      await push({});
      expect((await ask().expect(200)).body.data[0]['fa__sold.at']).toBe(target.database);
      expect((await sqlOf({ dimensions: ['fa__sold.at'] })).sql[0]).toBe(sqlBefore);
      expect(await rollupOf()).toBe(rollupBefore);
      expect(asPublished()).toBe(true);

      // Two changed together: each switches.
      await Promise.all([push({ database: workspaceDb }), push({ database: target.database }, 'live', 'fab__warehouse', 'fab')]);
      expect((await ask().expect(200)).body.data[0]['fa__sold.at']).toBe(workspaceDb);
      const whereNow = await request(server).get('/cubejs-api/v1/load')
        .query({ query: JSON.stringify({ dimensions: ['fab__where.db'], cacheMode: 'stale-while-revalidate' }) })
        .set('Authorization', token())
        .expect(200);
      expect(whereNow.body.data[0]['fab__where.db']).toBe(target.database);

      // New settings that don't connect: queries fail, and never answer from the old target.
      await push({ database: `${workspaceDb}_missing` }, 'failed');
      const failing = await ask();
      expect(failing.status).not.toBe(200);
      expect(failing.body.data).toBeUndefined();
      expect(failing.body.error).toMatch(/_missing" does not exist/);
      await push({});
    });

    test('a cube keeps its names and rollup tables while its connection has the identity it was first served with; moved, it is aliased (AC-328)', async () => {
      const token = () => jwt.sign({ wechartModel: 'dev', wechartRevision: revision }, API_SECRET);
      const rollupOf = async () => (await request(server).get('/cubejs-api/v1/sql')
        .query({ query: JSON.stringify({ measures: ['orders.total'] }) })
        .set('Authorization', token())
        .expect(200)).body.sql.preAggregations[0]?.tableName as string;
      const push = async (body: object) => {
        const res = await admin('put', '/connections/default', body).expect(200);
        await reported('default', (i) => i.version === res.body.version && i.state === 'live');
      };
      const asPublished = () => {
        const { served, published } = runtime.servedFile('dev', 'orders.yml');
        return Boolean(published) && served === published;
      };
      revision = (await admin('post', '/changesets', {
        baseRevision: revision,
        upserts: [{
          folderId: 'froot',
          name: 'orders',
          kind: 'cube',
          yaml: `cubes:\n  - name: orders\n    sql_table: ${warehouse}.orders\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n    pre_aggregations:\n      - name: by_all\n        measures:\n          - CUBE.total\n`,
        }],
      }).expect(201)).body.revision;

      // The root's default was first served as the database's own user, and moved to the role since: aliased.
      await push(connection(role, 'second-password'));
      const moved = await rollupOf();
      expect(moved).not.toMatch(/\.orders_by_all/);
      expect(asPublished()).toBe(false);

      // Back on the target it was first served with: the root's cube under its own name, its own rollup table.
      await push(connection(url.username, decodeURIComponent(url.password)));
      expect(await rollupOf()).toMatch(/\.orders_by_all/);
      expect(asPublished()).toBe(true);

      // The base is recorded once, for every instance: another's first sight of it doesn't replace it.
      const { store } = await runtime.storeAt('dev');
      const [current] = await store.connections('dev').then((all) => all.filter((c) => c.name === 'default'));
      const recorded = (await store.connectionBases('dev', new Map([['default', 'another-identity']]))).get('default');
      expect(recorded).toBe(runtime.connections.identityOf(current));

      // Moved again, worked out afresh (what served it before is gone): the same alias as before, as on every instance.
      runtime.retireNow();
      await push(connection(role, 'second-password'));
      expect(await rollupOf()).toBe(moved);
      expect(asPublished()).toBe(false);
    });
  });
});
