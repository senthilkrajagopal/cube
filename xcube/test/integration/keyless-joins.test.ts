/**
 * Keyless joins, end to end: a cube with no primary key opts in to joining a
 * cube unique on the join's keys, many_to_one, and each planner counts its
 * rows once, joined, filtered on the joined cube and from a rollup. Runs when
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

const API_SECRET = 'keyless-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-keyless-01';

// h is unique on (region, day): its window partitions by those keys only, as wechart writes it.
const helper = (joins = '') => `  - name: h
    sql: SELECT DISTINCT region, day, SUM(amount) OVER (PARTITION BY region) AS region_total FROM main.facts
${joins}    dimensions:
      - name: region
        sql: "{CUBE}.region"
        type: string
        primary_key: true
        public: true
      - name: day
        sql: "{CUBE}.day"
        type: string
        primary_key: true
        public: true
      - name: region_total
        sql: "{CUBE}.region_total"
        type: number
`;

const facts = (preAggregations = '') => `  - name: a
    sql_table: main.facts
    meta:
      xcube_keyless_joins: true
    joins:
      - name: h
        relationship: many_to_one
        sql: "{CUBE}.region = {h.region} AND {CUBE}.day = {h.day}"
    dimensions:
      - name: region
        sql: region
        type: string
      - name: region_total
        sql: "{h.region_total}"
        type: number
    measures:
      - name: count
        type: count
      - name: total
        sql: amount
        type: sum
      - name: mean
        sql: amount
        type: avg
      - name: per_row
        sql: "{total} / {count}"
        type: number
${preAggregations}`;

const rollup = `    pre_aggregations:
      - name: by_total
        external: false
        measures: [count, total]
        dimensions: [region, h.region_total]
`;

const model = `cubes:\n${facts(rollup)}${helper()}`;

// A one_to_many join beyond h repeats a's rows: Tesseract would answer with wrong numbers.
const transitive = `cubes:\n${facts()}${helper(`    joins:
      - name: other
        relationship: one_to_many
        sql: "{CUBE}.region = {other}.region"
`)}  - name: other
    sql_table: main.other
    dimensions:
      - name: k
        sql: "region || n"
        type: string
        primary_key: true
      - name: region
        sql: region
        type: string
`;

describeWithDatabase('keyless joins', () => {
  const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
  const planner = process.env.CUBEJS_TESSERACT_SQL_PLANNER;
  let modelDir: string;
  let driver: DuckDBDriver;
  let runtime: XcubeRuntime;
  let core: XcubeServerCore;
  let server: http.Server;

  beforeAll(async () => {
    process.env.CUBEJS_DB_TYPE = 'duckdb';
    process.env.CUBEJS_PRE_AGGREGATIONS_BUILDER = 'true';
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-keyless-'));
    driver = new DuckDBDriver({
      initSql: [
        'CREATE TABLE main.facts (region VARCHAR, day VARCHAR, amount INTEGER)',
        // Two rows alike, as a table with no key may hold.
        "INSERT INTO main.facts VALUES ('eu', 'd1', 10), ('eu', 'd1', 10), ('eu', 'd2', 5), ('us', 'd1', 7)",
        'CREATE TABLE main.other (region VARCHAR, n INTEGER)',
        "INSERT INTO main.other VALUES ('eu', 1), ('eu', 2)",
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
    if (planner === undefined) {
      delete process.env.CUBEJS_TESSERACT_SQL_PLANNER;
    } else {
      process.env.CUBEJS_TESSERACT_SQL_PLANNER = planner;
    }
    fs.rmSync(modelDir, { recursive: true, force: true });
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  const publish = (name: string, content: string) => request(server)
    .put(`/cubejs-api/v1/semantic/models/${name}/snapshot`)
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .send({ baseRevision: null, files: [{ path: 'cubes/a.yml', content }] });
  const token = (name: string) => jwt.sign({ wechartModel: name }, API_SECRET);
  const load = async (name: string, query: object) => {
    const res = await request(server).get('/cubejs-api/v1/load')
      .query({ query: JSON.stringify(query) })
      .set('Authorization', token(name));
    expect([res.status, res.body.error]).toEqual([200, undefined]);
    return { data: res.body.data, rollups: Object.keys(res.body.usedPreAggregations ?? {}) };
  };

  const byTotal = { measures: ['a.count', 'a.total'], dimensions: ['h.region_total'], order: { 'h.region_total': 'asc' } };
  const counted = [{ 'h.region_total': '7', 'a.count': '1', 'a.total': '7' }, { 'h.region_total': '25', 'a.count': '3', 'a.total': '25' }];

  // Cube compiles each query's SQL once per model, so each planner has a model of its own.
  test.each([['tesseract', 'true'], ['legacy', 'false']])('the %s planner counts the cube\'s rows once', async (name, flag) => {
    process.env.CUBEJS_TESSERACT_SQL_PLANNER = flag;
    expect((await publish(name, model)).status).toBe(201);

    // The planner answering: Cube's legacy planner lays its SQL out on lines, Tesseract on one.
    const sql = await request(server).get('/cubejs-api/v1/sql')
      .query({ query: JSON.stringify({ ...byTotal, measures: ['a.mean'] }) })
      .set('Authorization', token(name))
      .expect(200);
    expect(sql.body.sql.sql[0].startsWith('SELECT\n')).toBe(flag === 'false');

    expect((await load(name, { ...byTotal, measures: ['a.count', 'a.total', 'a.mean', 'a.per_row'] })).data).toEqual([
      { 'h.region_total': '7', 'a.count': '1', 'a.total': '7', 'a.mean': '7', 'a.per_row': '7' },
      { 'h.region_total': '25', 'a.count': '3', 'a.total': '25', 'a.mean': '8.333333333333334', 'a.per_row': '8.333333333333334' },
    ]);
    // Through a's own dimension on h, as a view would show it.
    expect((await load(name, { measures: ['a.count', 'a.total'], dimensions: ['a.region_total'], order: { 'a.region_total': 'asc' } })).data)
      .toEqual(counted.map((row) => ({ 'a.region_total': row['h.region_total'], 'a.count': row['a.count'], 'a.total': row['a.total'] })));
    expect((await load(name, { measures: ['a.count', 'a.total'], filters: [{ member: 'h.region_total', operator: 'gt', values: ['10'] }] })).data)
      .toEqual([{ 'a.count': '3', 'a.total': '25' }]);

    const fromRollup = await load(name, byTotal);
    expect(fromRollup.data).toEqual(counted);
    expect(fromRollup.rollups).toEqual([expect.stringMatching(/\.a_by_total$/)]);
  });

  test('a model where a join beyond the joined cube repeats the cube\'s rows doesn\'t compile', async () => {
    const res = await publish('transitive', transitive);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([expect.objectContaining({
      path: 'cubes/a.yml',
      message: expect.stringContaining('the hasMany join from \'h\' to \'other\' can repeat its rows'),
    })]);
  });
});
