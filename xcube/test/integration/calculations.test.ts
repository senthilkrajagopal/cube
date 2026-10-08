/**
 * Quick calculations, end to end: a query's `calculations` asked of a model
 * served on Cube's environment (the test database), each companion compiled
 * on the first request for it and served from then on. Runs when
 * XCUBE_TEST_DATABASE_URL names a database.
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

import { createConfig, XcubeRuntime, XcubeServerCore, type XcubeSettings } from '../../src';
import { modelSchema } from '../../src/config';
import type { CalcSet } from '../../src/runtime/runtime';
import type { ModelHead } from '../../src/store/revisions';

// Widens what the runtime keeps protected: a calculation whose served model doesn't compile.
class TestRuntime extends XcubeRuntime {
  public poisoned: string | null = null;

  protected override residentsOf(head: Pick<ModelHead, 'model' | 'generation' | 'revision'>, key: string, data: any, identities: ReadonlyMap<string, string>, calcs?: CalcSet) {
    const served = super.residentsOf(head, key, data, identities, calcs);
    if (this.poisoned && calcs?.specs.some((spec) => spec.kind === this.poisoned)) {
      for (const resident of served.modules.values()) {
        resident.files = resident.files.map((f) => (f.path === 'orders.yml' ? { ...f, content: 'cubes:\n  - name: orders\n    sql: 1 +\n    measures: [{ name: x, type: nope }]\n' } : f));
      }
    }
    return served;
  }
}

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(180 * 1000);

const API_SECRET = 'calculations-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-calculations';

describeWithDatabase('quick calculations: companions asked for by a query, compiled on first use', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const schema = `xcube_t_${suffix}`;
  const warehouse = `calc_w_${suffix}`;
  const model = `calcs_${suffix}`;
  const url = new URL(DATABASE_URL ?? 'postgres://x@localhost/x');
  const environment: Record<string, string> = {
    CUBEJS_DB_TYPE: 'postgres',
    CUBEJS_DB_HOST: url.hostname,
    CUBEJS_DB_PORT: url.port || '5432',
    CUBEJS_DB_NAME: url.pathname.slice(1),
    CUBEJS_DB_USER: decodeURIComponent(url.username),
    CUBEJS_DB_PASS: decodeURIComponent(url.password),
  };
  const logs: { message: string; params: any }[] = [];
  let modelDir: string;
  let runtime: TestRuntime;
  let core: XcubeServerCore;
  let server: http.Server;
  let revision = 0;

  const sql = async (text: string) => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      return (await client.query(text)).rows;
    } finally {
      await client.end();
    }
  };

  const orders = `cubes:
  - name: orders
    sql_table: ${warehouse}.orders
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: category
        sql: category
        type: string
      - name: created_at
        sql: created_at
        type: time
    measures:
      - name: count
        type: count
      - name: total
        sql: amount
        type: sum
      - name: avg_amount
        sql: amount
        type: avg
      - name: customers
        sql: customer
        type: count_distinct
      - name: ratio
        sql: "{total} / NULLIF({count}, 0)"
        type: number
    pre_aggregations:
      - name: daily
        external: false
        measures:
          - CUBE.count
          - CUBE.total
        dimensions:
          - CUBE.category
        time_dimension: CUBE.created_at
        granularity: day
`;
  const deals = `cubes:
  - name: deals
    sql_table: ${warehouse}.orders
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: category
        sql: category
        type: string
    measures:
      - name: count
        type: count
`;
  const salesView = `views:
  - name: sales_view
    cubes:
      - join_path: orders
        includes:
          - category
          - count
          - name: total
            alias: revenue
`;
  const items = [
    { folderId: 'froot', name: 'orders', kind: 'cube', yaml: orders },
    { folderId: 'froot', name: 'sales_view', kind: 'view', yaml: salesView },
    { folderId: 'fsales', name: 'deals', kind: 'cube', yaml: deals },
  ];

  function admin(method: 'put' | 'get' | 'post', route: string, body?: object) {
    const req = request(server)[method](`/cubejs-api/v1/semantic/models/${model}${route}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    return body ? req.send(body) : req;
  }
  beforeAll(async () => {
    await sql(`CREATE SCHEMA ${warehouse};
      CREATE TABLE ${warehouse}.orders AS
        SELECT i AS id, d::timestamp AS created_at, (ARRAY['a','b','c'])[1 + i % 3] AS category,
               (i * 7) % 100 AS amount, i / 15 AS customer
          FROM generate_series('2024-01-01'::date, '2024-06-30'::date, interval '1 day') WITH ORDINALITY AS g(d, i);
      CREATE SCHEMA IF NOT EXISTS ${modelSchema('prod_pre_aggregations', model)};`);
    Object.assign(process.env, environment);
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-calculations-'));
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
    };
    runtime = new TestRuntime(settings, { logger: (message: string, params: any) => logs.push({ message, params }) });
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
      orchestratorOptions: { preAggregationsOptions: { externalRefresh: false } },
    });
    core = new XcubeServerCore(options);
    process.env.NODE_ENV = nodeEnv;
    await runtime.attach(core);
    const app = express();
    app.use(bodyParser.json({ limit: '50mb' }));
    await core.initApp(app);
    server = app.listen(0);

    revision = (await admin('put', '/snapshot', {
      baseRevision: null, folders: [{ id: 'froot', parentId: null }, { id: 'fsales', parentId: 'froot' }], items,
    }).expect(201)).body.revision;
  });

  afterAll(async () => {
    server?.close();
    await runtime?.stop();
    await core?.shutdown();
    Object.keys(environment).forEach((name) => delete process.env[name]);
    fs.rmSync(modelDir, { recursive: true, force: true });
    await sql(`DROP SCHEMA IF EXISTS ${warehouse} CASCADE; DROP SCHEMA IF EXISTS ${modelSchema('prod_pre_aggregations', model)} CASCADE;`)
      .catch(() => undefined);
  });

  const token = () => jwt.sign({ wechartModel: model, wechartRevision: revision }, API_SECRET);
  const load = (query: object) => request(server).post('/cubejs-api/v1/load').set('Authorization', token()).send({ query });
  const month = (range?: string[]) => ({ dimension: 'orders.created_at', granularity: 'month', ...(range ? { dateRange: range } : {}) });
  const byMonth = (rows: any[], member: string) => Object.fromEntries(rows.map((r) => [r['orders.created_at.month'].slice(0, 7), r[member]]));
  const compiledFor = () => logs.filter((l) => l.message === 'xcube: served with new quick calculations');

  test('the first query asking for a calculation compiles its companion once; the next is served at once', async () => {
    const query = {
      measures: ['orders.count'],
      timeDimensions: [month(['2024-03-01', '2024-06-30'])],
      calculations: [{ measure: 'orders.count', kind: 'running_total' }],
    };
    const first = await load(query).expect(200);
    expect(compiledFor()).toHaveLength(1);
    expect(compiledFor()[0].params).toMatchObject({ model, calculations: ['orders.count:running_total'] });
    // From the range's start, not the data's.
    expect(byMonth(first.body.data, 'orders.count__xc_running_total')).toEqual({ '2024-03': '31', '2024-04': '61', '2024-05': '92', '2024-06': '122' });
    // The answer names the calculation its column stands for.
    expect(first.body.annotation.measures['orders.count__xc_running_total']).toMatchObject({
      shortTitle: 'Count (running total)',
      meta: { xcube: { calculation: { measure: 'count', kind: 'running_total', granularity: 'month' } } },
    });
    await load(query).expect(200);
    expect(compiledFor()).toHaveLength(1);
    // Without a range, from the start of the data.
    const unbounded = await load({ ...query, timeDimensions: [month()] }).expect(200);
    expect(byMonth(unbounded.body.data, 'orders.count__xc_running_total')['2024-03']).toBe('91');
  });

  test('each calculation answers as a multi-stage measure would', async () => {
    const full = ['2024-01-01', '2024-06-30'];
    const monthly = async (measure: string, kind: string, extra: object = {}) => {
      const res = await load({ measures: [measure], timeDimensions: [month(full)], calculations: [{ measure, kind, ...extra }] }).expect(200);
      const [column] = Object.keys(res.body.annotation.measures);
      return byMonth(res.body.data, column);
    };
    const totals = await sql(`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS m, sum(amount)::int AS t
      FROM ${warehouse}.orders GROUP BY 1 ORDER BY 1`);
    const t = totals.map((r) => r.t);
    const months = totals.map((r) => r.m);
    // January has no previous month: no value, so no row.
    const previous = await monthly('orders.total', 'previous_period');
    expect(months.slice(1).map((m) => Number(previous[m]))).toEqual(t.slice(0, 5));
    expect(previous['2024-01'] ?? null).toBeNull();
    const difference = await monthly('orders.total', 'difference');
    expect(months.slice(1).map((m) => Number(difference[m]))).toEqual(t.slice(1).map((v, i) => v - t[i]));
    expect(Number((await monthly('orders.total', 'pct_difference'))['2024-02'])).toBeCloseTo((t[1] - t[0]) / t[0], 6);
    // The mean of the last 3 months' totals.
    expect(Number((await monthly('orders.total', 'moving_average', { periods: 3 }))['2024-03'])).toBeCloseTo((t[0] + t[1] + t[2]) / 3, 6);
    // Distinct customers so far, not a sum of each month's.
    expect(Object.values(await monthly('orders.customers', 'running_total'))).toEqual(['3', '5', '7', '9', '11', '13']);

    const shares = await load({
      measures: ['orders.total'], dimensions: ['orders.category'], calculations: [{ measure: 'orders.total', kind: 'pct_of_total' }],
    }).expect(200);
    const sum = shares.body.data.reduce((acc: number, r: any) => acc + Number(r['orders.total__xc_pct_of_total']), 0);
    expect(sum).toBeCloseTo(1, 6);
    // Rank across all rows, the largest total first. An order on the measure is on its calculation, as it replaces it.
    const ranked = await load({
      measures: ['orders.total'],
      dimensions: ['orders.category'],
      calculations: [{ measure: 'orders.total', kind: 'rank' }],
      order: { 'orders.total': 'asc' },
    }).expect(200);
    expect(ranked.body.data.map((r: any) => r['orders.total__xc_rank'])).toEqual(['1', '2', '3']);
    const byTotal = await sql(`SELECT category FROM ${warehouse}.orders GROUP BY 1 ORDER BY sum(amount) DESC`);
    expect(ranked.body.data.map((r: any) => r['orders.category'])).toEqual(byTotal.map((r) => r.category));
  });

  test('through a view, under its alias; and on a folder\'s cube', async () => {
    const viewed = await load({
      measures: ['sales_view.revenue'], dimensions: ['sales_view.category'], calculations: [{ measure: 'sales_view.revenue', kind: 'pct_of_total' }],
    }).expect(200);
    expect(Object.keys(viewed.body.data[0])).toContain('sales_view.revenue__xc_pct_of_total');
    const folder = await load({
      measures: ['deals.count'], dimensions: ['deals.category'], calculations: [{ measure: 'deals.count', kind: 'rank' }],
    }).expect(200);
    // Two categories tie: competition ranking.
    expect(folder.body.data.map((r: any) => r['deals.count__xc_rank']).sort()).toEqual(['1', '1', '3']);
  });

  test('what can\'t be computed is refused 400, each with its reason', async () => {
    const refused = async (query: object) => {
      const res = await load(query).expect(400);
      expect(res.body.code).toBe('invalid_calculation');
      return res.body.calculations.map((c: any) => [c.measure, c.kind, c.reason]);
    };
    const withMonth = { timeDimensions: [month(['2024-01-01', '2024-06-30'])] };
    expect(await refused({ measures: ['orders.count'], calculations: [{ measure: 'orders.count', kind: 'median' }] }))
      .toEqual([['orders.count', 'median', 'kind']]);
    expect(await refused({ measures: ['orders.count'], calculations: [{ measure: 'orders.total', kind: 'rank' }] }))
      .toEqual([['orders.total', 'rank', 'not_in_query']]);
    expect(await refused({ measures: ['orders.count'], calculations: [{ measure: 'orders.count', kind: 'rank' }, { measure: 'orders.count', kind: 'pct_of_total' }] }))
      .toEqual([['orders.count', 'pct_of_total', 'duplicate']]);
    expect(await refused({ measures: ['orders.nope'], calculations: [{ measure: 'orders.nope', kind: 'rank' }] }))
      .toEqual([['orders.nope', 'rank', 'unknown_measure']]);
    expect(await refused({ measures: ['orders.avg_amount'], ...withMonth, calculations: [{ measure: 'orders.avg_amount', kind: 'running_total' }] }))
      .toEqual([['orders.avg_amount', 'running_total', 'type']]);
    expect(await refused({ measures: ['orders.ratio'], calculations: [{ measure: 'orders.ratio', kind: 'pct_of_total' }] }))
      .toEqual([['orders.ratio', 'pct_of_total', 'type']]);
    expect(await refused({ measures: ['orders.count'], calculations: [{ measure: 'orders.count', kind: 'previous_period' }] }))
      .toEqual([['orders.count', 'previous_period', 'granularity']]);
    expect(await refused({ measures: ['orders.count'], ...withMonth, calculations: [{ measure: 'orders.count', kind: 'moving_average', periods: 4 }] }))
      .toEqual([['orders.count', 'moving_average', 'periods']]);
    expect(await refused({
      measures: ['orders.count', 'orders.total'],
      ...withMonth,
      calculations: [{ measure: 'orders.count', kind: 'running_total' }, { measure: 'orders.total', kind: 'moving_average', periods: 3 }],
    })).toEqual([['orders.total', 'moving_average', 'combination']]);
  });

  test('companions are never listed, and no authored member may take their mark', async () => {
    const names = (body: any) => body.cubes.flatMap((c: any) => c.measures.map((m: any) => m.name));
    const meta = await request(server).get('/cubejs-api/v1/meta').set('Authorization', token()).expect(200);
    expect(names(meta.body).some((n: string) => n.includes('__xc_'))).toBe(false);
    expect(names(meta.body)).toContain('orders.count');
    const own = await admin('get', '/meta?extended=true&hidden=true').expect(200);
    expect(names(own.body).some((n: string) => n.includes('__xc_'))).toBe(false);

    const marked = await admin('post', '/changesets', {
      baseRevision: revision,
      upserts: [{ folderId: 'froot', name: 'sneaky', kind: 'cube', yaml: 'cubes:\n  - name: sneaky\n    sql: SELECT 1 AS id\n    measures:\n      - name: count__xc_rank\n        type: count\n' }],
    }).expect(422);
    expect(JSON.stringify(marked.body)).toContain('__xc_');
  });

  test('a calculation the model can\'t be compiled with is refused and forgotten, the model served as it was', async () => {
    runtime.poisoned = 'pct_difference';
    const res = await load({
      measures: ['orders.total'],
      timeDimensions: [{ dimension: 'orders.created_at', granularity: 'week', dateRange: ['2024-01-01', '2024-06-30'] }],
      calculations: [{ measure: 'orders.total', kind: 'pct_difference' }],
    }).expect(400);
    expect(res.body.calculations).toEqual([expect.objectContaining({ measure: 'orders.total', kind: 'pct_difference', reason: 'compile' })]);
    runtime.poisoned = null;
    const rows = await sql(`SELECT kind FROM ${schema}.calculations WHERE model = '${model}' AND kind = 'pct_difference' AND granularity = 'week'`);
    expect(rows).toEqual([]);
    // Everything asked for before is still served, and the model isn't reported failed.
    await load({ measures: ['orders.count'], dimensions: ['orders.category'], calculations: [{ measure: 'orders.count', kind: 'rank' }] }).expect(200);
    const status = (await admin('get', '/revision').expect(200)).body;
    expect(status.instance).toMatchObject({ state: 'active', revision });
  });

  test('a new revision is served with the calculations asked for before; and a moving average reads the rollup', async () => {
    const before = compiledFor().length;
    revision = (await admin('post', '/changesets', {
      baseRevision: revision,
      upserts: [{ folderId: 'fsales', name: 'more', kind: 'cube', yaml: `cubes:\n  - name: more\n    sql_table: ${warehouse}.orders\n    measures:\n      - name: count\n        type: count\n` }],
    }).expect(201)).body.revision;
    const again = await load({
      measures: ['orders.count'], timeDimensions: [month(['2024-03-01', '2024-06-30'])], calculations: [{ measure: 'orders.count', kind: 'running_total' }],
    }).expect(200);
    expect(again.body.data).toHaveLength(4);
    expect(compiledFor()).toHaveLength(before);

    const plan = await request(server).get('/cubejs-api/v1/sql')
      .query({ query: JSON.stringify({ measures: ['orders.total'], timeDimensions: [month(['2024-01-01', '2024-06-30'])], calculations: [{ measure: 'orders.total', kind: 'moving_average', periods: 3 }] }) })
      .set('Authorization', token())
      .expect(200);
    expect(plan.body.sql.preAggregations.length).toBeGreaterThan(0);
  });
});
