/**
 * A model served in modules: items in two zones sharing a root cube, each
 * zone its own module, the shared cube copied and in commons. Queries go to
 * the module holding their cubes, meta is merged, and a change compiles only
 * the modules it touches. Runs when XCUBE_TEST_DATABASE_URL names a Postgres.
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

import { createConfig, XcubeRuntime, XcubeServerCore, type XcubeSettings } from '../../src';

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(120 * 1000);

const API_SECRET = 'modules-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-modules-01';

const item = (folderId: string, name: string, yaml: string, kind = 'cube') => ({ folderId, name, kind, yaml });

const customers = item('froot', 'customers', `cubes:
  - name: customers
    sql_table: main.customers
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: name
        sql: name
        type: string
    measures:
      - name: count
        type: count
`);
const orders = item('fsales', 'orders', `cubes:
  - name: orders
    sql_table: main.orders
    joins:
      - name: customers
        sql: "{CUBE}.customer_id = {customers.id}"
        relationship: many_to_one
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
    measures:
      - name: total
        sql: total_amount
        type: sum
`);
const leads = item('fmkt', 'leads', `cubes:
  - name: leads
    sql_table: main.orders
    joins:
      - name: customers
        sql: "{CUBE}.customer_id = {customers.id}"
        relationship: many_to_one
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
    measures:
      - name: count
        type: count
`);
const campaigns = item('fmkt', 'campaigns', `cubes:
  - name: campaigns
    sql: "SELECT id, id AS lead_id FROM main.orders"
    joins:
      - name: leads
        sql: "{CUBE}.lead_id = {leads.id}"
        relationship: one_to_one
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
    measures:
      - name: count
        type: count
`);

describeWithDatabase('xcube modules', () => {
  const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
  let modelDir: string;
  let driver: DuckDBDriver;
  let runtime: XcubeRuntime;
  let core: XcubeServerCore;
  let server: http.Server;
  const logs: { message: string; params: any }[] = [];

  beforeAll(async () => {
    process.env.CUBEJS_DB_TYPE = 'duckdb';
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-modules-'));
    driver = new DuckDBDriver({
      initSql: [
        'CREATE TABLE main.customers (id INTEGER PRIMARY KEY, name VARCHAR)',
        'CREATE TABLE main.orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total_amount DECIMAL(10, 2))',
        "INSERT INTO main.customers VALUES (1, 'Ada'), (2, 'Grace')",
        'INSERT INTO main.orders VALUES (1, 1, 12.5), (2, 2, 30), (3, 1, 7.5)',
      ].join('; '),
    });
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
      // Every component its own module, so the test sees them apart.
      modules: { packMin: 1, packMax: 300 },
    };
    runtime = new XcubeRuntime(settings, { logger: (message, params) => logs.push({ message, params }) });
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
  const admin = (method: 'put' | 'post' | 'get', url: string, body?: object) => {
    const r = request(server)[method](`${base}${url}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    return body ? r.send(body) : r;
  };
  const token = (revision: number) => jwt.sign({ wechartModel: 'dev', wechartRevision: revision }, API_SECRET);
  const load = (revision: number, query: object) => request(server)
    .post('/cubejs-api/v1/load').set('Authorization', token(revision)).send({ query });
  const served = (revision: number) => logs.filter((l) => l.message === 'xcube: serving revision' && l.params.revision === revision);
  /** What each publish since the last call compiled, as served. */
  let seenLogs = 0;
  const published = () => {
    const fresh = logs.slice(seenLogs);
    seenLogs = logs.length;
    return fresh.filter((l) => l.message === 'xcube: compiled a publish\'s modules as served')
      .map(({ params: { modules, compiledModules, valid } }) => ({ modules, compiledModules, valid }));
  };

  let revision = 0;

  test('each zone is a module; the cube both use is copied, and in commons', async () => {
    const res = await admin('put', '/snapshot', {
      baseRevision: null,
      folders: [{ id: 'froot', parentId: null }, { id: 'fsales', parentId: 'froot' }, { id: 'fmkt', parentId: 'froot' }],
      items: [customers, orders, leads],
    }).expect(201);
    revision = res.body.revision;

    const status = await admin('get', '/revision').expect(200);
    expect(status.body.modules.map((m: any) => [m.cubes, m.copies]).sort()).toEqual([[1, 0], [1, 1], [1, 1]]);
    expect(status.body.modules.map((m: any) => m.id)).toContain('commons');
    await load(revision, { measures: ['customers.count'] }).expect(200);
    // Compiled once, by the publish, as served: activating it compiles nothing more.
    expect(published()).toEqual([{ modules: 3, compiledModules: 3, valid: true }]);
    expect(served(revision)[0].params).toMatchObject({ modules: 3, compiledModules: 0 });
  });

  test('queries are answered from the module holding their cubes', async () => {
    const sales = await load(revision, {
      measures: ['orders.total'], dimensions: ['customers.name'], order: { 'customers.name': 'asc' },
    }).expect(200);
    expect(sales.body.data.map((r: any) => [r['customers.name'], Number(r['orders.total'])]))
      .toEqual([['Ada', 20], ['Grace', 30]]);
    const marketing = await load(revision, { measures: ['leads.count'] }).expect(200);
    expect(Number(marketing.body.data[0]['leads.count'])).toBe(3);
    const shared = await load(revision, { measures: ['customers.count'] }).expect(200);
    expect(Number(shared.body.data[0]['customers.count'])).toBe(2);
  });

  test('meta is every module\'s, merged: each cube once', async () => {
    const meta = await request(server).get('/cubejs-api/v1/meta').set('Authorization', token(revision)).expect(200);
    expect(meta.body.cubes.map((c: any) => c.name).sort()).toEqual(['customers', 'leads', 'orders']);
    const extended = await request(server).get('/cubejs-api/v1/meta?extended=true').set('Authorization', token(revision)).expect(200);
    expect(extended.body.cubes.map((c: any) => c.name).sort()).toEqual(['customers', 'leads', 'orders']);
    // Joined through the shared customers: one component, as one model would say.
    const components = new Set(meta.body.cubes.map((c: any) => c.connectedComponent));
    expect(components).toEqual(new Set([1]));
    expect(logs.some((l) => l.message.startsWith('xcube: a request names no module'))).toBe(false);
  });

  test('meta takes a scope: only some cubes, without members, as NDJSON, also by POST', async () => {
    const meta = (url: string) => request(server).get(`/cubejs-api/v1/meta${url}`).set('Authorization', token(revision));
    const one = await meta('?cubes=orders,nowhere').expect(200);
    expect(one.body.cubes.map((c: any) => c.name)).toEqual(['orders']);
    expect(one.body.cubes[0].measures.map((m: any) => m.name)).toEqual(['orders.total']);
    expect(one.headers['x-xcube-revision']).toBe(`dev@${revision}`);
    expect((await meta('?cubes=nowhere').expect(200)).body.cubes).toEqual([]);

    // A cube's own fields and its joins' targets: no members, no SQL.
    const pickers = await meta('?cubes=orders&cubes=leads&members=false').expect(200);
    expect(pickers.body.cubes.map((c: any) => c.name).sort()).toEqual(['leads', 'orders']);
    const ordersCube = pickers.body.cubes.find((c: any) => c.name === 'orders');
    expect(ordersCube).toMatchObject({ name: 'orders', type: 'cube', joins: [{ name: 'customers', relationship: 'belongsTo' }] });
    expect(Object.keys(ordersCube).sort()).toEqual(['connectedComponent', 'isVisible', 'joins', 'meta', 'name', 'public', 'title', 'type']);
    // Extended, without members: every cube field extended meta has, the joins whole.
    const extended = await meta('?extended&cubes=orders&members=false').expect(200);
    expect(extended.body.cubes[0].joins[0]).toMatchObject({ name: 'customers', relationship: 'belongsTo', sql: expect.any(String) });
    expect(extended.body.cubes[0].measures).toBeUndefined();

    const all = await meta('').expect(200);
    const lines = await meta('?format=ndjson').expect(200).expect('Content-Type', 'application/x-ndjson; charset=utf-8');
    expect(lines.text.endsWith('\n')).toBe(true);
    expect(lines.text.trimEnd().split('\n').map((l) => JSON.parse(l))).toEqual(all.body.cubes);
    expect(lines.headers['x-xcube-compiler-id']).toBe(all.body.compilerId);
    const accepted = await meta('?cubes=leads').set('Accept', 'application/x-ndjson').expect(200);
    expect(accepted.text.trimEnd().split('\n').map((l) => JSON.parse(l).name)).toEqual(['leads']);

    const posted = await request(server).post('/cubejs-api/v1/meta').set('Authorization', token(revision))
      .send({ cubes: ['customers', 'leads'], members: false }).expect(200);
    expect(posted.body.cubes.map((c: any) => c.name).sort()).toEqual(['customers', 'leads']);
    expect(posted.body.cubes.every((c: any) => c.dimensions === undefined)).toBe(true);

    // The admin meta takes the same scope.
    const own = await admin('get', '/meta?cubes=orders,leads&members=false').expect(200);
    expect(own.body.cubes.map((c: any) => [c.name, c.joins, c.measures]).sort())
      .toEqual([['leads', [{ name: 'customers', relationship: 'belongsTo' }], undefined], ['orders', [{ name: 'customers', relationship: 'belongsTo' }], undefined]]);
    const ownLines = await admin('get', '/meta?cubes=customers&format=ndjson').expect(200).expect('Content-Type', /x-ndjson/);
    expect(ownLines.text.trimEnd().split('\n').map((l) => JSON.parse(l).name)).toEqual(['customers']);
    expect((await admin('get', '/meta?extended=true&cubes=orders').expect(200)).body.cubes[0]).toMatchObject({ name: 'orders', joins: [expect.objectContaining({ sql: expect.any(String) })] });
    await admin('get', '/meta?members=maybe').expect(400);

    await meta('?members=maybe').expect(400);
    await request(server).post('/cubejs-api/v1/meta').set('Authorization', token(revision)).send({ cubes: 'orders' }).expect(400);
    await request(server).post('/cubejs-api/v1/meta').set('Authorization', token(revision)).send({ limit: 1 }).expect(400);
    await request(server).get('/cubejs-api/v1/meta?cubes=orders').expect(403);
  });

  test('a dry run\'s probe spanning modules is answered', async () => {
    const check = await admin('post', '/changesets?dryRun=true', {
      upserts: [],
      probes: [
        { id: 'span', query: { measures: ['orders.total', 'leads.count'] } },
        { id: 'one', query: { measures: ['leads.count'] } },
      ],
    }).expect(200);
    expect(check.body.probes.map((p: any) => [p.id, p.candidate.status])).toEqual([['span', 200], ['one', 200]]);
  });

  test('adding a cube compiles only its module', async () => {
    const res = await admin('post', '/changesets', { baseRevision: revision, upserts: [campaigns] }).expect(201);
    revision = res.body.revision;
    const data = await load(revision, { measures: ['campaigns.count', 'leads.count'] }).expect(200);
    expect(Number(data.body.data[0]['campaigns.count'])).toBe(3);
    expect(published()).toEqual([{ modules: 3, compiledModules: 1, valid: true }]);
    expect(served(revision)[0].params).toMatchObject({ modules: 3, compiledModules: 0 });
  });

  test('a publish that doesn\'t compile retires what it compiled; the next one compiles it afresh', async () => {
    const broken = { ...campaigns, yaml: campaigns.yaml.replace('type: count', 'type: nonsense') };
    await admin('post', '/changesets', { baseRevision: revision, upserts: [broken] }).expect(422);
    expect(published()).toEqual([{ modules: 3, compiledModules: 1, valid: false }]);
    expect(logs.slice(-5).some((l) => l.message === 'xcube: retired compiled model')).toBe(true);
    const fixed = { ...campaigns, yaml: campaigns.yaml.replace('type: count', 'type: count\n        title: Campaigns') };
    const res = await admin('post', '/changesets', { baseRevision: revision, upserts: [fixed] }).expect(201);
    revision = res.body.revision;
    expect(published()).toEqual([{ modules: 3, compiledModules: 1, valid: true }]);
    await load(revision, { measures: ['campaigns.count'] }).expect(200);
    expect(served(revision)[0].params).toMatchObject({ compiledModules: 0 });
  });

  test('a query spanning modules is answered from a union of just those modules', async () => {
    const res = await load(revision, { measures: ['orders.total', 'leads.count'] }).expect(200);
    expect(Number(res.body.data[0]['orders.total'])).toBe(50);
    expect(Number(res.body.data[0]['leads.count'])).toBe(3);
    expect(logs.filter((l) => l.message.startsWith('xcube: compiling a union')).map((l) => l.params.modules.length)).toEqual([2]);
    expect(logs.some((l) => l.message.startsWith('xcube: a request names no module'))).toBe(false);
  });
});
