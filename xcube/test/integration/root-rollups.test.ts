/**
 * wechart's R38 over R71: a file-set model switched to items keeps its root
 * cube's SQL and rollup table names, so nothing is built again. The rollup is
 * wechart's seed's: a 30-character stem, partitioned by year, with an index,
 * kept in Cube Store, where Postgres's 63 bytes don't bind it. Cube's
 * environment is the test database. Runs when XCUBE_TEST_DATABASE_URL names
 * one and XCUBE_TEST_CUBESTORE (host:port) a Cube Store.
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
  createConfig, XcubeRuntime, XcubeServerCore, type XcubeSettings,
} from '../../src';
import { modelSchema } from '../../src/config';

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const CUBESTORE = process.env.XCUBE_TEST_CUBESTORE;
const describeWithCubeStore = DATABASE_URL && CUBESTORE ? describe : describe.skip;

jest.setTimeout(180 * 1000);

const API_SECRET = 'root-rollups-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-roots';

describeWithCubeStore('a root cube\'s rollup across the switch to items (R38)', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const schema = `xcube_t_${suffix}`;
  const warehouse = `rr_${suffix}`;
  const model = `rr_${suffix}`;
  const url = new URL(DATABASE_URL ?? 'postgres://x@localhost/x');
  const environment: Record<string, string> = {
    CUBEJS_DB_TYPE: 'postgres',
    CUBEJS_DB_HOST: url.hostname,
    CUBEJS_DB_PORT: url.port || '5432',
    CUBEJS_DB_NAME: url.pathname.slice(1),
    CUBEJS_DB_USER: decodeURIComponent(url.username),
    CUBEJS_DB_PASS: decodeURIComponent(url.password),
  };
  let modelDir: string;
  let runtime: XcubeRuntime;
  let core: XcubeServerCore;
  let server: http.Server;
  let cubeStore: any;

  const sql = async (text: string) => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      return (await client.query(text)).rows;
    } finally {
      await client.end();
    }
  };

  // wechart's infra/cube/model/cubes/monthly_orders.yml, on this test's table.
  const yaml = `cubes:
  - name: monthly_orders
    sql_table: ${warehouse}.orders
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: status
        sql: status
        type: string
      - name: ordered_at
        sql: ordered_at
        type: time
    measures:
      - name: count
        type: count
    pre_aggregations:
      - name: by_status_month
        measures:
          - count
        dimensions:
          - status
        time_dimension: ordered_at
        granularity: month
        partition_granularity: year
        refresh_key:
          every: 1 hour
        indexes:
          - name: by_status
            columns:
              - status
`;
  const query = {
    measures: ['monthly_orders.count'],
    dimensions: ['monthly_orders.status'],
    timeDimensions: [{ dimension: 'monthly_orders.ordered_at', granularity: 'month', dateRange: ['2026-01-01', '2026-12-31'] }],
  };

  beforeAll(async () => {
    await sql(`CREATE SCHEMA ${warehouse};
      CREATE TABLE ${warehouse}.orders (id int PRIMARY KEY, status text, ordered_at timestamp);
      INSERT INTO ${warehouse}.orders VALUES (1, 'open', '2026-01-05'), (2, 'shipped', '2026-02-07'), (3, 'open', '2026-02-09');
      CREATE SCHEMA IF NOT EXISTS ${modelSchema('prod_pre_aggregations', model)};`);
    Object.assign(process.env, environment);
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-roots-'));
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
    runtime = new XcubeRuntime(settings, { logger: () => undefined });
    await runtime.start();
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const [csHost, csPort] = CUBESTORE!.split(':');
    // eslint-disable-next-line global-require
    const { CubeStoreDriver } = require('@cubejs-backend/cubestore-driver');
    core = new XcubeServerCore(createConfig(runtime, { modelClaim: 'wechartModel', revisionClaim: 'wechartRevision' }, {
      apiSecret: API_SECRET,
      schemaPath: path.relative(process.cwd(), modelDir),
      cacheAndQueueDriver: 'memory',
      devServer: false,
      telemetry: false,
      logger: () => undefined,
      contextToApiScopes: async (_securityContext: any, defaults: any) => [...defaults, 'jobs'],
      orchestratorOptions: { preAggregationsOptions: { externalRefresh: false } },
      externalDbType: 'cubestore',
      externalDriverFactory: () => new CubeStoreDriver({ host: csHost, port: Number(csPort) }),
    }));
    process.env.NODE_ENV = nodeEnv;
    await runtime.attach(core);
    const app = express();
    app.use(bodyParser.json({ limit: '50mb' }));
    await core.initApp(app);
    server = app.listen(0);
    cubeStore = new CubeStoreDriver({ host: csHost, port: Number(csPort) });
  });

  const tablesInCubeStore = async () => (await cubeStore.query(
    'SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = ?',
    [modelSchema('prod_pre_aggregations', model)],
  )).map((t: any) => t.table_name).sort();

  afterAll(async () => {
    server?.close();
    await runtime?.stop();
    await core?.shutdown();
    for (const table of await tablesInCubeStore().catch(() => [])) {
      await cubeStore.query(`DROP TABLE ${modelSchema('prod_pre_aggregations', model)}.${table}`, []).catch(() => undefined);
    }
    await cubeStore?.release();
    Object.keys(environment).forEach((name) => delete process.env[name]);
    fs.rmSync(modelDir, { recursive: true, force: true });
    await sql(`DROP SCHEMA IF EXISTS ${warehouse} CASCADE; DROP SCHEMA IF EXISTS ${modelSchema('prod_pre_aggregations', model)} CASCADE;
      DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
  });

  const admin = (method: 'put', route: string, body: object) => request(server)[method](`/cubejs-api/v1/semantic/models/${model}${route}`)
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .send(body);
  const token = (revision: number) => jwt.sign({ wechartModel: model, wechartRevision: revision }, API_SECRET);
  const planned = async (revision: number) => (await request(server).get('/cubejs-api/v1/sql')
    .query({ query: JSON.stringify(query) })
    .set('Authorization', token(revision))
    .expect(200)).body.sql;
  test('switched to items, a 30-character root rollup stem keeps its table names, and nothing is built again', async () => {
    const files = await admin('put', '/snapshot', {
      baseRevision: null, files: [{ path: 'monthly_orders.yml', content: yaml }],
    }).expect(201);
    const before = await planned(files.body.revision);
    expect(before.preAggregations[0].tableName).toMatch(/\.monthly_orders_by_status_month$/);

    // Built through the jobs API, as wechart's refresh worker would.
    const jobs = (body: object) => request(server).post('/cubejs-api/v1/pre-aggregations/jobs').set('Authorization', token(files.body.revision)).send(body);
    const posted = await jobs({
      action: 'post',
      selector: { contexts: [{ securityContext: { wechartModel: model } }], timezones: ['UTC'], preAggregations: ['monthly_orders.by_status_month'] },
    });
    expect({ status: posted.status, error: posted.body.error }).toEqual({ status: 200, error: undefined });
    let statuses: any[] = [];
    for (let i = 0; i < 120; i++) {
      statuses = Object.values((await jobs({ action: 'get', resType: 'object', tokens: posted.body })).body);
      if (statuses.length && statuses.every((s: any) => s.status === 'done')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(statuses.map((s: any) => s.status)).toEqual(statuses.map(() => 'done'));
    const built = await tablesInCubeStore();
    // A partition's table, 30 + 8 + up to 26: up to 64 characters, more than Postgres takes, and Cube Store keeps it.
    expect(built.length).toBeGreaterThan(0);
    expect(built.every((t: string) => t.startsWith('monthly_orders_by_status_month2026') && t.length >= 62)).toBe(true);

    // The switch: the same cube as an item of the root.
    const items = await admin('put', '/snapshot', {
      baseRevision: files.body.revision,
      folders: [{ id: 'froot', parentId: null }],
      items: [{ folderId: 'froot', name: 'monthly_orders', kind: 'cube', yaml }],
    }).expect(201);
    const after = await planned(items.body.revision);
    expect(after.preAggregations.map((p: any) => p.tableName)).toEqual(before.preAggregations.map((p: any) => p.tableName));
    expect(after.sql).toEqual(before.sql);

    // Answered from the tables built before the switch: no build since, nothing new in Cube Store.
    const answer = await request(server).post('/cubejs-api/v1/load').set('Authorization', token(items.body.revision))
      .send({ query });
    expect({ status: answer.status, error: answer.body.error }).toEqual({ status: 200, error: undefined });
    // The table planned before the switch, at the version built before it: its last part is when, in base-32 seconds.
    const used = answer.body.usedPreAggregations ?? {};
    expect(Object.keys(used)).toEqual(before.preAggregations.map((p: any) => p.tableName));
    const builtAt = built.map((t: string) => parseInt(t.split('_').pop()!, 32) * 1000);
    expect(builtAt).toContain((Object.values(used)[0] as any).lastUpdatedAt);
    expect(await tablesInCubeStore()).toEqual(built);
  });
});
