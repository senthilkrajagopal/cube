/**
 * Row-sets (`POST /v1/row-set`), end to end, on wechart's engine (a stand-in
 * over an in-process DuckDB): what an engine computes from a row-set and its
 * measures' SQL is what Cube answers on /v1/load, fan-out included; access
 * policies are applied as on /v1/load, and their row-set comes apart from the
 * query's; what can't be aggregated over rows is refused with its reason.
 * Runs when XCUBE_TEST_DATABASE_URL names a Postgres, for xcube's store.
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
import { ENGINE_TOKEN, standInEngine } from './engine-stand-in';

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(180 * 1000);

const API_SECRET = 'rowset-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-rowset-01';

const TABLES = [
  `CREATE TABLE main.t_orders AS SELECT * FROM (VALUES
    (1, 'east', 'ann', 10.0, TIMESTAMP '2024-01-15 10:00:00'),
    (2, 'east', 'bob', 4.0, TIMESTAMP '2024-02-03 00:00:00'),
    (3, 'west', 'ann', 7.0, TIMESTAMP '2024-02-20 12:00:00'),
    (4, 'west', 'cid', 2.0, TIMESTAMP '2024-03-01 08:00:00')
  ) AS t(c_id, c_region, c_customer, c_amount, c_ts)`,
  // Order 1 has three items, 2 one, 3 two, 4 none: a join to items repeats an order's row.
  `CREATE TABLE main.t_items AS SELECT * FROM (VALUES
    (11, 1, 'a', 1), (12, 1, 'b', 2), (13, 1, 'a', 3),
    (21, 2, 'a', 5),
    (31, 3, 'b', 1), (32, 3, 'a', 1)
  ) AS t(c_id, c_order, c_sku, c_qty)`,
];

const MODEL = `cubes:
  - name: orders
    sql_table: main.t_orders
    joins:
      - name: items
        relationship: one_to_many
        sql: "{CUBE}.c_id = {items}.c_order"
    dimensions:
      - { name: id, sql: c_id, type: number, primary_key: true }
      - { name: region, sql: c_region, type: string }
      - { name: at, sql: c_ts, type: time }
    measures:
      - { name: count, type: count }
      - { name: total, sql: c_amount, type: sum }
      - { name: biggest, sql: c_amount, type: max }
      - { name: mean, sql: c_amount, type: avg }
      - { name: customers, sql: c_customer, type: count_distinct }
      - name: big
        type: count
        sql: c_id
        filters: [{ sql: "{CUBE}.c_amount > 5" }]
      - { name: per_order, sql: "{total} / {count}", type: number }
      - name: trailing
        sql: c_amount
        type: sum
        rolling_window: { trailing: 1 month }
    access_policy:
      - group: g_east
        row_level:
          filters:
            - { member: region, operator: equals, values: [east] }
      - group: g_all
  - name: items
    sql_table: main.t_items
    dimensions:
      - { name: id, sql: c_id, type: number, primary_key: true }
      - { name: sku, sql: c_sku, type: string }
    measures:
      - { name: qty, sql: c_qty, type: sum }
    access_policy:
      - group: g_east
      - group: g_all
  - name: loose
    sql: SELECT 1 AS c_x
    dimensions:
      - { name: x, sql: c_x, type: number }
    measures:
      - { name: count, type: count }
`;

const VIEW = `views:
  - name: sales
    cubes:
      - join_path: orders
        includes: [id, region, total, count, per_order]
      - join_path: orders.items
        prefix: true
        includes: [id, sku, qty]
`;

describeWithDatabase('row-sets', () => {
  const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
  const allowHttp = process.env.XCUBE_ENGINE_ALLOW_HTTP;
  let engine: Awaited<ReturnType<typeof standInEngine>>;
  let keysDir: string;
  let modelDir: string;
  let runtime: XcubeRuntime;
  let core: XcubeServerCore;
  let server: http.Server;
  let revision: number;

  beforeAll(async () => {
    process.env.XCUBE_ENGINE_ALLOW_HTTP = 'true';
    engine = await standInEngine(TABLES);
    keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-credential-keys-'));
    const key = generateCredentialKey();
    fs.writeFileSync(path.join(keysDir, `${key.kid}.pem`), key.pem);
    fs.writeFileSync(path.join(keysDir, `${key.kid}.check`), key.check);
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-rowset-'));
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

    const admin = (method: 'put' | 'post', route: string, body: object) => request(server)[method](`/cubejs-api/v1/semantic/models/dev${route}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(body);
    const fields = { baseUrl: engine.url };
    await admin('put', '/connections/default', {
      baseVersion: null,
      folderId: 'froot',
      driver: 'engine',
      authMethod: 'service-token',
      fields,
      sealed: { token: sealSecretV1(key.jwk.x, key.kid, 'engine', 'token', fields, ENGINE_TOKEN) },
    }).expect(200);
    const published = await admin('put', '/snapshot', {
      baseRevision: null,
      folders: [{ id: 'froot', parentId: null }],
      items: MODEL.split(/\n(?= {2}- name: )/).slice(1).map((cube) => ({
        folderId: 'froot', name: /name: (\w+)/.exec(cube)![1], kind: 'cube', yaml: `cubes:\n${cube}\n`,
      })).concat([{ folderId: 'froot', name: 'sales', kind: 'view', yaml: VIEW }]),
    });
    expect({ status: published.status, body: published.status === 201 ? undefined : published.body }).toEqual({ status: 201, body: undefined });
    revision = published.body.revision;
  });

  afterAll(async () => {
    server?.close();
    await runtime?.stop();
    await core?.shutdown();
    await engine?.close();
    fs.rmSync(modelDir, { recursive: true, force: true });
    fs.rmSync(keysDir, { recursive: true, force: true });
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
    if (allowHttp === undefined) {
      delete process.env.XCUBE_ENGINE_ALLOW_HTTP;
    } else {
      process.env.XCUBE_ENGINE_ALLOW_HTTP = allowHttp;
    }
  });

  const token = (groups: string[]) => jwt.sign({ wechartModel: 'dev', wechartRevision: revision, groups }, API_SECRET);
  const rowSet = (query: object, groups = ['g_all']) => request(server).post('/cubejs-api/v1/row-set')
    .set('Authorization', token(groups))
    .send({ query });
  const load = async (query: object, groups = ['g_all']) => {
    const answer = await request(server).post('/cubejs-api/v1/load').set('Authorization', token(groups)).send({ query });
    expect({ status: answer.status, error: answer.body.error }).toEqual({ status: 200, error: undefined });
    return answer.body.data as Record<string, unknown>[];
  };
  /** Runs on the engine's DuckDB. */
  const run = async (sql: string, params: unknown[] = []) => {
    const reader = await engine.connection.runAndReadAll(sql, params as any);
    return reader.getRowObjectsJS() as Record<string, unknown>[];
  };
  const quote = (alias: string) => `"${alias}"`;

  /**
   * What an engine computes from a row-set, grouped by `by` (members): each
   * measure's leaves aggregated over their rows (each key once where a leaf
   * is multiplied), then the measure over its leaves.
   */
  async function computeOver(answer: any, by: string[]) {
    const { rowSet: rows, aliasToMember, measures } = answer;
    const aliasOf = Object.fromEntries(Object.entries<string>(aliasToMember).map(([alias, member]) => [member, alias]));
    const groupCols = by.map((m) => quote(aliasOf[m]));
    const result = new Map<string, Record<string, number>>();
    for (const [member, measure] of Object.entries<any>(measures)) {
      const leafValues = new Map<string, Record<string, unknown>>();
      for (const leaf of measure.leaves) {
        const source = leaf.multiplied
          ? `(SELECT DISTINCT ON (${[...groupCols, ...leaf.key.map(quote)].join(', ')}) * FROM (${rows.sql}) AS r)`
          : `(${rows.sql})`;
        const sql = `SELECT ${[...groupCols, `${leaf.sql} AS ${quote(leaf.alias)}`].join(', ')} FROM ${source} AS s${groupCols.length ? ` GROUP BY ${groupCols.map((_c, i) => i + 1).join(', ')}` : ''}`;
        for (const row of await run(sql, rows.params)) {
          const group = JSON.stringify(by.map((m) => row[aliasOf[m]]));
          leafValues.set(group, { ...leafValues.get(group), [leaf.alias]: row[leaf.alias] });
        }
      }
      for (const [group, values] of leafValues) {
        const select = Object.entries(values).map(([alias, v]) => `${v === null ? 'NULL' : Number(v)}::DOUBLE AS ${quote(alias)}`).join(', ');
        const [{ v }] = await run(`SELECT ${measure.overLeaves} AS v FROM (SELECT ${select}) AS l`);
        result.set(group, { ...result.get(group), [member]: v === null ? NaN : Number(v) });
      }
    }
    return result;
  }

  /** Cube's own answer, keyed as `computeOver`'s. */
  const byGroup = (rows: Record<string, unknown>[], by: string[], measures: string[]) => new Map(rows.map((row) => [
    JSON.stringify(by.map((m) => row[m])),
    Object.fromEntries(measures.map((m) => [m, Number(row[m])])),
  ]));

  test('a row-set holds the rows ungrouped, unordered and unlimited, with every joined cube\'s keys', async () => {
    const answer = await rowSet({ measures: ['orders.total'], dimensions: ['orders.region', 'items.sku'] }).expect(200);
    const { sql, params } = answer.body.rowSet;
    expect(sql).not.toMatch(/\bGROUP BY\b|\bORDER BY\b|\bLIMIT\b/i);
    expect(answer.body.dialect).toBe('duckdb');
    expect(answer.body.keys).toEqual({ orders: ['orders__id'], items: ['items__id'] });
    expect(answer.body.aliasToMember).toEqual({
      orders__region: 'orders.region', items__sku: 'items.sku', orders__id: 'orders.id', items__id: 'items.id', orders__total: 'orders.total',
    });
    expect(answer.body).not.toHaveProperty('policyRowSet');
    expect(answer.body.security).toEqual({ denied: false, masked: [] });
    // One row per joined row: 6 items, and order 4 with none.
    expect(await run(sql, params)).toHaveLength(7);
  });

  test('its measures computed over it are Cube\'s answer, a fan-out\'s repeated rows counted once', async () => {
    const measures = ['orders.count', 'orders.total', 'orders.biggest', 'orders.mean', 'orders.customers', 'orders.big', 'orders.per_order', 'items.qty'];
    const query = {
      measures,
      dimensions: ['orders.region'],
      filters: [{ member: 'items.sku', operator: 'equals', values: ['a'] }],
    };
    const answer = await rowSet(query).expect(200);
    const { measures: compiled } = answer.body;
    expect(compiled['orders.total']).toMatchObject({ multiplied: true, key: ['orders__id'] });
    expect(compiled['orders.count']).toMatchObject({ multiplied: false });
    expect(compiled['orders.customers'].sql).toMatch(/count\(distinct/i);
    expect(compiled['items.qty']).toMatchObject({ multiplied: false, sql: 'sum("items__qty")' });
    expect(compiled['orders.per_order'].leaves.map((l: any) => l.member)).toEqual(['orders.total', 'orders.count']);
    const computed = await computeOver(answer.body, ['orders.region']);
    const cube = byGroup(await load(query), ['orders.region'], measures);
    expect(computed).toEqual(cube);
  });

  test('with a time dimension and its date range', async () => {
    const query = {
      measures: ['orders.total', 'items.qty'],
      timeDimensions: [{ dimension: 'orders.at', granularity: 'month', dateRange: ['2024-01-01', '2024-02-29'] }],
    };
    const answer = await rowSet(query).expect(200);
    expect(answer.body.aliasToMember.orders__at_month).toBe('orders.at.month');
    const computed = await computeOver(answer.body, ['orders.at.month']);
    const rows = (await load(query)).map((r) => ({ ...r, 'orders.at.month': `${String(r['orders.at.month']).slice(0, 23)}Z` }));
    const cube = byGroup(rows, ['orders.at.month'], ['orders.total', 'items.qty']);
    expect(new Map([...computed].map(([k, v]) => [JSON.stringify(JSON.parse(k).map((d: any) => new Date(d).toISOString())), v])))
      .toEqual(new Map([...cube].map(([k, v]) => [JSON.stringify(JSON.parse(k).map((d: any) => new Date(d).toISOString())), v])));
  });

  test('a policy\'s rows come apart from the query\'s: the same columns and keys, the query\'s among them', async () => {
    const query = {
      measures: ['orders.total'],
      dimensions: ['orders.region'],
      filters: [{ member: 'items.sku', operator: 'equals', values: ['a'] }],
    };
    const answer = await rowSet(query, ['g_east']).expect(200);
    const { rowSet: rows, policyRowSet: policy, aliasToMember } = answer.body;
    expect(policy).toBeDefined();
    const policyRows = await run(policy.sql, policy.params);
    const queryRows = await run(rows.sql, rows.params);
    expect(Object.keys(policyRows[0]).sort()).toEqual(Object.keys(aliasToMember).sort());
    expect(new Set(policyRows.map((r) => r.orders__region))).toEqual(new Set(['east']));
    // The policy's rows hold every item of the east orders; the query's, those of sku a.
    expect(policyRows).toHaveLength(4);
    expect(queryRows).toHaveLength(3);
    const keyOf = (r: Record<string, unknown>) => `${r.orders__id}/${r.items__id}`;
    const inPolicy = new Set(policyRows.map(keyOf));
    expect(queryRows.every((r) => inPolicy.has(keyOf(r)))).toBe(true);
    // As Cube answers it.
    const computed = await computeOver(answer.body, ['orders.region']);
    expect(computed).toEqual(byGroup(await load(query, ['g_east']), ['orders.region'], ['orders.total']));
  });

  test('through a view, its keys and leaves are the view\'s own members', async () => {
    const query = { measures: ['sales.total', 'sales.items_qty', 'sales.per_order'], dimensions: ['sales.region'] };
    const answer = await rowSet(query).expect(200);
    expect(answer.body.keys).toEqual({ orders: ['sales__id'], items: ['sales__items_id'] });
    expect(Object.values(answer.body.aliasToMember).every((m: any) => m.startsWith('sales.'))).toBe(true);
    const computed = await computeOver(answer.body, ['sales.region']);
    expect(computed).toEqual(byGroup(await load(query), ['sales.region'], query.measures));
  });

  test('what isn\'t aggregated over rows is refused with its reason, as are a limit and an order', async () => {
    const refused = await rowSet({ measures: ['orders.trailing', 'orders.total'] }).expect(400);
    expect(refused.body).toMatchObject({
      code: 'unsupported_measure',
      refusals: [{ member: 'orders.trailing', reason: 'a rolling window is computed over a time series, not over rows' }],
    });
    const limited = await rowSet({ measures: ['orders.total'], limit: 10, order: { 'orders.total': 'desc' } }).expect(400);
    expect(limited.body.error).toBe('limit: a row-set has every row: no limit; order: a row-set\'s rows have no order');
    const keyless = await rowSet({ measures: ['loose.count'] }).expect(400);
    expect(keyless.body).toMatchObject({ code: 'no_primary_key' });
  });

  test('a token Cube refuses /v1/load is refused here too', async () => {
    await request(server).post('/cubejs-api/v1/row-set').send({ query: { measures: ['orders.total'] } }).expect(403);
  });
});
