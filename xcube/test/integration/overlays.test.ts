/**
 * Slice 5 end to end, in one Cube process over Postgres and DuckDB: a
 * workspace's items pushed as an overlay and previewed by queries whose
 * token names it, over whatever is published now. Runs when
 * XCUBE_TEST_DATABASE_URL names a Postgres.
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
import { DuckDBDriver } from '@cubejs-backend/duckdb-driver';

import { createConfig, DEFAULT_OVERLAYS, XcubeRuntime, XcubeServerCore, type XcubeSettings } from '../../src';

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(180 * 1000);

const API_SECRET = 'overlays-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-overlays-1';

const ordersYaml = (extra = '') => `cubes:
  - name: orders
    sql_table: main.orders
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: region
        sql: region
        type: string
      - name: created_at
        sql: created_at
        type: time
    measures:
      - name: count
        type: count
${extra}    pre_aggregations:
      - name: main
        external: false
        measures: [count]
        time_dimension: created_at
        granularity: day
`;

const plainCube = (name: string, table: string) => `cubes:
  - name: ${name}
    sql_table: ${table}
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
    measures:
      - name: count
        type: count
`;

const reportYaml = `cubes:
  - name: report
    sql_table: main.orders
    joins:
      - name: widgets
        sql: "{CUBE}.id = {widgets.id}"
        relationship: many_to_one
      - name: customers
        sql: "{CUBE}.id = {customers.id}"
        relationship: many_to_one
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
    measures:
      - name: count
        type: count
`;

const overrideYaml = (extra = '') => `cubes:
  - name: orders_x
    extends: base_orders
${extra ? `    measures:\n${extra}` : ''}`;

const viewYaml = `views:
  - name: v_orders
    cubes:
      - join_path: orders
        includes:
          - count
          - region
`;

describeWithDatabase('overlays: previews of unpublished items', () => {
  const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
  let modelDir: string;
  let driver: DuckDBDriver;
  let runtime: XcubeRuntime;
  let core: XcubeServerCore;
  let server: http.Server;

  beforeAll(async () => {
    process.env.CUBEJS_DB_TYPE = 'duckdb';
    process.env.CUBEJS_PRE_AGGREGATIONS_BUILDER = 'true';
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-overlays-'));
    driver = new DuckDBDriver({
      initSql: [
        'CREATE TABLE main.orders (id INTEGER PRIMARY KEY, region VARCHAR, amount INTEGER, created_at TIMESTAMP)',
        "INSERT INTO main.orders VALUES (1, 'eu', 10, TIMESTAMP '2026-01-02 10:00:00'), (2, 'us', 20, TIMESTAMP '2026-01-03 10:00:00'), (3, 'eu', 30, TIMESTAMP '2026-01-03 11:00:00')",
        'CREATE TABLE main.widgets (id INTEGER PRIMARY KEY)',
        'INSERT INTO main.widgets VALUES (1), (2)',
        'CREATE TABLE main.customers (id INTEGER PRIMARY KEY)',
        'INSERT INTO main.customers VALUES (1), (2), (3)',
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
      modules: { packMin: 1, packMax: 300 },
      overlays: { ...DEFAULT_OVERLAYS, max: 6 },
    };
    runtime = new XcubeRuntime(settings, { logger: () => undefined });
    await runtime.start();
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    core = new XcubeServerCore(createConfig(runtime, {
      modelClaim: 'wechartModel', revisionClaim: 'wechartRevision', overlayClaim: 'wechartOverlay',
    }, {
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
    app.use(bodyParser.json({ limit: '50mb' }));
    await core.initApp(app);
    server = app.listen(0);
  });

  afterAll(async () => {
    server?.close();
    await runtime?.stop();
    await core?.shutdown();
    await driver?.release();
    delete process.env.CUBEJS_DB_TYPE;
    delete process.env.CUBEJS_PRE_AGGREGATIONS_BUILDER;
    fs.rmSync(modelDir, { recursive: true, force: true });
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  let revision = 0;
  const base = '/cubejs-api/v1/semantic/models/dev';
  const admin = (method: 'put' | 'post' | 'get' | 'delete', url: string, body?: object) => {
    const req = request(server)[method](`${base}${url}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    return body ? req.send(body) : req;
  };
  const token = (overlay?: string) => jwt.sign({ wechartModel: 'dev', wechartRevision: revision, ...(overlay ? { wechartOverlay: overlay } : {}) }, API_SECRET);
  const load = (query: object, overlay?: string) => request(server).get('/cubejs-api/v1/load')
    .query({ query: JSON.stringify(query) })
    .set('Authorization', token(overlay));
  const valueOf = async (query: object, overlay: string | undefined, member: string) => {
    const res = await load(query, overlay);
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 200, error: undefined });
    return Number(res.body.data[0][member]);
  };
  const workspace = {
    upserts: [
      { folderId: 'fa', name: 'orders', kind: 'cube', yaml: ordersYaml('      - name: total\n        sql: amount\n        type: sum\n') },
      { folderId: 'fb', name: 'report', kind: 'cube', yaml: reportYaml },
      // A copy from fc, which isn't on fb's path: the report's `widgets` means it, as it is in the workspace.
      { folderId: 'fc', name: 'widgets', kind: 'cube', yaml: plainCube('widgets', 'main.widgets') },
    ],
    deletes: [],
  };

  test('publishes the model the overlay goes over', async () => {
    const res = await admin('put', '/snapshot', {
      baseRevision: null,
      folders: [
        { id: 'froot', parentId: null }, { id: 'fa', parentId: 'froot' }, { id: 'fb', parentId: 'froot' }, { id: 'fc', parentId: 'froot' },
      ],
      items: [
        { folderId: 'fa', name: 'orders', kind: 'cube', yaml: ordersYaml() },
        { folderId: 'fa', name: 'v_orders', kind: 'view', yaml: viewYaml },
        { folderId: 'fc', name: 'widgets', kind: 'cube', yaml: plainCube('widgets', 'main.widgets') },
        { folderId: 'froot', name: 'customers', kind: 'cube', yaml: plainCube('customers', 'main.customers') },
        { folderId: 'froot', name: 'unrelated', kind: 'cube', yaml: plainCube('unrelated', 'main.widgets') },
        // An override: fa's orders_x extends the root's base_orders, and inherits its rollup.
        { folderId: 'froot', name: 'base_orders', kind: 'cube', yaml: ordersYaml().replace('name: orders', 'name: base_orders') },
        { folderId: 'fa', name: 'orders_x', kind: 'cube', yaml: overrideYaml() },
      ],
    }).expect(201);
    revision = res.body.revision;
  });

  test('an overlay is pushed once it applies to what is published and compiles', async () => {
    const res = await admin('put', '/overlays/ws1', workspace).expect(201);
    expect(res.body).toMatchObject({ model: 'dev', id: 'ws1', version: 1, created: true, revision });
    expect(res.body.items.map((i: any) => i.fullName).sort()).toEqual(['fa__orders', 'fb__report', 'fc__widgets']);
    const status = await admin('get', '/overlays/ws1').expect(200);
    expect(status.body).toMatchObject({ id: 'ws1', version: 1, validatedRevision: revision, instance: { state: 'idle' } });
  });

  test('a query whose token names the overlay is answered from it; others from what is published', async () => {
    const res = await load({ measures: ['fa__orders.total'] }, 'ws1');
    expect(res.status).toBe(200);
    expect(res.headers['x-xcube-overlay']).toBe('ws1@1');
    expect(Number(res.body.data[0]['fa__orders.total'])).toBe(60);
    expect((await load({ measures: ['fa__orders.total'] })).status).toBe(400);
    const names = async (overlay?: string) => (await request(server).get('/cubejs-api/v1/meta')
      .set('Authorization', token(overlay)).expect(200)).body.cubes.map((c: any) => c.name).sort();
    const published = ['base_orders', 'customers', 'fa__orders', 'fa__orders_x', 'fa__v_orders', 'fc__widgets', 'unrelated'];
    expect(await names('ws1')).toEqual([...published, 'fb__report'].sort());
    expect(await names()).toEqual(published);
  });

  test('only the modules an overlay changes are compiled; the rest are the published ones', async () => {
    await admin('put', '/overlays/small', {
      upserts: [{ folderId: 'fa', name: 'orders', kind: 'cube', yaml: ordersYaml('      - name: note\n        sql: id\n        type: max\n') }],
    }).expect(201);
    const compiled = [...(core as any).compilerCache.keys()];
    expect(await valueOf({ measures: ['fa__orders.note'] }, 'small', 'fa__orders.note')).toBe(3);
    const served = [...(runtime as any).served.values()];
    const overlay = served.find((r: any) => r.overlay?.id === 'small');
    const published = served.find((r: any) => r.key === overlay.overlay.base);
    const own = [...overlay.modules.values()].filter((r: any) => published.modules.get(r.moduleId) !== r);
    expect(overlay.modules.size).toBe(published.modules.size);
    // The module holding orders and its view; the others are the published revision's, compiled once.
    expect(own.map((r: any) => r.files.map((f: any) => f.path).sort())).toEqual([['fa__orders.yml', 'fa__v_orders.yml']]);
    expect([...(core as any).compilerCache.keys()].filter((k) => !compiled.includes(k))).toEqual([own[0].appId]);
    await admin('delete', '/overlays/small').expect(204);
  });

  test('names resolve in the overlay first, then along the item\'s folder path (AC-281)', async () => {
    expect(await valueOf({ measures: ['fb__report.count', 'fc__widgets.count'] }, 'ws1', 'fc__widgets.count')).toBe(2);
    const resolved = await admin('post', '/resolve', { folderId: 'fb', names: ['widgets', 'orders', 'customers', 'nothing'], overlay: 'ws1' }).expect(200);
    expect(resolved.body.names).toEqual({ widgets: 'fc__widgets', orders: 'fa__orders', customers: 'customers', nothing: null });
    const plain = await admin('post', '/resolve', { folderId: 'fb', names: ['widgets', 'customers'] }).expect(200);
    expect(plain.body.names).toEqual({ widgets: null, customers: 'customers' });
  });

  test('previews read the source for what the overlay changes, never an unbuilt rollup', async () => {
    const sqlOf = async (overlay?: string) => (await request(server).get('/cubejs-api/v1/sql')
      .query({ query: JSON.stringify({ measures: ['fa__orders.count'], timeDimensions: [{ dimension: 'fa__orders.created_at', granularity: 'day' }] }) })
      .set('Authorization', token(overlay))
      .expect(200)).body.sql;
    expect((await sqlOf()).preAggregations).toHaveLength(1);
    expect((await sqlOf('ws1')).preAggregations).toHaveLength(0);
    // The view over the changed cube is reached too.
    expect(await valueOf({ measures: ['fa__v_orders.count'] }, 'ws1', 'fa__v_orders.count')).toBe(3);
  });

  test('the same push again changes nothing but its expiry; one that doesn\'t compile is refused, and the last good one stays', async () => {
    const before = (await admin('get', '/overlays/ws1').expect(200)).body.expiresAt;
    const again = await admin('put', '/overlays/ws1', { ...workspace, ttlSeconds: 2 * 24 * 3600 }).expect(200);
    expect(again.body).toMatchObject({ version: 1, created: false });
    expect(again.body.expiresAt > before).toBe(true);

    const broken = await admin('put', '/overlays/ws1', {
      ...workspace,
      upserts: [...workspace.upserts, { folderId: 'fb', name: 'gadgets', kind: 'cube', yaml: `cubes:\n  - name: gadgets\n    sql_table: main.widgets\n    joins:\n      - name: nowhere\n        sql: "{CUBE}.id = {nowhere.id}"\n        relationship: many_to_one\n` }],
    }).expect(422);
    expect(broken.body.code).toBe('invalid_items');
    expect(broken.body.errors[0]).toMatchObject({ folderId: 'fb', name: 'gadgets' });
    expect(await valueOf({ measures: ['fa__orders.total'] }, 'ws1', 'fa__orders.total')).toBe(60);
  });

  test('an overlay is applied to whatever is published now; a publish it no longer applies to breaks it', async () => {
    const added = await admin('post', '/changesets', {
      baseRevision: revision,
      upserts: [{ folderId: 'froot', name: 'extra', kind: 'cube', yaml: plainCube('extra', 'main.customers') }],
    }).expect(201);
    revision = added.body.revision;
    const res = await load({ measures: ['fa__orders.total'] }, 'ws1');
    expect(res.headers['x-xcube-revision']).toBe(`dev@${revision}`);
    expect(Number(res.body.data[0]['fa__orders.total'])).toBe(60);
    expect(await valueOf({ measures: ['extra.count'] }, 'ws1', 'extra.count')).toBe(3);

    // Nothing published refers to customers, so it may go; the overlay's report joins it.
    const dropped = await admin('post', '/changesets', { baseRevision: revision, deletes: [{ folderId: 'froot', name: 'customers' }] }).expect(201);
    revision = dropped.body.revision;
    const refused = await load({ measures: ['fa__orders.total'] }, 'ws1');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Overlay "ws1" doesn't apply to what is published now: fb\/report/);
    const status = await admin('get', '/overlays/ws1').expect(200);
    expect(status.body.instance).toMatchObject({ revision, state: 'broken' });
    expect(status.body.instance.errors[0]).toMatchObject({ folderId: 'fb', name: 'report' });
  });

  test('an override\'s preview doesn\'t inherit a rollup it can\'t use; what the overlay doesn\'t reach keeps its own', async () => {
    await admin('put', '/overlays/ovr', {
      upserts: [{ folderId: 'fa', name: 'orders_x', kind: 'cube', yaml: overrideYaml('      - name: total\n        sql: amount\n        type: sum\n') }],
    }).expect(201);
    const rollups = async (cube: string, overlay?: string) => (await request(server).get('/cubejs-api/v1/sql')
      .query({ query: JSON.stringify({ measures: [`${cube}.count`], timeDimensions: [{ dimension: `${cube}.created_at`, granularity: 'day' }] }) })
      .set('Authorization', token(overlay))
      .expect(200)).body.sql.preAggregations.length;
    expect(await rollups('fa__orders_x')).toBe(1);
    expect(await rollups('fa__orders_x', 'ovr')).toBe(0);
    expect(await rollups('fa__orders', 'ovr')).toBe(1);
    await admin('delete', '/overlays/ovr').expect(204);
  });

  test('queries arriving together on a new overlay all wait for one build, and all are answered from it', async () => {
    await admin('put', '/overlays/burst', {
      upserts: [{ folderId: 'fa', name: 'orders', kind: 'cube', yaml: ordersYaml('      - name: burst\n        sql: amount\n        type: max\n') }],
    }).expect(201);
    const answers = await Promise.all(Array.from({ length: 6 }, () => load({ measures: ['fa__orders.burst'] }, 'burst')));
    expect(answers.map((a) => [a.status, Number(a.body.data?.[0]?.['fa__orders.burst'])])).toEqual(Array(6).fill([200, 30]));
    await admin('delete', '/overlays/burst').expect(204);
  });

  test('a push over a stale baseVersion is refused; the limit on overlays holds', async () => {
    const first = await admin('put', '/overlays/pv', { upserts: [], baseVersion: null }).expect(201);
    await admin('put', '/overlays/pv', { upserts: [], baseVersion: null }).expect(409);
    const stale = await admin('put', '/overlays/pv', {
      upserts: [{ folderId: 'froot', name: 'unrelated', kind: 'cube', yaml: plainCube('unrelated', 'main.customers') }],
      baseVersion: first.body.version + 1000,
    }).expect(409);
    expect(stale.body).toMatchObject({ code: 'conflict', currentVersion: first.body.version });
    await admin('put', '/overlays/pv', { upserts: [], baseVersion: first.body.version }).expect(200);
    const made: string[] = [];
    let refused: any;
    for (let i = 0; i < 10 && !refused; i++) {
      const res = await admin('put', `/overlays/lim${i}`, { upserts: [] });
      if (res.status === 409) {
        refused = res.body;
      } else {
        made.push(`lim${i}`);
      }
    }
    expect(refused?.code).toBe('too_many_overlays');
    await Promise.all([...made, 'pv'].map((id) => admin('delete', `/overlays/${id}`).expect(204)));
  });

  test('a dropped id pushed again with other items is served those, never what was dropped (AC-323)', async () => {
    const first = await admin('put', '/overlays/again', {
      upserts: [{ folderId: 'fa', name: 'orders', kind: 'cube', yaml: ordersYaml('      - name: again\n        sql: amount\n        type: min\n') }],
    }).expect(201);
    expect(await valueOf({ measures: ['fa__orders.again'] }, 'again', 'fa__orders.again')).toBe(10);
    await admin('delete', '/overlays/again').expect(204);
    const second = await admin('put', '/overlays/again', {
      upserts: [{ folderId: 'fa', name: 'orders', kind: 'cube', yaml: ordersYaml('      - name: again\n        sql: amount\n        type: max\n') }],
    }).expect(201);
    expect(second.body.version).toBeGreaterThan(first.body.version);
    expect(await valueOf({ measures: ['fa__orders.again'] }, 'again', 'fa__orders.again')).toBe(30);
    await admin('delete', '/overlays/again').expect(204);
  });

  test('a dropped or expired overlay is gone; an unknown one never was', async () => {
    await admin('delete', '/overlays/ws1').expect(204);
    await admin('delete', '/overlays/ws1').expect(204);
    expect((await load({ measures: ['fa__orders.count'] }, 'ws1')).status).toBe(410);
    await admin('get', '/overlays/ws1').expect(404);
    expect((await load({ measures: ['fa__orders.count'] }, 'nope')).status).toBe(410);

    await admin('put', '/overlays/ws2', {
      upserts: [{ folderId: 'fa', name: 'orders', kind: 'cube', yaml: ordersYaml() }], ttlSeconds: 1,
    }).expect(201);
    expect(await valueOf({ measures: ['fa__orders.count'] }, 'ws2', 'fa__orders.count')).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect((await load({ measures: ['fa__orders.count'] }, 'ws2')).status).toBe(410);
    expect((await load({ measures: ['fa__orders.count'] }, 'bad id!')).status).toBe(403);
  });
});
