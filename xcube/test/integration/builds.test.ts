/**
 * A processing rollup build stopped by the queue's cancel (`processing:
 * true`): its query cancelled on the source, no table of it committed, the
 * jobs API saying it failed as stopped, and the cancel's answer saying so.
 * Cube's environment is the test database. Runs when XCUBE_TEST_DATABASE_URL
 * names one; a Cube Store rollup too when XCUBE_TEST_CUBESTORE (host:port)
 * names a Cube Store.
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
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(180 * 1000);

const API_SECRET = 'builds-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-builds';

describeWithDatabase('a processing build stopped by the queue\'s cancel', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const schema = `xcube_t_${suffix}`;
  const models = { internal: `inb_${suffix}`, external: `exb_${suffix}`, shared: `shb_${suffix}` };
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
  let server: http.Server;
  let cubeStore: any;

  const sql = async (text: string, values: unknown[] = []) => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      return (await client.query(text, values)).rows;
    } finally {
      await client.end();
    }
  };

  const instances: { runtime: XcubeRuntime; core: XcubeServerCore; server: http.Server }[] = [];

  /** An instance of xcube in Cube, its own runtime and server, on xcube's database. */
  const start = async (queue: 'memory' | 'cubestore') => {
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
    const instanceRuntime = new XcubeRuntime(settings, { logger: () => undefined });
    await instanceRuntime.start();
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const [csHost, csPort] = (CUBESTORE ?? '').split(':');
    // eslint-disable-next-line global-require
    const { CubeStoreDriver } = require('@cubejs-backend/cubestore-driver');
    const options = createConfig(instanceRuntime, { modelClaim: 'wechartModel', revisionClaim: 'wechartRevision' }, {
      apiSecret: API_SECRET,
      schemaPath: path.relative(process.cwd(), modelDir),
      cacheAndQueueDriver: queue,
      devServer: false,
      telemetry: false,
      logger: () => undefined,
      contextToApiScopes: async (_securityContext: any, defaults: any) => [...defaults, 'jobs'],
      orchestratorOptions: { preAggregationsOptions: { externalRefresh: false } },
      ...(CUBESTORE ? {
        externalDbType: 'cubestore',
        externalDriverFactory: () => new CubeStoreDriver({ host: csHost, port: Number(csPort) }),
      } : {}),
    });
    const instanceCore = new XcubeServerCore(options);
    process.env.NODE_ENV = nodeEnv;
    await instanceRuntime.attach(instanceCore);
    const app = express();
    app.use(bodyParser.json({ limit: '50mb' }));
    await instanceCore.initApp(app);
    const instance = { runtime: instanceRuntime, core: instanceCore, server: app.listen(0) };
    instances.push(instance);
    return instance;
  };

  beforeAll(async () => {
    for (const model of Object.values(models)) {
      await sql(`CREATE SCHEMA IF NOT EXISTS ${modelSchema('prod_pre_aggregations', model)}`);
    }
    Object.assign(process.env, environment);
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-builds-'));
    ({ server } = await start('memory'));
    if (CUBESTORE) {
      const [csHost, csPort] = CUBESTORE.split(':');
      // eslint-disable-next-line global-require
      const { CubeStoreDriver } = require('@cubejs-backend/cubestore-driver');
      cubeStore = new CubeStoreDriver({ host: csHost, port: Number(csPort) });
    }
  });

  afterAll(async () => {
    for (const instance of instances) {
      instance.server.close();
      await instance.runtime.stop();
      await instance.core.shutdown();
    }
    await cubeStore?.release();
    for (const model of Object.values(models)) {
      await sql(`DROP SCHEMA IF EXISTS ${modelSchema('prod_pre_aggregations', model)} CASCADE`).catch(() => undefined);
    }
    Object.keys(environment).forEach((name) => delete process.env[name]);
    fs.rmSync(modelDir, { recursive: true, force: true });
  });

  const admin = (model: string, method: 'get' | 'post' | 'put', route: string, body?: object, at: http.Server = server) => {
    const req = request(at)[method](`/cubejs-api/v1/semantic/models/${model}${route}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    return body ? req.send(body) : req;
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Builds a rollup whose source query sleeps 30 s, cancels it while it builds, and says what came of it. */
  const stopBuild = async (model: string, external: boolean, builder: http.Server = server, canceller: http.Server = server) => {
    const marker = `xcube_stop_${model}`;
    const yaml = 'cubes:\n  - name: slow\n'
      + `    sql: SELECT 1 AS id, '${marker}' AS marker FROM pg_sleep(30)\n`
      + '    dimensions:\n      - name: id\n        sql: id\n        type: number\n        primary_key: true\n'
      + '    measures:\n      - name: count\n        type: count\n'
      + `    pre_aggregations:\n      - name: main\n        external: ${external}\n        scheduled_refresh: false\n        measures:\n          - CUBE.count\n`;
    const { revision } = (await admin(model, 'put', '/snapshot', {
      baseRevision: null, folders: [{ id: 'froot', parentId: null }], items: [{ folderId: 'froot', name: 'slow', kind: 'cube', yaml }],
    }).expect(201)).body;
    const token = jwt.sign({ wechartModel: model, wechartRevision: revision }, API_SECRET);
    const jobs = (body: object) => request(builder).post('/cubejs-api/v1/pre-aggregations/jobs').set('Authorization', token).send(body);
    const posted = await jobs({
      action: 'post',
      selector: { contexts: [{ securityContext: { wechartModel: model } }], timezones: ['UTC'], preAggregations: ['slow.main'] },
    });
    expect({ status: posted.status, error: posted.body.error }).toEqual({ status: 200, error: undefined });

    // Building, its query on the source.
    let entry: any;
    for (let i = 0; i < 100 && !entry; i++) {
      entry = (await admin(model, 'get', '/pre-aggregations/queue', undefined, builder).expect(200)).body.queue.find((e: any) => e.status === 'processing');
      await sleep(100);
    }
    expect(entry).toBeDefined();
    // Running: a pooled connection keeps its last query's text once idle.
    const running = () => sql(
      'SELECT pid FROM pg_stat_activity WHERE state = \'active\' AND query LIKE $1 AND query NOT LIKE \'%pg_stat_activity%\'',
      [`%${marker}%`],
    );
    for (let i = 0; i < 50 && !(await running()).length; i++) {
      await sleep(100);
    }
    expect((await running()).length).toBeGreaterThan(0);

    const started = Date.now();
    const answer = (await admin(model, 'post', '/pre-aggregations/queue/cancel', { keys: [entry.key], processing: true }, canceller).expect(200)).body;
    const took = Date.now() - started;
    let status: any;
    for (let i = 0; i < 60; i++) {
      [status] = Object.values((await jobs({ action: 'get', resType: 'object', tokens: posted.body })).body) as any[];
      if (status.status !== 'processing') {
        break;
      }
      await sleep(500);
    }
    return { answer, took, entry, status, gone: (await running()).length === 0 };
  };

  test('a rollup in the source database: its query cancelled, no table made, failed as stopped', async () => {
    const { answer, took, entry, status, gone } = await stopBuild(models.internal, false);
    expect(answer).toEqual({
      model: models.internal,
      cancelled: [{ key: entry.key, preAggregation: 'slow.main', status: 'processing', build: 'stopped' }],
      notCancelled: [],
    });
    // Within two of the queue's heartbeats, well before its 30 s query would end.
    expect(took).toBeLessThan(20000);
    expect(gone).toBe(true);
    expect(status.status).toMatch(/^failure: .*stopped/);
    expect((await sql('SELECT to_regclass($1) AS t', [entry.targetTable]))[0].t).toBeNull();
  });

  (CUBESTORE ? test : test.skip)('on Cube Store\'s queue, cancelled from another instance: stopped at the building instance\'s next heartbeat', async () => {
    const builder = await start('cubestore');
    const canceller = await start('cubestore');
    const { answer, took, entry, status, gone } = await stopBuild(models.shared, true, builder.server, canceller.server);
    expect(answer.cancelled).toEqual([{ key: entry.key, preAggregation: 'slow.main', status: 'processing', build: 'stopped' }]);
    // At the next of the builder's 8 s heartbeats.
    expect(took).toBeLessThan(15000);
    expect(gone).toBe(true);
    expect(status.status).toMatch(/^failure: .*stopped/);
  });

  (CUBESTORE ? test : test.skip)('a Cube Store rollup: its source query cancelled, nothing committed to Cube Store, failed as stopped', async () => {
    const { answer, took, entry, status, gone } = await stopBuild(models.external, true);
    expect(answer.cancelled).toEqual([{ key: entry.key, preAggregation: 'slow.main', status: 'processing', build: 'stopped' }]);
    expect(took).toBeLessThan(20000);
    expect(gone).toBe(true);
    expect(status.status).toMatch(/^failure: .*stopped/);
    const [tableSchema, tableName] = entry.targetTable.split('.');
    const tables = await cubeStore.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = '${tableSchema}' AND table_name = '${tableName}'`,
      [],
    );
    expect(tables.length).toBe(0);
  });
});
