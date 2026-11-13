/**
 * Zoneless time dimensions on wechart's engine (R10): a `time` dimension
 * marked `meta: { wechart: { engine: { zoneless: true } } }` holds a wall-clock
 * value (a DATE, or a TIMESTAMP with no zone), which keeps its day in a query
 * with a `timezone`: selected, bucketed by a granularity and filtered by a
 * date range on its own day. An unmarked one is converted to the query's
 * zone, as Cube does. On a stand-in for the engine (a real DuckDB in this
 * process behind the engine's routes), as wechart generates its cubes.
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

const API_SECRET = 'engine-zoneless-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-zoneless';

const DAYS_ID = '00112233445566778899aabbccddeeff';
const col = (n: number) => `c_${n.toString(16).padStart(32, '0')}`;

const TABLES = [
  `CREATE TABLE main.t_${DAYS_ID} AS SELECT * FROM (VALUES
    (1, DATE '2024-01-15', TIMESTAMP '2024-01-15 00:00:00', TIMESTAMP '2024-01-15 03:00:00', 1),
    (2, DATE '2024-01-16', TIMESTAMP '2024-01-16 23:30:00', TIMESTAMP '2024-01-16 12:00:00', 2),
    (3, DATE '2024-01-17', TIMESTAMP '2024-01-17 00:00:00', TIMESTAMP '2024-01-17 22:00:00', 4)
  ) AS t(__sf_row, "${col(1)}", "${col(2)}", "${col(3)}", "${col(4)}")`,
];

const ZONELESS = 'meta: { wechart: { engine: { zoneless: true } } }';

const DAYS = `cubes:
  - name: days
    sql_table: main.t_${DAYS_ID}
    dimensions:
      - { name: sf__row, sql: '{CUBE}.__sf_row', type: number, primary_key: true, public: false }
      - { name: day, sql: '{CUBE}."${col(1)}"', type: time, ${ZONELESS} }
      - { name: local_at, sql: '{CUBE}."${col(2)}"', type: time, ${ZONELESS} }
      - { name: at, sql: '{CUBE}."${col(3)}"', type: time }
    measures:
      - { name: total, sql: '{CUBE}."${col(4)}"', type: sum }
      - { name: count, type: count }
`;

const VIEW = `views:
  - name: v_days
    cubes:
      - join_path: days
        includes: [day, at, total]
`;

describeWithDatabase('zoneless time dimensions on wechart\'s engine (R10)', () => {
  const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
  const allowHttp = process.env.XCUBE_ENGINE_ALLOW_HTTP;
  let engine: Awaited<ReturnType<typeof standInEngine>>;
  let keysDir: string;
  let modelDir: string;
  let runtime: XcubeRuntime;
  let core: XcubeServerCore;
  let server: http.Server;
  let revision: number;

  const admin = (method: 'put' | 'post', route: string, body: object) => request(server)[method](`/cubejs-api/v1/semantic/models/dev${route}`)
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .send(body);

  beforeAll(async () => {
    process.env.XCUBE_ENGINE_ALLOW_HTTP = 'true';
    engine = await standInEngine(TABLES);
    keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-credential-keys-'));
    const key = generateCredentialKey();
    fs.writeFileSync(path.join(keysDir, `${key.kid}.pem`), key.pem);
    fs.writeFileSync(path.join(keysDir, `${key.kid}.check`), key.check);
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-engine-zoneless-'));
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
      items: [
        { folderId: 'froot', name: 'days', kind: 'cube', yaml: DAYS },
        { folderId: 'froot', name: 'v_days', kind: 'view', yaml: VIEW },
      ],
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

  const token = () => jwt.sign({ wechartModel: 'dev', wechartRevision: revision }, API_SECRET);
  const loaded = async (query: object) => {
    const answer = await request(server).post('/cubejs-api/v1/load').set('Authorization', token()).send({ query });
    expect({ status: answer.status, error: answer.body.error }).toEqual({ status: 200, error: undefined });
    return answer.body.data as Record<string, unknown>[];
  };

  const ZONES = ['America/Los_Angeles', 'Asia/Kolkata'];
  const day = (d: string) => `${d}T00:00:00.000`;

  describe.each(ZONES)('in %s', (timezone) => {
    test('a Date member, and a zoneless timestamp, with no granularity keep their value', async () => {
      const rows = await loaded({ dimensions: ['days.day', 'days.local_at'], timezone, order: { 'days.day': 'asc' } });
      expect(rows).toEqual([
        { 'days.day': day('2024-01-15'), 'days.local_at': '2024-01-15T00:00:00.000' },
        { 'days.day': day('2024-01-16'), 'days.local_at': '2024-01-16T23:30:00.000' },
        { 'days.day': day('2024-01-17'), 'days.local_at': '2024-01-17T00:00:00.000' },
      ]);
      const viaView = await loaded({ dimensions: ['v_days.day'], timezone, order: { 'v_days.day': 'asc' } });
      expect(viaView.map((r) => r['v_days.day'])).toEqual([day('2024-01-15'), day('2024-01-16'), day('2024-01-17')]);
    });

    test('a granularity and a date range fall on the value\'s own day', async () => {
      const byDay = await loaded({
        measures: ['days.total'],
        timeDimensions: [{ dimension: 'days.day', granularity: 'day', dateRange: ['2024-01-16', '2024-01-17'] }],
        timezone,
        order: { 'days.day': 'asc' },
      });
      expect(byDay.map((r) => [r['days.day.day'], Number(r['days.total'])])).toEqual([[day('2024-01-16'), 2], [day('2024-01-17'), 4]]);
      // 23:30 on the 16th stays on the 16th, in a zone ahead of UTC too.
      const late = await loaded({
        measures: ['days.total'],
        timeDimensions: [{ dimension: 'days.local_at', granularity: 'day', dateRange: ['2024-01-16', '2024-01-16'] }],
        timezone,
      });
      expect(late.map((r) => [r['days.local_at.day'], Number(r['days.total'])])).toEqual([[day('2024-01-16'), 2]]);
      // A date range with no granularity filters on the value's own days.
      const ranged = await loaded({
        measures: ['days.total'],
        timeDimensions: [{ dimension: 'v_days.day', dateRange: ['2024-01-15', '2024-01-16'] }],
        timezone,
      });
      expect(ranged.map((r) => Number(r['days.total']))).toEqual([3]);
      const monthly = await loaded({ measures: ['days.total'], timeDimensions: [{ dimension: 'days.day', granularity: 'month' }], timezone });
      expect(monthly.map((r) => [r['days.day.month'], Number(r['days.total'])])).toEqual([[day('2024-01-01'), 7]]);
    });
  });

  test('a timestamp with no marker is still converted to the query\'s zone', async () => {
    const expected: Record<string, [string, string[], number[]]> = {
      // UTC 2024-01-15 03:00, 01-16 12:00 and 01-17 22:00.
      'America/Los_Angeles': ['2024-01-14T19:00:00.000', [day('2024-01-14'), day('2024-01-16'), day('2024-01-17')], [1, 2, 4]],
      'Asia/Kolkata': ['2024-01-15T08:30:00.000', [day('2024-01-15'), day('2024-01-16'), day('2024-01-18')], [1, 2, 4]],
    };
    for (const timezone of ZONES) {
      const [first, days, totals] = expected[timezone];
      const raw = await loaded({ dimensions: ['days.at'], timezone, order: { 'days.at': 'asc' } });
      expect(raw[0]['days.at']).toBe(first);
      const byDay = await loaded({ measures: ['days.total'], timeDimensions: [{ dimension: 'days.at', granularity: 'day' }], timezone, order: { 'days.at': 'asc' } });
      expect(byDay.map((r) => [r['days.at.day'], Number(r['days.total'])])).toEqual(days.map((d, i) => [d, totals[i]]));
    }
  });

  test('a row-set, built with the legacy planner, keeps a Date member\'s day too', async () => {
    for (const timezone of ZONES) {
      const answer = await request(server).post('/cubejs-api/v1/row-set').set('Authorization', token())
        .send({ query: { measures: ['days.total'], dimensions: ['days.day'], timezone } });
      expect(answer.status).toBe(200);
      const reader = await engine.connection.runAndReadAll(answer.body.rowSet.sql, answer.body.rowSet.params);
      const days = reader.getRowObjectsJS().map((r: any) => (r.days__day as Date).toISOString()).sort();
      expect(days).toEqual(['2024-01-15T00:00:00.000Z', '2024-01-16T00:00:00.000Z', '2024-01-17T00:00:00.000Z']);
    }
  });
});
