/**
 * The whole stack in process: Cube's server core with the introspection
 * gateway, a DuckDB data source and a one-cube data model, asked over HTTP as
 * wechart asks it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { DuckDBDriver } from '@cubejs-backend/duckdb-driver';

import { XcubeServerCore } from '../../src';

jest.setTimeout(60 * 1000);

const API_SECRET = 'server-test-secret';

describe('XcubeServerCore', () => {
  let modelDir: string;
  let driver: DuckDBDriver;
  let core: XcubeServerCore;
  let app: express.Application;

  // As wechart grants it: introspection alone, to the token that asks for it.
  const token = jwt.sign({ introspect: true }, API_SECRET);
  const userToken = jwt.sign({}, API_SECRET);
  const base = '/cubejs-api/v1/introspection/data-sources/default';

  beforeAll(async () => {
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-'));
    fs.mkdirSync(path.join(modelDir, 'cubes'));
    fs.writeFileSync(path.join(modelDir, 'cubes', 'existing.yml'), [
      'cubes:',
      '  - name: existing',
      '    sql_table: main.customers',
      '    measures:',
      '      - name: count',
      '        type: count',
      '',
    ].join('\n'));

    driver = new DuckDBDriver({
      initSql: [
        'CREATE TABLE main.customers (id INTEGER PRIMARY KEY, name VARCHAR)',
        'CREATE TABLE main.orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total_amount DECIMAL(10, 2), created_at TIMESTAMP)',
        'CREATE VIEW main.big_orders AS SELECT * FROM main.orders WHERE total_amount > 100',
        "INSERT INTO main.customers VALUES (1, 'Ada')",
        "INSERT INTO main.orders VALUES (1, 1, 12.5, TIMESTAMP '2026-01-02 03:04:05')",
      ].join('; '),
    });

    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.CUBEJS_DB_TYPE = 'duckdb';
    core = new XcubeServerCore({
      apiSecret: API_SECRET,
      driverFactory: () => driver,
      // Cube joins schemaPath onto the working directory (FileRepository).
      schemaPath: path.relative(process.cwd(), modelDir),
      cacheAndQueueDriver: 'memory',
      devServer: false,
      telemetry: false,
      logger: () => undefined,
      contextToApiScopes: async (securityContext: any, defaultScopes: any) => (
        securityContext?.introspect ? ['introspection'] : defaultScopes
      ),
    } as any);
    process.env.NODE_ENV = nodeEnv;

    app = express();
    await core.initApp(app);
  });

  afterAll(async () => {
    delete process.env.CUBEJS_DB_TYPE;
    await core?.shutdown();
    await driver?.release();
    fs.rmSync(modelDir, { recursive: true, force: true });
  });

  const get = (url: string, auth = token) => request(app).get(url).set('Authorization', auth);
  const post = (url: string, body: object) => request(app)
    .post(url)
    .set('Authorization', token)
    .set('Content-Type', 'application/json')
    .send(body);

  test('lists the data source', async () => {
    const res = await get('/cubejs-api/v1/introspection/data-sources').expect(200);

    expect(res.body).toEqual({ dataSources: [{ dataSource: 'default', dbType: 'duckdb' }] });
  });

  test('lists schemas, and tables with their types', async () => {
    expect((await get(`${base}/schemas`).expect(200)).body.schemas).toContainEqual({ name: 'main' });

    const res = await get(`${base}/tables?schema=main`).expect(200);
    expect(res.body).toEqual({
      tables: [
        { schema: 'main', name: 'big_orders', type: 'view', rawType: 'VIEW' },
        { schema: 'main', name: 'customers', type: 'table', rawType: 'BASE TABLE' },
        { schema: 'main', name: 'orders', type: 'table', rawType: 'BASE TABLE' },
      ],
      total: 3,
    });
  });

  test('gives columns with their types', async () => {
    const res = await post(`${base}/columns`, { tables: [{ schema: 'main', table: 'orders' }] }).expect(200);

    expect(res.body.tables[0].columns.map(({ name, type }) => [name, type])).toEqual([
      ['id', 'number'],
      ['customer_id', 'number'],
      ['total_amount', 'number'],
      ['created_at', 'time'],
    ]);
  });

  test('scaffolds a cube per table, with measures and joins', async () => {
    const res = await post(`${base}/scaffold`, {
      tables: [{ schema: 'main', table: 'orders' }, { schema: 'main', table: 'customers' }],
    }).expect(200);

    expect(res.body.cubes.map(({ cube, fileName }) => [cube, fileName])).toEqual([
      ['orders', 'orders.yml'],
      ['customers', 'customers.yml'],
    ]);
    expect(res.body.cubes[0].content).toContain('type: sum');
    expect(res.body.cubes[0].content).toContain('relationship: many_to_one');
  });

  test('serves its data model', async () => {
    const res = await get('/cubejs-api/v1/meta', userToken).expect(200);

    expect(res.body.cubes.map(c => c.name)).toEqual(['existing']);
  });

  test('keeps the introspection scope to the introspection routes', async () => {
    await get('/cubejs-api/v1/meta').expect(403);
    await get(`${base}/schemas`, userToken).expect(403);
    await get('/cubejs-api/v1/meta', userToken).expect(200);
  });

  test('refuses a data source it doesn\'t know', async () => {
    const res = await get('/cubejs-api/v1/introspection/data-sources/nope/schemas').expect(404);

    expect(res.body.error).toEqual('Unknown data source: \'nope\'');
  });
});
