/**
 * Folders, items and changesets end to end: a Cube core with its xcube
 * runtime on a real Postgres and a DuckDB warehouse. Runs when
 * XCUBE_TEST_DATABASE_URL names a Postgres to use.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { Client } from 'pg';
import { DuckDBDriver } from '@cubejs-backend/duckdb-driver';

import { createConfig, itemsHash, XcubeRuntime, XcubeServerCore, type XcubeSettings } from '../../src';

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(120 * 1000);

const API_SECRET = 'items-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-items-0123';

const customers = {
  folderId: 'froot',
  name: 'customers',
  kind: 'cube',
  yaml: [
    'cubes:',
    '  - name: customers',
    '    sql_table: main.customers',
    '    dimensions:',
    '      - name: id',
    '        sql: id',
    '        type: number',
    '        primary_key: true',
    '      - name: name',
    '        sql: name',
    '        type: string',
    '',
  ].join('\n'),
};

const orders = (folderId: string, extra = '', name = 'orders') => ({
  folderId,
  name,
  kind: 'cube',
  yaml: [
    'cubes:',
    `  - name: ${name}`,
    '    sql_table: main.orders',
    '    joins:',
    '      - name: customers',
    '        sql: "{CUBE}.customer_id = {customers.id}"',
    '        relationship: many_to_one',
    '    dimensions:',
    '      - name: id',
    '        sql: id',
    '        type: number',
    '        primary_key: true',
    '    measures:',
    '      - name: count',
    '        type: count',
    '      - name: total',
    '        sql: total_amount',
    '        type: sum',
    extra,
    '',
  ].filter((line) => line !== '').join('\n'),
});

const folders = [
  { id: 'froot', parentId: null },
  { id: 'fsales', parentId: 'froot' },
  { id: 'fops', parentId: 'froot' },
];

// Widens what the runtime keeps protected: the items as their authors wrote them, as published now.
class TestRuntime extends XcubeRuntime {
  public async authored(model: string) {
    const head = await this.requireStore().head(model);
    return (await this.itemsAt(head!)).map(({ folderId, name, kind, yaml }) => ({ folderId, name, kind, yaml }));
  }
}

describeWithDatabase('xcube items and changesets', () => {
  const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
  let modelDir: string;
  let driver: DuckDBDriver;
  let runtime: TestRuntime;
  let core: XcubeServerCore;
  let server: http.Server;

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
    modules: { packMin: 50, packMax: 300 },
  };

  beforeAll(async () => {
    process.env.CUBEJS_DB_TYPE = 'duckdb';
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-items-'));
    driver = new DuckDBDriver({
      initSql: [
        'CREATE TABLE main.customers (id INTEGER PRIMARY KEY, name VARCHAR)',
        'CREATE TABLE main.orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total_amount DECIMAL(10, 2))',
        "INSERT INTO main.customers VALUES (1, 'Ada'), (2, 'Grace')",
        'INSERT INTO main.orders VALUES (1, 1, 12.5), (2, 2, 30), (3, 1, 7.5)',
      ].join('; '),
    });
    runtime = new TestRuntime(settings, { logger: () => undefined });
    await runtime.start();
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    core = new XcubeServerCore(createConfig(runtime, { modelClaim: 'wechartModel', revisionClaim: 'wechartRevision' }, {
      apiSecret: API_SECRET,
      driverFactory: () => driver,
      schemaPath: path.relative(process.cwd(), modelDir),
      cacheAndQueueDriver: 'memory',
      devServer: false,
      telemetry: false,
      logger: () => undefined,
    }) as any);
    process.env.NODE_ENV = nodeEnv;
    await runtime.attach(core);
    const app = express();
    await core.initApp(app);
    server = app.listen(0);
  });

  afterAll(async () => {
    server?.close();
    await runtime?.stop();
    await core?.shutdown();
    await driver?.release();
    delete process.env.CUBEJS_DB_TYPE;
    fs.rmSync(modelDir, { recursive: true, force: true });
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  const base = '/cubejs-api/v1/semantic/models/dev';
  const admin = {
    put: (url: string, body: object) => request(server).put(`${base}${url}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body),
    post: (url: string, body: object) => request(server).post(`${base}${url}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body),
    get: (url: string) => request(server).get(`${base}${url}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`),
  };
  const token = (claims: object) => jwt.sign(claims, API_SECRET);
  const load = (claims: object, query: object) => request(server)
    .post('/cubejs-api/v1/load').set('Authorization', token(claims)).send({ query });

  test('an items snapshot publishes the root as today: bare names, same titles', async () => {
    const res = await admin.put('/snapshot', {
      baseRevision: null, folders, items: [customers, orders('froot')], source: { reason: 'startup' },
    }).expect(201);
    expect(res.body).toMatchObject({ revision: 1, created: true, itemsHash: itemsHash([customers, orders('froot')] as any) });

    const meta = await request(server).get('/cubejs-api/v1/meta')
      .set('Authorization', token({ wechartModel: 'dev', wechartRevision: 1 })).expect(200);
    const names = meta.body.cubes.map((c: any) => [c.name, c.title]).sort();
    expect(names).toEqual([['customers', 'Customers'], ['orders', 'Orders']]);
    const ordersMeta = meta.body.cubes.find((c: any) => c.name === 'orders');
    expect(ordersMeta.meta).toEqual({ xcube: { folderId: 'froot', shortName: 'orders' } });
  });

  test('the revision and refresh-worker routes say whether this instance answers the model in rollup-only mode', async () => {
    expect((await admin.get('/revision').expect(200)).body.rollupOnly).toBe(false);
    expect((await admin.get('/refresh-worker').expect(200)).body.rollupOnly).toBe(false);
    process.env.CUBEJS_ROLLUP_ONLY = 'true';
    try {
      expect((await admin.get('/revision').expect(200)).body.rollupOnly).toBe(true);
      expect((await admin.get('/refresh-worker').expect(200)).body.rollupOnly).toBe(true);
    } finally {
      delete process.env.CUBEJS_ROLLUP_ONLY;
    }
    expect((await admin.get('/revision').expect(200)).body.rollupOnly).toBe(false);
  });

  const big = (folderId = 'fsales') => orders(folderId, '      - name: big\n        sql: total_amount\n        type: max', 'big_orders');

  test('a changeset adds a folder\'s cube under its own name, referring up its path', async () => {
    const res = await admin.post('/changesets', { baseRevision: 1, upserts: [big()], source: {} }).expect(201);
    expect(res.body).toMatchObject({ revision: 2, items: [{ folderId: 'fsales', name: 'big_orders', fullName: 'big_orders' }] });

    const data = await load({ wechartModel: 'dev', wechartRevision: 2 }, {
      measures: ['big_orders.total'], dimensions: ['customers.name'], order: { 'customers.name': 'asc' },
    }).expect(200);
    expect(data.body.data.map((r: any) => [r['customers.name'], Number(r['big_orders.total'])]))
      .toEqual([['Ada', 20], ['Grace', 30]]);

    const meta = await request(server).get('/cubejs-api/v1/meta')
      .set('Authorization', token({ wechartModel: 'dev', wechartRevision: 2 })).expect(200);
    const sales = meta.body.cubes.find((c: any) => c.name === 'big_orders');
    expect(sales.title).toBe('Big Orders');
    expect(sales.meta).toEqual({ xcube: { folderId: 'fsales', shortName: 'big_orders' } });
    expect(sales.measures.map((m: any) => m.title)).toContain('Big Orders Big');
  });

  test('items answer with bare names; resolve with the item holding each name, in any case, from any folder', async () => {
    const items = await admin.get('/items').expect(200);
    expect(items.body).toMatchObject({ revision: 2, mode: 'items' });
    expect(items.body.items).toContainEqual({
      folderId: 'fsales',
      name: 'big_orders',
      kind: 'cube',
      fullName: 'big_orders',
      bindings: { customers: 'customers' },
      dataSource: 'default',
    });

    const fromSales = await admin.post('/resolve', { folderId: 'fsales', names: ['big_orders', 'Customers', 'nope'] }).expect(200);
    expect(fromSales.body.names).toEqual({ big_orders: 'big_orders', Customers: 'customers', nope: null });
    const fromOps = await admin.post('/resolve', { folderId: 'fops', names: ['BIG_ORDERS'] }).expect(200);
    expect(fromOps.body.names).toEqual({ BIG_ORDERS: 'big_orders' });
  });

  test('a dry run checks a changeset and places Cube\'s errors on the item', async () => {
    const broken = {
      folderId: 'fops',
      name: 'returns',
      kind: 'cube',
      yaml: 'cubes:\n  - name: returns\n    sql_table: main.orders\n    measures:\n      - name: count\n        type: nope\n',
    };
    const check = await admin.post('/changesets?dryRun=true', { upserts: [broken] }).expect(200);
    expect(check.body.valid).toBe(false);
    expect(check.body.errors[0]).toMatchObject({ folderId: 'fops', name: 'returns', kind: 'compile' });
    expect(check.body.items).toEqual([{
      folderId: 'fops', name: 'returns', fullName: 'returns', bindings: {}, dataSource: 'default',
    }]);

    const good = await admin.post('/changesets?dryRun=true', {
      upserts: [orders('fops', '', 'ops_orders')],
      probes: [{ id: 'p', query: { measures: ['ops_orders.count'], dimensions: ['customers.name'] } }],
    }).expect(200);
    expect(good.body).toMatchObject({ valid: true, probes: [{ id: 'p', candidate: { status: 200 } }], currentRevision: 2 });
    expect(good.body.items).toEqual([expect.objectContaining({
      folderId: 'fops', name: 'ops_orders', fullName: 'ops_orders', bindings: expect.objectContaining({ customers: 'customers' }),
    })]);

    const status = await admin.get('/revision').expect(200);
    expect(status.body.current.revision).toBe(2);
  });

  test('refusals: a stale base, a referenced delete, an unknown folder, a file set, a folder still in use', async () => {
    await admin.post('/changesets', { baseRevision: 1, upserts: [orders('fops', '', 'ops_orders')] }).expect(409);

    const referenced = await admin.post('/changesets', { baseRevision: 2, deletes: [{ folderId: 'froot', name: 'customers' }] }).expect(422);
    expect(referenced.body.errors[0].message).toBe('customers can\'t be removed: big_orders, orders refer to it');

    const nowhere = await admin.post('/changesets', { baseRevision: 2, upserts: [orders('fnowhere', '', 'nowhere')] }).expect(422);
    expect(nowhere.body.errors[0]).toMatchObject({ kind: 'folder' });

    const files = await admin.put('/snapshot', { baseRevision: 2, files: [] }).expect(409);
    expect(files.body.code).toBe('mode');

    const gone = await admin.put('/folders', { folders: [{ id: 'froot', parentId: null }] }).expect(409);
    expect(gone.body).toMatchObject({ code: 'folder_in_use', folders: ['fsales'] });

    const cycle = await admin.put('/folders', { folders: [{ id: 'froot', parentId: null }, { id: 'fa', parentId: 'fb' }, { id: 'fb', parentId: 'fa' }] }).expect(400);
    expect(cycle.body.code).toBe('invalid_folders');
  });

  test('a name in use, in any case, is refused, naming the caller\'s item and never where the other is (R71 2.3)', async () => {
    const clash = await admin.post('/changesets', { baseRevision: 2, upserts: [orders('fops', '', 'Big_Orders')] }).expect(422);
    expect(clash.body).toMatchObject({
      code: 'invalid_items',
      errors: [{ folderId: 'fops', name: 'Big_Orders', kind: 'name_in_use', message: 'The name "Big_Orders" is already in use' }],
    });
    expect(JSON.stringify(clash.body)).not.toMatch(/fsales/);
    // A dry run says the same.
    const dry = await admin.post('/changesets?dryRun=true', { upserts: [orders('fops', '', 'BIG_ORDERS')] }).expect(200);
    expect(dry.body).toMatchObject({ valid: false, errors: [{ kind: 'name_in_use' }] });
  });

  test('a reference off the referrer\'s folder path is refused, naming the referrer only (R72)', async () => {
    const offPath = {
      folderId: 'fops',
      name: 'ops_stats',
      kind: 'cube',
      yaml: 'cubes:\n  - name: ops_stats\n    sql_table: main.orders\n    measures:\n      - name: biggest\n        sql: "{big_orders.big}"\n        type: number\n',
    };
    const refused = await admin.post('/changesets', { baseRevision: 2, upserts: [offPath] }).expect(422);
    expect(refused.body.errors).toEqual([{
      folderId: 'fops', name: 'ops_stats', kind: 'reference_range', message: 'It refers to "big_orders", which isn\'t in its folder or one of its ancestors',
    }]);
    expect(JSON.stringify(refused.body)).not.toMatch(/fsales/);
  });

  test('the same changeset again is a no-op, and a delete no one refers to goes', async () => {
    const again = await admin.post('/changesets', { baseRevision: 1, upserts: [big()] }).expect(200);
    expect(again.body).toMatchObject({ created: false, revision: 2 });

    const removed = await admin.post('/changesets', { baseRevision: 2, deletes: [{ folderId: 'fsales', name: 'big_orders' }] }).expect(201);
    expect(removed.body.revision).toBe(3);
    // Its retry, after it went in, changes nothing.
    const retried = await admin.post('/changesets', { baseRevision: 2, deletes: [{ folderId: 'fsales', name: 'big_orders' }] }).expect(200);
    expect(retried.body).toMatchObject({ created: false, revision: 3 });
    // A stale base is a conflict, even when the changeset is invalid too: the client rebases first.
    const invalid = { folderId: 'fops', name: 'broken', kind: 'cube', yaml: 'cubes:\n  - name: broken\n   bad: [\n' };
    const stale = await admin.post('/changesets', { baseRevision: 2, upserts: [invalid] }).expect(409);
    expect(stale.body).toMatchObject({ code: 'conflict', currentRevision: 3 });
    const items = await admin.get('/items').expect(200);
    expect(items.body.items.map((i: any) => i.fullName).sort()).toEqual(['customers', 'orders']);

    // The folder is empty now, so it may go.
    await admin.put('/folders', { folders: [{ id: 'froot', parentId: null }, { id: 'fops', parentId: 'froot' }] }).expect(200);
  });

  test('a move in one changeset is the same item: what refers to it keeps it (R71 2.7)', async () => {
    const summary = { folderId: 'fops', name: 'summary', kind: 'view', yaml: 'views:\n  - name: summary\n    cubes:\n      - join_path: orders\n        includes: [count]\n' };
    const withView = await admin.post('/changesets', { baseRevision: 3, upserts: [summary] }).expect(201);
    const moved = await admin.post('/changesets', {
      baseRevision: withView.body.revision, deletes: [{ folderId: 'froot', name: 'orders' }], upserts: [orders('fops')],
    }).expect(201);
    const { items } = (await admin.get('/items').expect(200)).body;
    expect(items.find((i: any) => i.name === 'orders')).toMatchObject({ folderId: 'fops', fullName: 'orders' });
    expect(items.find((i: any) => i.name === 'summary').bindings).toEqual({ orders: 'orders' });
    const data = await load({ wechartModel: 'dev', wechartRevision: moved.body.revision }, { measures: ['summary.count'] }).expect(200);
    expect(Number(data.body.data[0]['summary.count'])).toBe(3);
  });

  test('two publishes racing for one new name: the first to land wins, the other is refused on its retry (R71 2.4)', async () => {
    const head = (await admin.get('/revision').expect(200)).body.current.revision;
    const returns = (folderId: string) => ({ folderId, name: 'returns', kind: 'cube', yaml: 'cubes:\n  - name: returns\n    sql_table: main.orders\n    measures:\n      - name: count\n        type: count\n' });
    const raced = await Promise.all([
      admin.post('/changesets', { baseRevision: head, upserts: [returns('froot')] }),
      admin.post('/changesets', { baseRevision: head, upserts: [returns('fops')] }),
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = raced.find((r) => r.status === 409)!;
    const lost = raced.indexOf(loser) === 0 ? 'froot' : 'fops';
    const retry = await admin.post('/changesets', { baseRevision: loser.body.currentRevision, upserts: [returns(lost)] }).expect(422);
    expect(retry.body.errors).toEqual([{ folderId: lost, name: 'returns', kind: 'name_in_use', message: 'The name "returns" is already in use' }]);
    const items = (await admin.get('/items').expect(200)).body.items.filter((i: any) => i.name === 'returns');
    expect(items).toHaveLength(1);
  });

  test('a folder push that would strand a reference is refused, naming the referrer (R72)', async () => {
    const tree = [{ id: 'froot', parentId: null }, { id: 'fops', parentId: 'froot' }, { id: 'fsub', parentId: 'fops' }, { id: 'fside', parentId: 'froot' }];
    await admin.put('/folders', { folders: tree }).expect(200);
    const head = (await admin.get('/revision').expect(200)).body.current.revision;
    const sub = { folderId: 'fsub', name: 'sub_stats', kind: 'cube', yaml: 'cubes:\n  - name: sub_stats\n    sql_table: main.orders\n    measures:\n      - name: n\n        sql: "{orders.count}"\n        type: number\n' };
    await admin.post('/changesets', { baseRevision: head, upserts: [sub] }).expect(201);
    // fsub under fside: sub_stats would lose orders, in fops.
    const stranded = await admin.put('/folders', { folders: tree.map((f) => (f.id === 'fsub' ? { ...f, parentId: 'fside' } : f)) }).expect(409);
    expect(stranded.body).toEqual({
      error: 'The folder tree would leave items using what isn\'t in their folder or one of its ancestors', code: 'reference_range', cubes: [], items: ['sub_stats'],
    });
    // Under the root, fops is no ancestor of it either.
    await admin.put('/folders', { folders: tree.map((f) => (f.id === 'fsub' ? { ...f, parentId: 'froot' } : f)) }).expect(409);
    // Nothing moved.
    expect((await admin.put('/folders', { folders: tree }).expect(200)).body).toMatchObject({ model: 'dev' });
  });

  test('a whole-model snapshot sent as it is changes nothing; one that moves an item lands it where it is sent', async () => {
    const tree = { folders: [{ id: 'froot', parentId: null }, { id: 'fops', parentId: 'froot' }, { id: 'fsub', parentId: 'fops' }, { id: 'fside', parentId: 'froot' }] };
    let head = (await admin.get('/revision').expect(200)).body.current.revision;
    const all = await runtime.authored('dev');
    const same = await admin.put('/snapshot', { baseRevision: head, ...tree, items: all }).expect(200);
    expect(same.body.created).toBe(false);
    // orders back to the root: still up every referrer's path.
    const moved = all.map((i) => (i.name === 'orders' ? { ...i, folderId: 'froot' } : i));
    head = (await admin.put('/snapshot', { baseRevision: head, ...tree, items: moved }).expect(201)).body.revision;
    expect((await admin.get('/items').expect(200)).body.items.find((i: any) => i.name === 'orders').folderId).toBe('froot');
  });

  test('a whole snapshot whose tree drops folders deletes the items it holds there, and the folders go', async () => {
    const head = (await admin.get('/revision').expect(200)).body.current.revision;
    const root = (await runtime.authored('dev')).filter((i) => i.folderId === 'froot');
    const before = (await admin.get('/items').expect(200)).body.items.map((i: any) => i.folderId);
    expect(before).toContain('fops');
    const res = await admin.put('/snapshot', { baseRevision: head, folders: [{ id: 'froot', parentId: null }], items: root }).expect(201);
    const after = (await admin.get('/items').expect(200)).body.items;
    expect(new Set(after.map((i: any) => i.folderId))).toEqual(new Set(['froot']));
    // The tree is the snapshot's: sending it again changes nothing; a folder may be added again.
    await admin.put('/folders', { folders: [{ id: 'froot', parentId: null }, { id: 'fnew', parentId: 'froot' }] }).expect(200);
    // An item sent in a folder its tree lacks is still refused.
    const lacking = await admin.put('/snapshot', {
      baseRevision: res.body.revision, folders: [{ id: 'froot', parentId: null }], items: [...root, orders('fgone', '', 'gone_orders')],
    }).expect(422);
    expect(lacking.body.errors[0]).toMatchObject({ folderId: 'fgone', kind: 'folder' });
  });
});
