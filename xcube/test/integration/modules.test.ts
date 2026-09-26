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
    expect(served(revision)[0].params).toMatchObject({ modules: 3, compiledModules: 3 });
  });

  test('queries are answered from the module holding their cubes', async () => {
    const sales = await load(revision, {
      measures: ['fsales__orders.total'], dimensions: ['customers.name'], order: { 'customers.name': 'asc' },
    }).expect(200);
    expect(sales.body.data.map((r: any) => [r['customers.name'], Number(r['fsales__orders.total'])]))
      .toEqual([['Ada', 20], ['Grace', 30]]);
    const marketing = await load(revision, { measures: ['fmkt__leads.count'] }).expect(200);
    expect(Number(marketing.body.data[0]['fmkt__leads.count'])).toBe(3);
    const shared = await load(revision, { measures: ['customers.count'] }).expect(200);
    expect(Number(shared.body.data[0]['customers.count'])).toBe(2);
  });

  test('meta is every module\'s, merged: each cube once', async () => {
    const meta = await request(server).get('/cubejs-api/v1/meta').set('Authorization', token(revision)).expect(200);
    expect(meta.body.cubes.map((c: any) => c.name).sort()).toEqual(['customers', 'fmkt__leads', 'fsales__orders']);
    const extended = await request(server).get('/cubejs-api/v1/meta?extended=true').set('Authorization', token(revision)).expect(200);
    expect(extended.body.cubes.map((c: any) => c.name).sort()).toEqual(['customers', 'fmkt__leads', 'fsales__orders']);
    // Joined through the shared customers: one component, as one model would say.
    const components = new Set(meta.body.cubes.map((c: any) => c.connectedComponent));
    expect(components).toEqual(new Set([1]));
    expect(logs.some((l) => l.message.startsWith('xcube: a request names no module'))).toBe(false);
  });

  test('a dry run\'s probe spanning modules is answered', async () => {
    const check = await admin('post', '/changesets?dryRun=true', {
      upserts: [],
      probes: [
        { id: 'span', query: { measures: ['fsales__orders.total', 'fmkt__leads.count'] } },
        { id: 'one', query: { measures: ['fmkt__leads.count'] } },
      ],
    }).expect(200);
    expect(check.body.probes.map((p: any) => [p.id, p.candidate.status])).toEqual([['span', 200], ['one', 200]]);
  });

  test('adding a cube compiles only its module', async () => {
    const res = await admin('post', '/changesets', { baseRevision: revision, upserts: [campaigns] }).expect(201);
    revision = res.body.revision;
    const data = await load(revision, { measures: ['fmkt__campaigns.count', 'fmkt__leads.count'] }).expect(200);
    expect(Number(data.body.data[0]['fmkt__campaigns.count'])).toBe(3);
    expect(served(revision)[0].params).toMatchObject({ modules: 3, compiledModules: 1 });
  });

  test('a query spanning modules is answered from a union of just those modules', async () => {
    const res = await load(revision, { measures: ['fsales__orders.total', 'fmkt__leads.count'] }).expect(200);
    expect(Number(res.body.data[0]['fsales__orders.total'])).toBe(50);
    expect(Number(res.body.data[0]['fmkt__leads.count'])).toBe(3);
    expect(logs.filter((l) => l.message.startsWith('xcube: compiling a union')).map((l) => l.params.modules.length)).toEqual([2]);
    expect(logs.some((l) => l.message.startsWith('xcube: a request names no module'))).toBe(false);
  });
});
