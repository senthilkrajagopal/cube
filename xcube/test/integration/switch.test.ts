/**
 * A model that holds file-set revisions switching to items: root items keep
 * their names, SQL and rollup tables (so nothing is rebuilt), and a folder
 * item's rollup builds through Cube's jobs API. Runs when
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

import { createConfig, XcubeRuntime, XcubeServerCore, type XcubeSettings } from '../../src';

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(180 * 1000);

const API_SECRET = 'switch-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-switch-01';

const ordersYaml = (name: string) => `cubes:
  - name: ${name}
    sql_table: main.orders
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: created_at
        sql: created_at
        type: time
    measures:
      - name: count
        type: count
    pre_aggregations:
      - name: main
        external: false
        measures: [count]
        time_dimension: created_at
        granularity: day
        partition_granularity: month
`;

const rollupQuery = (cube: string) => ({
  measures: [`${cube}.count`],
  timeDimensions: [{ dimension: `${cube}.created_at`, granularity: 'day', dateRange: ['2026-01-01', '2026-01-31'] }],
});

describeWithDatabase('switching a file-set model to items', () => {
  const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
  let modelDir: string;
  let driver: DuckDBDriver;
  let runtime: XcubeRuntime;
  let core: XcubeServerCore;
  let server: http.Server;

  beforeAll(async () => {
    process.env.CUBEJS_DB_TYPE = 'duckdb';
    process.env.CUBEJS_PRE_AGGREGATIONS_BUILDER = 'true';
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-switch-'));
    driver = new DuckDBDriver({
      initSql: [
        'CREATE TABLE main.orders (id INTEGER PRIMARY KEY, created_at TIMESTAMP)',
        "INSERT INTO main.orders VALUES (1, TIMESTAMP '2026-01-02 10:00:00'), (2, TIMESTAMP '2026-01-03 11:00:00')",
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
    };
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
      contextToApiScopes: async (_securityContext: any, defaults: any) => [...defaults, 'jobs'],
    }) as any);
    process.env.NODE_ENV = nodeEnv;
    await runtime.attach(core);
    const app = express();
    // As CubejsServer.listen installs it before Cube's routes.
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

  const base = '/cubejs-api/v1/semantic/models/dev';
  const admin = (method: 'put' | 'post', url: string, body: object) => request(server)[method](`${base}${url}`)
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .send(body);
  const token = (revision: number) => jwt.sign({ wechartModel: 'dev', wechartRevision: revision }, API_SECRET);
  const sqlOf = async (revision: number, cube: string) => {
    const res = await request(server).get('/cubejs-api/v1/sql')
      .query({ query: JSON.stringify(rollupQuery(cube)) })
      .set('Authorization', token(revision))
      .expect(200);
    return res.body.sql;
  };
  const rollupsOf = (sql: any) => sql.preAggregations.map((p: any) => ({
    tableName: p.tableName, loadSql: p.loadSql, indexesSql: p.indexesSql, invalidateKeyQueries: p.invalidateKeyQueries,
  }));

  let before: any;
  let revision = 0;

  test('a file set serves the root cube and its rollup', async () => {
    const res = await admin('put', '/snapshot', {
      baseRevision: null, files: [{ path: 'cubes/orders.yml', content: ordersYaml('orders') }],
    }).expect(201);
    revision = res.body.revision;
    before = await sqlOf(revision, 'orders');
    expect(before.preAggregations[0].tableName).toMatch(/orders_main/);
  });

  test('the first items snapshot switches it: the same names, SQL and rollup tables', async () => {
    const res = await admin('put', '/snapshot', {
      baseRevision: revision,
      folders: [{ id: 'froot', parentId: null }, { id: 'fsales', parentId: 'froot' }],
      items: [{ folderId: 'froot', name: 'orders', kind: 'cube', yaml: ordersYaml('orders') }],
    }).expect(201);
    revision = res.body.revision;
    const after = await sqlOf(revision, 'orders');
    expect(rollupsOf(after)).toEqual(rollupsOf(before));
    expect(after.sql).toEqual(before.sql);
  });

  test('a folder item\'s rollup builds through the jobs API, named by its full name', async () => {
    const res = await admin('post', '/changesets', {
      baseRevision: revision, upserts: [{ folderId: 'fsales', name: 'orders', kind: 'cube', yaml: ordersYaml('orders') }],
    }).expect(201);
    revision = res.body.revision;
    expect((await sqlOf(revision, 'fsales__orders')).preAggregations[0].tableName).toMatch(/fsales__orders_main$/);

    const jobs = (body: object) => request(server).post('/cubejs-api/v1/pre-aggregations/jobs')
      .set('Authorization', token(revision))
      .send(body)
      .expect(200);
    const posted = await jobs({
      action: 'post',
      selector: {
        contexts: [{ securityContext: { wechartModel: 'dev' } }],
        timezones: ['UTC'],
        preAggregations: ['fsales__orders.main'],
      },
    });
    expect(posted.body.length).toBeGreaterThan(0);

    let statuses: any[] = [];
    for (let i = 0; i < 60; i++) {
      statuses = (await jobs({ action: 'get', resType: 'object', tokens: posted.body })).body;
      if (Object.values(statuses).every((s: any) => s.status === 'done')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const done = Object.values(statuses) as any[];
    expect(done.map((s) => s.status)).toEqual(done.map(() => 'done'));
    expect(done[0].table).toMatch(/fsales__orders_main/);
    expect(done[0].selector.preAggregations).toEqual(['fsales__orders.main']);
    // The jobs API sent the context to the module owning the cube.
    expect(done[0].selector.contexts[0].securityContext.xcubeModule).toMatch(/^m[0-9a-f]{10}$/);
  });
});
