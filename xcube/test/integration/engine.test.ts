/**
 * wechart's engine as a model's connection, end to end, against a stand-in
 * engine: a real DuckDB in this process behind the engine's routes, its cells
 * encoded by Cube's own DuckDB driver (`Transform.ts`), as the engine encodes
 * them. The token is sealed, the connection tested, cubes queried through
 * Cube with its DuckDB dialect (values bound, a rolling window with no date
 * range), rollups refused, and the SQL runner run on it. Runs when
 * XCUBE_TEST_DATABASE_URL names a Postgres, for xcube's store.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import bodyParser from 'body-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { Client } from 'pg';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import {
  createConfig, generateCredentialKey, sealSecretV1, XcubeRuntime, XcubeServerCore, type XcubeSettings,
} from '../../src';

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { buildTransform, transformChunk } = require('@cubejs-backend/duckdb-driver/dist/src/Transform');

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(180 * 1000);

const API_SECRET = 'engine-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-engine-01';
const ENGINE_TOKEN = 'engine-service-token-0123456789';

const FACTS = `CREATE TABLE main.t_sales AS SELECT * FROM (VALUES
  (1, TIMESTAMP '2024-01-15 10:00:00', 'east', 10.50),
  (2, TIMESTAMP '2024-01-20 00:00:00', 'west', 5.25),
  (3, TIMESTAMP '2024-03-03 12:30:00', 'east', 7.00),
  (4, TIMESTAMP '2024-04-10 23:59:59', 'west', 1.00)
) AS t(c_id, c_ts, c_region, c_amount)`;

/** The stand-in engine: its routes, over one DuckDB, and every call it was sent. */
async function standInEngine() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection: DuckDBConnection = await instance.connect();
  await connection.run(FACTS);
  const calls: { method: string; url: string; body: any; requestId?: string }[] = [];
  const reply = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : undefined;
      calls.push({ method: req.method!, url: req.url!, body, requestId: req.headers['x-request-id'] as string | undefined });
      if (req.method === 'GET' && req.url === '/v1/health') {
        reply(res, 200, { status: 'ok' });
        return;
      }
      if (req.headers.authorization !== `Bearer ${ENGINE_TOKEN}`) {
        reply(res, 401, { error: 'Missing or wrong token', code: 'unauthorized' });
        return;
      }
      if (req.method === 'DELETE') {
        reply(res, 404, { error: 'No such query', code: 'unknown_query' });
        return;
      }
      const unknown = Object.keys(body ?? {}).filter((k) => !['sql', 'params', 'queryId', 'timeoutMs', 'requestId', 'maxRows'].includes(k));
      if (unknown.length) {
        reply(res, 400, { error: `Unknown fields ${unknown.join(', ')}`, code: 'bad_request' });
        return;
      }
      try {
        const result = await connection.run(body.sql, body.params);
        const names = result.columnNames();
        const types = result.columnTypes();
        const transform = buildTransform(names, types);
        const rows: unknown[][] = [];
        for (let chunk = await result.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await result.fetchChunk()) {
          for (const row of transformChunk(chunk, transform)) {
            rows.push(names.map((name: string) => row[name]));
          }
        }
        reply(res, 200, {
          columns: names.map((name: string, i: number) => ({ name, type: String(types[i]) })),
          rows: body.maxRows ? rows.slice(0, body.maxRows) : rows,
        });
      } catch (e: any) {
        reply(res, 422, { error: String(e.message).split('\n')[0], code: 'query_failed' });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      connection.closeSync();
      instance.closeSync();
    },
  };
}

describeWithDatabase('wechart\'s engine as a connection', () => {
  const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
  const allowHttp = process.env.XCUBE_ENGINE_ALLOW_HTTP;
  let engine: Awaited<ReturnType<typeof standInEngine>>;
  let keysDir: string;
  let key: ReturnType<typeof generateCredentialKey>;
  let modelDir: string;
  let runtime: XcubeRuntime;
  let core: XcubeServerCore;
  let server: http.Server;

  beforeAll(async () => {
    process.env.XCUBE_ENGINE_ALLOW_HTTP = 'true';
    engine = await standInEngine();
    keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-credential-keys-'));
    key = generateCredentialKey();
    fs.writeFileSync(path.join(keysDir, `${key.kid}.pem`), key.pem);
    fs.writeFileSync(path.join(keysDir, `${key.kid}.check`), key.check);
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-engine-'));
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

  const base = '/cubejs-api/v1/semantic/models/dev';
  const admin = (method: 'put' | 'post', route: string, body: object) => request(server)[method](`${base}${route}`)
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .send(body);
  let revision: number | undefined;
  const connection = (token: string) => {
    const fields = { baseUrl: engine.url };
    return {
      driver: 'engine',
      authMethod: 'service-token',
      fields,
      sealed: { token: sealSecretV1(key.jwk.x, key.kid, 'engine', 'token', fields, token) },
    };
  };
  const cube = (extra = '') => `cubes:
  - name: sales
    sql_table: main.t_sales
    dimensions:
      - { name: id, sql: c_id, type: number, primary_key: true }
      - { name: region, sql: c_region, type: string }
      - { name: at, sql: c_ts, type: time }
    measures:
      - { name: total, sql: c_amount, type: sum }
      - { name: count, type: count }
      - name: trailing
        sql: c_amount
        type: sum
        rolling_window: { trailing: 2 month }
${extra}`;
  const snapshot = (yaml: string) => admin('put', '/snapshot', {
    baseRevision: revision ?? null,
    folders: [{ id: 'froot', parentId: null }],
    items: [{ folderId: 'froot', name: 'sales', kind: 'cube', yaml }],
  });
  const load = (query: object) => request(server).get('/cubejs-api/v1/load')
    .query({ query: JSON.stringify(query) })
    .set('Authorization', jwt.sign({ wechartModel: 'dev', wechartRevision: revision }, API_SECRET));

  test('the test route checks its health and its token, and never echoes the token', async () => {
    const good = await admin('post', '/connections/test', connection(ENGINE_TOKEN)).expect(200);
    expect(good.body.checks.map((k: any) => [k.id, k.status]))
      .toEqual([['secrets', 'passed'], ['config', 'passed'], ['connect', 'passed'], ['schemas', 'passed']]);
    const bad = await admin('post', '/connections/test', connection('wrong-engine-token-123')).expect(200);
    expect(bad.body.checks.find((k: any) => k.id === 'connect')).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(bad.body)).not.toContain('wrong-engine-token-123');
  });

  test('a cube on it takes no pre-aggregation', async () => {
    await admin('put', '/connections/default', { baseVersion: null, folderId: 'froot', ...connection(ENGINE_TOKEN) }).expect(200);
    const refused = await snapshot(cube('    pre_aggregations:\n      - { name: by_region, measures: [total], dimensions: [region] }\n'));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain('take no pre-aggregations');
  });

  test('Cube queries it in DuckDB\'s dialect: values bound, cells as Cube\'s DuckDB driver gives them', async () => {
    const published = await snapshot(cube()).expect(201);
    revision = published.body.revision;
    const answer = await load({
      measures: ['sales.total', 'sales.count'],
      dimensions: ['sales.region'],
      timeDimensions: [{ dimension: 'sales.at', granularity: 'month', dateRange: ['2024-01-01', '2024-03-31'] }],
      filters: [{ member: 'sales.region', operator: 'equals', values: ['east'] }],
      order: { 'sales.at': 'asc' },
    });
    expect({ status: answer.status, error: answer.body.error }).toEqual({ status: 200, error: undefined });
    expect(answer.body.data).toEqual([
      {
        'sales.region': 'east', 'sales.at.month': '2024-01-01T00:00:00.000', 'sales.at': '2024-01-01T00:00:00.000', 'sales.total': '10.5', 'sales.count': '1',
      },
      {
        'sales.region': 'east', 'sales.at.month': '2024-03-01T00:00:00.000', 'sales.at': '2024-03-01T00:00:00.000', 'sales.total': '7', 'sales.count': '1',
      },
    ]);
    const query = engine.calls.filter((c) => c.method === 'POST').at(-1)!;
    expect(query.body.params).toEqual(expect.arrayContaining(['east']));
    expect(query.body.sql).toContain('main.t_sales');
    expect(query.requestId).toEqual(expect.any(String));
    expect(query.body.requestId).toBe(query.requestId);
  });

  test('a rolling window with no date range runs over the months of the data', async () => {
    const answer = await load({
      measures: ['sales.trailing'],
      timeDimensions: [{ dimension: 'sales.at', granularity: 'month' }],
      order: { 'sales.at': 'asc' },
    });
    expect({ status: answer.status, error: answer.body.error }).toEqual({ status: 200, error: undefined });
    expect(answer.body.data.map((r: any) => [r['sales.at.month'], Number(r['sales.trailing'])])).toEqual([
      ['2024-01-01T00:00:00.000', 15.75],
      ['2024-02-01T00:00:00.000', 15.75],
      ['2024-03-01T00:00:00.000', 7],
      ['2024-04-01T00:00:00.000', 8],
    ]);
  });

  test('an engine error reaches the client with its message', async () => {
    const broken = await snapshot(cube().replace('sql_table: main.t_sales', 'sql_table: main.t_missing')).expect(201);
    revision = broken.body.revision;
    const answer = await load({ measures: ['sales.total'] });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.body.error).toMatch(/t_missing/);
    revision = (await snapshot(cube()).expect(201)).body.revision;
  });

  test('the SQL runner runs on it, capped, asking the engine for one row past the cap', async () => {
    const answer = await admin('post', '/connections/default/sql', {
      runId: crypto.randomUUID(),
      sql: 'SELECT c_id, c_region FROM main.t_sales ORDER BY c_id',
      maxRows: 2,
    }).expect(200);
    expect(answer.body.rows).toEqual([['1', 'east'], ['2', 'west']]);
    expect(answer.body.truncated).toBe('rows');
    expect(engine.calls.filter((c) => c.method === 'POST').at(-1)!.body.maxRows).toBe(3);
  });
});
