/**
 * What wechart's Jobs and Schedules read of Cube's operations, under the
 * admin credential: a model's build queue and cancelling from it, its hidden
 * cubes on the admin meta, and its refresh worker's runs. Cube's environment
 * is the test database. Runs when XCUBE_TEST_DATABASE_URL names one.
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
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(180 * 1000);

const API_SECRET = 'ops-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-operations';

// Widens what the runtime keeps protected: refresh runs are written now, not within seconds.
class TestRuntime extends XcubeRuntime {
  public async writeTicksNow() {
    await this.writeTicks();
  }
}

describeWithDatabase('operations: the build queue, hidden cubes and the refresh worker', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const schema = `xcube_t_${suffix}`;
  // Models named afresh each run: their rollup schemas, in the test database, are new.
  const names = ['queued', 'rerun', 'hidden', 'refreshed', 'broken', 'idle'] as const;
  const m = Object.fromEntries(names.map((n) => [n, `${n}_${suffix}`])) as Record<(typeof names)[number], string>;
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
  let runtime: TestRuntime;
  let core: XcubeServerCore;
  let server: http.Server;

  // Each model's rollup schema, made as a first build would, so that three first builds don't race to (Postgres's
  // CREATE SCHEMA IF NOT EXISTS isn't safe at once), and dropped after.
  const rollupSchemas = async (statement: 'CREATE SCHEMA IF NOT EXISTS' | 'DROP SCHEMA IF EXISTS') => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      for (const model of Object.values(m)) {
        await client.query(`${statement} ${modelSchema('prod_pre_aggregations', model)}${statement.startsWith('DROP') ? ' CASCADE' : ''}`);
      }
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    await rollupSchemas('CREATE SCHEMA IF NOT EXISTS');
    Object.assign(process.env, environment);
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-ops-'));
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
    runtime = new TestRuntime(settings, { logger: () => undefined });
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
      contextToApiScopes: async (_securityContext: any, defaults: any) => [...defaults, 'jobs'],
      // Builds as the refresh worker does, one at a time: the rest wait in the queue.
      orchestratorOptions: { preAggregationsOptions: { externalRefresh: false, queueOptions: { concurrency: 1 } } },
    });
    core = new XcubeServerCore(options);
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
    await rollupSchemas('DROP SCHEMA IF EXISTS');
    Object.keys(environment).forEach((name) => delete process.env[name]);
    fs.rmSync(modelDir, { recursive: true, force: true });
  });

  const admin = (model: string, method: 'get' | 'post' | 'put', route: string, body?: object) => {
    const req = request(server)[method](`/cubejs-api/v1/semantic/models/${model}${route}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    return body ? req.send(body) : req;
  };
  // A new model, with these items at its root, once this instance serves it.
  const publish = async (model: string, items: object[]) => {
    const { revision } = (await admin(model, 'put', '/snapshot', {
      baseRevision: null, folders: [{ id: 'froot', parentId: null }], items,
    }).expect(201)).body;
    await request(server).get('/cubejs-api/v1/meta')
      .set('Authorization', jwt.sign({ wechartModel: model, wechartRevision: revision }, API_SECRET))
      .expect(200);
    return revision as number;
  };
  const cube = (name: string, yaml: string) => ({ folderId: 'froot', name, kind: 'cube', yaml });

  test('the build queue names each build\'s pre-aggregation and job; cancelling says what was cancelled and why not', async () => {
    const rollup = (name: string) => `      - name: ${name}\n        external: false\n        measures:\n          - CUBE.count\n`;
    const revision = await publish(m.queued, [cube('slow', 'cubes:\n  - name: slow\n    sql: SELECT pg_sleep(4) AS s, 1 AS id\n'
      + '    dimensions:\n      - name: id\n        sql: id\n        type: number\n        primary_key: true\n'
      + `    measures:\n      - name: count\n        type: count\n    pre_aggregations:\n${rollup('a')}${rollup('b')}${rollup('c')}`)]);
    const posted = await request(server).post('/cubejs-api/v1/pre-aggregations/jobs')
      .set('Authorization', jwt.sign({ wechartModel: m.queued, wechartRevision: revision }, API_SECRET))
      .send({
        action: 'post',
        selector: { contexts: [{ securityContext: { wechartModel: m.queued } }], timezones: ['UTC'], preAggregations: ['slow.a', 'slow.b', 'slow.c'] },
      });
    expect({ status: posted.status, error: posted.body.error }).toEqual({ status: 200, error: undefined });
    expect(posted.body).toHaveLength(3);

    // One building, two waiting.
    let queue: any[] = [];
    for (let i = 0; i < 50; i++) {
      queue = (await admin(m.queued, 'get', '/pre-aggregations/queue').expect(200)).body.queue;
      if (queue.length === 3 && queue.some((e) => e.status === 'processing')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(queue.map((e) => e.preAggregation).sort()).toEqual(['slow.a', 'slow.b', 'slow.c']);
    expect(queue.map((e) => e.status).sort()).toEqual(['processing', 'queued', 'queued']);
    for (const entry of queue) {
      expect(entry).toMatchObject({ dataSource: 'default', startedBy: 'jobs', stalled: false, partition: null });
      expect(entry.table).toMatch(/\.slow_[abc]$/);
      expect(entry.targetTable.startsWith(`${entry.table}_`)).toBe(true);
      expect(posted.body).toContain(entry.job);
      expect(typeof entry.key).toBe('string');
      expect(Date.parse(entry.addedAt)).toBeGreaterThan(0);
    }
    // Another model's queue holds none of them.
    expect((await admin('other', 'get', '/pre-aggregations/queue').expect(404)).body.code).toBe('unknown_model');

    const running = queue.find((e) => e.status === 'processing');
    const [waiting] = queue.filter((e) => e.status === 'queued');
    const answer = (await admin(m.queued, 'post', '/pre-aggregations/queue/cancel', { keys: [waiting.key, running.key, 'no-such-key'] })
      .expect(200)).body;
    expect(answer.cancelled).toEqual([{ key: waiting.key, preAggregation: waiting.preAggregation, status: 'queued' }]);
    expect(answer.notCancelled).toEqual([{ key: running.key, reason: 'processing' }, { key: 'no-such-key', reason: 'gone' }]);
    // A processing one, when asked to.
    const stopped = (await admin(m.queued, 'post', '/pre-aggregations/queue/cancel', { keys: [running.key], processing: true }).expect(200)).body;
    expect(stopped.cancelled).toEqual([{ key: running.key, preAggregation: running.preAggregation, status: 'processing' }]);
    const left = (await admin(m.queued, 'get', '/pre-aggregations/queue').expect(200)).body.queue.map((e: any) => e.key);
    expect(left).not.toContain(waiting.key);
    expect(left).not.toContain(running.key);

    await admin(m.queued, 'post', '/pre-aggregations/queue/cancel', { keys: [] }).expect(400);
    // Never with a user's token.
    await request(server).get('/cubejs-api/v1/semantic/models/queued/pre-aggregations/queue')
      .set('Authorization', jwt.sign({ wechartModel: m.queued }, API_SECRET)).expect(401);
  });

  test('a build the refresh worker queued, once cancelled, is queued again by its next run: its refresh key still says it is due', async () => {
    await publish(m.rerun, [cube('lagging', 'cubes:\n  - name: lagging\n    sql: SELECT pg_sleep(2) AS s, 1 AS id\n'
      + '    measures:\n      - name: count\n        type: count\n'
      + '    pre_aggregations:\n      - name: main\n        external: false\n        measures:\n          - CUBE.count\n')]);
    const contexts = (await runtime.refreshContexts()).filter((c: any) => c.securityContext?.wechartModel === m.rerun);
    // As the refresh worker runs the model's context at each of its ticks.
    const tick = () => Promise.all(contexts.map((context) => core.runScheduledRefresh(context, {})));
    const queued = async () => {
      for (let i = 0; i < 100; i++) {
        const [entry] = (await admin(m.rerun, 'get', '/pre-aggregations/queue').expect(200)).body.queue;
        if (entry) {
          return entry;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('nothing was queued');
    };

    const first = tick();
    const entry = await queued();
    expect(entry).toMatchObject({ preAggregation: 'lagging.main', startedBy: 'scheduler', job: null });
    expect(entry.requestId).toMatch(/^scheduler-/);
    const { cancelled } = (await admin(m.rerun, 'post', '/pre-aggregations/queue/cancel', { keys: [entry.key], processing: true }).expect(200)).body;
    expect(cancelled).toHaveLength(1);
    await first;

    const second = tick();
    const again = await queued();
    // The same build again: its key is its refresh key's value, which hasn't turned over.
    expect(again).toMatchObject({ key: entry.key, preAggregation: 'lagging.main', table: entry.table, startedBy: 'scheduler' });
    await second;
  });

  test('the admin meta lists hidden cubes when asked, each cube and member marked public or not', async () => {
    await publish(m.hidden, [
      cube('shown', 'cubes:\n  - name: shown\n    sql: SELECT 1 AS id\n    measures:\n      - name: count\n        type: count\n'),
      cube('backstage', 'cubes:\n  - name: backstage\n    public: false\n    sql: SELECT 1 AS id\n    measures:\n      - name: count\n        type: count\n'
        + '    pre_aggregations:\n      - name: nightly\n        external: false\n        measures:\n          - CUBE.count\n'
        + '        refresh_key:\n          every: "0 3 * * *"\n          timezone: Europe/Berlin\n'),
    ]);
    const cubeNames = (body: any) => body.cubes.map((c: any) => c.name).sort();
    expect(cubeNames((await admin(m.hidden, 'get', '/meta?extended=true').expect(200)).body)).toEqual(['shown']);
    const all = (await admin(m.hidden, 'get', '/meta?extended=true&hidden=true').expect(200)).body;
    expect(cubeNames(all)).toEqual(['backstage', 'shown']);
    const backstage = all.cubes.find((c: any) => c.name === 'backstage');
    expect(backstage.public).toBe(false);
    expect(backstage.measures[0].public).toBe(false);
    expect(backstage.preAggregations[0]).toMatchObject({ name: 'nightly' });
    expect(all.cubes.find((c: any) => c.name === 'shown')).toMatchObject({ public: true, measures: [expect.objectContaining({ public: true })] });
    expect(cubeNames((await admin(m.hidden, 'get', '/meta?hidden=true').expect(200)).body)).toEqual(['backstage', 'shown']);
    await admin(m.hidden, 'get', '/meta?hidden=maybe').expect(400);
  });

  test('the refresh worker\'s status: the revision it refreshed, its last run of each module, and a run\'s error', async () => {
    const revision = await publish(m.refreshed, [
      cube('fine', 'cubes:\n  - name: fine\n    sql: SELECT 1 AS id\n    measures:\n      - name: count\n        type: count\n'),
    ]);
    const broken = await publish(m.broken, [
      cube('failing', 'cubes:\n  - name: failing\n    sql: SELECT 1 AS id\n    refresh_key:\n      sql: SELECT no_such_function()\n'
        + '    measures:\n      - name: count\n        type: count\n'),
    ]);
    // As the refresh worker runs each of its contexts.
    for (const context of await runtime.refreshContexts()) {
      await core.runScheduledRefresh(context, {});
    }
    await runtime.writeTicksNow();

    const fine = (await admin(m.refreshed, 'get', '/refresh-worker').expect(200)).body;
    expect(fine).toMatchObject({ model: m.refreshed, revision });
    expect(fine.workers).toHaveLength(1);
    const [worker] = fine.workers;
    expect(worker).toMatchObject({ instance: runtime.instanceId, revision });
    expect(worker.modules).toEqual([expect.objectContaining({ module: 'all', revision, finished: true, lastError: null })]);
    expect(Date.parse(worker.modules[0].lastOkAt)).toBeGreaterThan(0);

    const failing = (await admin(m.broken, 'get', '/refresh-worker').expect(200)).body;
    const [module] = failing.workers[0].modules;
    expect(module).toMatchObject({ revision: broken, finished: false, lastOkAt: null });
    expect(module.lastError.message).toMatch(/no_such_function/);

    // A model no worker refreshed yet has none.
    await publish(m.idle, [cube('quiet', 'cubes:\n  - name: quiet\n    sql: SELECT 1 AS id\n    measures:\n      - name: count\n        type: count\n')]);
    expect((await admin(m.idle, 'get', '/refresh-worker').expect(200)).body.workers).toEqual([]);
    await admin('nowhere', 'get', '/refresh-worker').expect(404);
  });
});
