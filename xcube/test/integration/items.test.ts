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

const orders = (folderId: string, extra = '') => ({
  folderId,
  name: 'orders',
  kind: 'cube',
  yaml: [
    'cubes:',
    '  - name: orders',
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

describeWithDatabase('xcube items and changesets', () => {
  const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
  let modelDir: string;
  let driver: DuckDBDriver;
  let runtime: XcubeRuntime;
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
    runtime = new XcubeRuntime(settings, { logger: () => undefined });
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

  test('a changeset adds a folder\'s own cube, published under its prefix and bound nearest-first', async () => {
    const res = await admin.post('/changesets', {
      baseRevision: 1, upserts: [orders('fsales', '      - name: big\n        sql: total_amount\n        type: max')], source: {},
    }).expect(201);
    expect(res.body).toMatchObject({ revision: 2, items: [{ folderId: 'fsales', name: 'orders', fullName: 'fsales__orders' }] });

    const data = await load({ wechartModel: 'dev', wechartRevision: 2 }, {
      measures: ['fsales__orders.total'], dimensions: ['customers.name'], order: { 'customers.name': 'asc' },
    }).expect(200);
    expect(data.body.data.map((r: any) => [r['customers.name'], Number(r['fsales__orders.total'])]))
      .toEqual([['Ada', 20], ['Grace', 30]]);

    const meta = await request(server).get('/cubejs-api/v1/meta')
      .set('Authorization', token({ wechartModel: 'dev', wechartRevision: 2 })).expect(200);
    const sales = meta.body.cubes.find((c: any) => c.name === 'fsales__orders');
    expect(sales.title).toBe('Orders');
    expect(sales.measures.map((m: any) => m.title)).toContain('Orders Big');
  });

  test('items and resolve answer with the full names each short name means', async () => {
    const items = await admin.get('/items').expect(200);
    expect(items.body).toMatchObject({ revision: 2, mode: 'items' });
    expect(items.body.items).toContainEqual({
      folderId: 'fsales',
      name: 'orders',
      kind: 'cube',
      fullName: 'fsales__orders',
      bindings: { customers: 'customers' },
    });

    const fromSales = await admin.post('/resolve', { folderId: 'fsales', names: ['orders', 'customers', 'nope'] }).expect(200);
    expect(fromSales.body.names).toEqual({ orders: 'fsales__orders', customers: 'customers', nope: null });
    const fromOps = await admin.post('/resolve', { folderId: 'fops', names: ['orders'] }).expect(200);
    expect(fromOps.body.names).toEqual({ orders: 'orders' });
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
    expect(check.body.items).toEqual([{ folderId: 'fops', name: 'returns', fullName: 'fops__returns' }]);

    const good = await admin.post('/changesets?dryRun=true', {
      upserts: [orders('fops')],
      probes: [{ id: 'p', query: { measures: ['fops__orders.count'], dimensions: ['customers.name'] } }],
    }).expect(200);
    expect(good.body).toMatchObject({ valid: true, probes: [{ id: 'p', candidate: { status: 200 } }], currentRevision: 2 });

    const status = await admin.get('/revision').expect(200);
    expect(status.body.current.revision).toBe(2);
  });

  test('refusals: a stale base, a referenced delete, an unknown folder, a file set, a folder still in use', async () => {
    await admin.post('/changesets', { baseRevision: 1, upserts: [orders('fops')] }).expect(409);

    const referenced = await admin.post('/changesets', { baseRevision: 2, deletes: [{ folderId: 'froot', name: 'customers' }] }).expect(422);
    expect(referenced.body.errors[0].message).toMatch(/can't be removed or renamed: .*froot\/orders.*fsales\/orders/);

    const nowhere = await admin.post('/changesets', { baseRevision: 2, upserts: [orders('fnowhere')] }).expect(422);
    expect(nowhere.body.errors[0]).toMatchObject({ kind: 'folder' });

    const files = await admin.put('/snapshot', { baseRevision: 2, files: [] }).expect(409);
    expect(files.body.code).toBe('mode');

    const gone = await admin.put('/folders', { folders: [{ id: 'froot', parentId: null }] }).expect(409);
    expect(gone.body).toMatchObject({ code: 'folder_in_use', folders: ['fsales'] });

    const cycle = await admin.put('/folders', { folders: [{ id: 'froot', parentId: null }, { id: 'fa', parentId: 'fb' }, { id: 'fb', parentId: 'fa' }] }).expect(400);
    expect(cycle.body.code).toBe('invalid_folders');
  });

  test('the same changeset again is a no-op, and a delete no one refers to goes', async () => {
    const again = await admin.post('/changesets', {
      baseRevision: 1, upserts: [orders('fsales', '      - name: big\n        sql: total_amount\n        type: max')],
    }).expect(200);
    expect(again.body).toMatchObject({ created: false, revision: 2 });

    const removed = await admin.post('/changesets', { baseRevision: 2, deletes: [{ folderId: 'fsales', name: 'orders' }] }).expect(201);
    expect(removed.body.revision).toBe(3);
    // Its retry, after it went in, changes nothing.
    const retried = await admin.post('/changesets', { baseRevision: 2, deletes: [{ folderId: 'fsales', name: 'orders' }] }).expect(200);
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

  test('republishing an item as it was rebinds it to a nearer namesake', async () => {
    const tree = { folders: [{ id: 'froot', parentId: null }, { id: 'fops', parentId: 'froot' }] };
    await admin.put('/folders', tree).expect(200);
    const added = await admin.post('/changesets', { baseRevision: 3, upserts: [orders('fops')] }).expect(201);
    let items = await admin.get('/items').expect(200);
    expect(items.body.items.find((i: any) => i.fullName === 'fops__orders').bindings).toEqual({ customers: 'customers' });

    const ownCustomers = { ...customers, folderId: 'fops' };
    const next = await admin.post('/changesets', { baseRevision: added.body.revision, upserts: [ownCustomers] }).expect(201);
    items = await admin.get('/items').expect(200);
    expect(items.body.items.find((i: any) => i.fullName === 'fops__orders').bindings).toEqual({ customers: 'customers' });

    const republished = await admin.post('/changesets', { baseRevision: next.body.revision, upserts: [orders('fops')] }).expect(201);
    expect(republished.body.revision).toBe(next.body.revision + 1);
    items = await admin.get('/items').expect(200);
    expect(items.body.items.find((i: any) => i.fullName === 'fops__orders').bindings).toEqual({ customers: 'fops__customers' });
  });
});
