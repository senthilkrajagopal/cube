/**
 * Two Cube cores in process, each with its own xcube runtime, on one real
 * Postgres (xcube's schema) and one DuckDB warehouse: imports, the switch
 * between revisions, read-your-writes, checks, and serving with the database
 * gone. Runs when XCUBE_TEST_DATABASE_URL names a Postgres to use.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { Client } from 'pg';
import { DuckDBDriver } from '@cubejs-backend/duckdb-driver';

import { createConfig, XcubeRuntime, XcubeServerCore, type XcubeSettings } from '../../src';

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

jest.setTimeout(120 * 1000);

const API_SECRET = 'revisions-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-0123456789';

const ordersCube = (extraMeasure = '') => [
  'cubes:',
  '  - name: orders',
  '    sql_table: main.orders',
  '    joins:',
  '      - name: customers',
  '        sql: "{CUBE}.customer_id = {customers}.id"',
  '        relationship: many_to_one',
  '    dimensions:',
  '      - name: id',
  '        sql: id',
  '        type: number',
  '        primary_key: true',
  '    measures:',
  '      - name: count',
  '        type: count',
  extraMeasure,
  '',
].filter((line) => line !== '').join('\n');

const customersCube = [
  'cubes:',
  '  - name: customers',
  '    sql_table: main.customers',
  '    dimensions:',
  '      - name: id',
  '        sql: id',
  '        type: number',
  '        primary_key: true',
  '      - name: name',
  '        sql: name',
  '        type: string',
  '',
].join('\n');

const lonelyCube = [
  'cubes:',
  '  - name: lonely',
  '    sql_table: main.customers',
  '    dimensions:',
  '      - name: id',
  '        sql: id',
  '        type: number',
  '        primary_key: true',
  '',
].join('\n');

const v1 = [
  { path: 'cubes/customers.yml', content: customersCube },
  { path: 'cubes/orders.yml', content: ordersCube() },
];
const v2 = [
  { path: 'cubes/customers.yml', content: customersCube },
  { path: 'cubes/orders.yml', content: ordersCube('      - name: total\n        sql: total_amount\n        type: sum') },
];

interface Instance {
  runtime: XcubeRuntime;
  core: XcubeServerCore;
  app: http.Server;
}

describeWithDatabase('xcube revisions, two Cube instances', () => {
  const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
  let modelDir: string;
  let driver: DuckDBDriver;
  let a: Instance;
  let b: Instance;
  const logs: string[] = [];

  const settings: XcubeSettings = {
    databaseUrl: DATABASE_URL!,
    schema,
    migrate: true,
    pollIntervalMs: 60000,
    pollIntervalDownMs: 1000,
    retireGraceMs: 60000,
    keepRevisions: 3,
    limits: { maxBytes: 1024 * 1024, maxFileBytes: 256 * 1024, maxFiles: 100, fileTypes: 'yaml' },
    compileQueue: 4,
    compileWaitMs: 60000,
    catchUpMs: 10000,
    adminTokens: [ADMIN_TOKEN],
    maxModels: 100,
    modules: { packMin: 50, packMax: 300 },
  };

  async function instance(name: string): Promise<Instance> {
    const runtime = new XcubeRuntime(settings, { logger: (message, params) => logs.push(`${name} ${message} ${JSON.stringify(params)}`) });
    await runtime.start();

    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const core = new XcubeServerCore(createConfig(runtime, {
      modelClaim: 'wechartModel',
      revisionClaim: 'wechartRevision',
    }, {
      apiSecret: API_SECRET,
      driverFactory: () => driver,
      schemaPath: path.relative(process.cwd(), modelDir),
      cacheAndQueueDriver: 'memory',
      devServer: false,
      telemetry: false,
      logger: () => undefined,
      contextToApiScopes: async (securityContext: any, defaults: any) => (
        securityContext?.wechartDraft ? [] : defaults
      ),
    }) as any);
    process.env.NODE_ENV = nodeEnv;

    await runtime.attach(core);
    const app = express();
    await core.initApp(app);
    return { runtime, core, app: app.listen(0) };
  }

  beforeAll(async () => {
    process.env.CUBEJS_DB_TYPE = 'duckdb';
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-disk-'));
    fs.writeFileSync(path.join(modelDir, 'disk.yml'), [
      'cubes:',
      '  - name: on_disk',
      '    sql_table: main.customers',
      '    measures:',
      '      - name: count',
      '        type: count',
      '',
    ].join('\n'));

    driver = new DuckDBDriver({
      initSql: [
        'CREATE TABLE main.customers (id INTEGER PRIMARY KEY, name VARCHAR)',
        'CREATE TABLE main.orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total_amount DECIMAL(10, 2))',
        "INSERT INTO main.customers VALUES (1, 'Ada'), (2, 'Grace')",
        'INSERT INTO main.orders VALUES (1, 1, 12.5), (2, 2, 30), (3, 1, 7.5)',
      ].join('; '),
    });

    a = await instance('a');
    b = await instance('b');
  });

  afterAll(async () => {
    for (const i of [a, b]) {
      i?.app.close();
      await i?.runtime.stop();
      await i?.core.shutdown();
    }
    await driver?.release();
    delete process.env.CUBEJS_DB_TYPE;
    fs.rmSync(modelDir, { recursive: true, force: true });
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  const token = (claims: object) => jwt.sign(claims, API_SECRET);
  const admin = (i: Instance) => ({
    put: (url: string, body: object) => request(i.app).put(url).set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body),
    get: (url: string) => request(i.app).get(url).set('Authorization', `Bearer ${ADMIN_TOKEN}`),
  });
  const snapshot = '/cubejs-api/v1/semantic/models/dev/snapshot';
  const meta = (i: Instance, claims: object) => request(i.app).get('/cubejs-api/v1/meta').set('Authorization', token(claims));
  const load = (i: Instance, claims: object, query: object) => request(i.app)
    .post('/cubejs-api/v1/load')
    .set('Authorization', token(claims))
    .send({ query });
  const measuresOf = (res: request.Response) => res.body.cubes
    .flatMap((cube: any) => cube.measures.map((m: any) => m.name))
    .sort();

  test('the first import creates revision 1, and both instances serve it', async () => {
    const res = await admin(a).put(snapshot, { baseRevision: null, files: v1, source: { reason: 'startup' } }).expect(201);
    expect(res.body).toMatchObject({ model: 'dev', revision: 1, created: true });
    expect(res.body.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // B hears of it by notification; the revision claim makes it wait for it.
    const fromB = await meta(b, { wechartModel: 'dev', wechartRevision: 1 }).expect(200);
    expect(measuresOf(fromB)).toEqual(['orders.count']);
    expect(fromB.headers['x-xcube-revision']).toBe('dev@1');
    expect(fromB.headers['x-xcube-generation']).toMatch(/^[0-9a-f-]{36}$/);

    const fromA = await meta(a, { wechartModel: 'dev' }).expect(200);
    expect(measuresOf(fromA)).toEqual(['orders.count']);
  });

  test('status names the current revision', async () => {
    const res = await admin(b).get('/cubejs-api/v1/semantic/models/dev/revision').expect(200);
    expect(res.body).toMatchObject({
      model: 'dev',
      current: { revision: 1, files: 2, source: { reason: 'startup' } },
      instance: { revision: 1, state: 'active' },
    });
    await admin(b).get('/cubejs-api/v1/semantic/models/nope/revision').expect(404);
  });

  test('the same content again changes nothing, whatever the base', async () => {
    const res = await admin(b).put(snapshot, { baseRevision: null, files: [...v1].reverse() }).expect(200);
    expect(res.body).toMatchObject({ revision: 1, created: false });
  });

  test('a stale base is a conflict', async () => {
    const res = await admin(a).put(snapshot, { baseRevision: null, files: v2 }).expect(409);
    expect(res.body).toMatchObject({ code: 'conflict', currentRevision: 1 });
  });

  test('a new revision is served at once to a request that names it, on the other instance', async () => {
    const created = await admin(a).put(snapshot, { baseRevision: 1, files: v2 }).expect(201);
    expect(created.body.revision).toBe(2);

    const res = await meta(b, { wechartModel: 'dev', wechartRevision: 2 }).expect(200);
    expect(measuresOf(res)).toEqual(['orders.count', 'orders.total']);
    expect(res.headers['x-xcube-revision']).toBe('dev@2');

    const data = await load(b, { wechartModel: 'dev', wechartRevision: 2 }, { measures: ['orders.total'] }).expect(200);
    expect(Number(data.body.data[0]['orders.total'])).toBe(50);
  });

  test('a snapshot that does not compile is refused, and nothing is stored', async () => {
    const broken = [
      { path: 'cubes/a.yml', content: 'cubes:\n  - name: a\n    sql_table: t\n   measures: []\n' },
      { path: 'cubes/b.yml', content: 'cubes:\n  - name: b\n  sql_table: t\n' },
    ];
    const yamlRes = await admin(a).put(snapshot, { baseRevision: 2, files: broken }).expect(422);
    expect(yamlRes.body.code).toBe('invalid_snapshot');
    expect(yamlRes.body.errors.map((e: any) => [e.path, e.kind, typeof e.line])).toEqual([
      ['cubes/a.yml', 'yaml', 'number'],
      ['cubes/b.yml', 'yaml', 'number'],
    ]);

    const undefinedMember = [
      ...v2,
      { path: 'cubes/views.yml', content: 'views:\n  - name: v\n    cubes:\n      - join_path: nope\n        includes: "*"\n' },
    ];
    const compileRes = await admin(a).put(snapshot, { baseRevision: 2, files: undefinedMember }).expect(422);
    expect(compileRes.body.errors.length).toBeGreaterThan(0);
    expect(compileRes.body.errors[0].kind).toBe('compile');
    expect(compileRes.body.cubeMessage).toMatch(/^Error: Compile errors:/);

    const status = await admin(a).get('/cubejs-api/v1/semantic/models/dev/revision').expect(200);
    expect(status.body.current.revision).toBe(2);
  });

  test('a dry run checks, runs probes on the candidate and the current revision, and stores nothing', async () => {
    const withLonely = [...v2, { path: 'cubes/lonely.yml', content: lonelyCube }];
    const res = await admin(b).put(`${snapshot}?dryRun=true`, {
      files: withLonely,
      securityContext: {},
      probes: [
        { id: 'fine', query: { measures: ['orders.count'], dimensions: ['customers.name'] } },
        { id: 'unjoinable', query: { measures: ['orders.count'], dimensions: ['lonely.id'] }, compare: true },
      ],
    }).expect(200);

    expect(res.body).toMatchObject({ valid: true, errors: [], currentRevision: 2, sameAsCurrent: false });
    expect(res.body.probes[0]).toEqual({ id: 'fine', candidate: { status: 200 } });
    expect(res.body.probes[1].candidate.status).toBe(400);
    expect(res.body.probes[1].candidate.error).toMatch(/join/i);
    // The current revision has no `lonely` at all: a different refusal.
    expect(res.body.probes[1].current.status).toBe(400);
    expect(res.body.probes[1].current.revision).toBe(2);
    expect(res.body.probes[1].current.error).not.toEqual(res.body.probes[1].candidate.error);

    const status = await admin(b).get('/cubejs-api/v1/semantic/models/dev/revision').expect(200);
    expect(status.body.current.revision).toBe(2);

    // The refusal is word for word what /v1/sql answers once that model is served.
    await admin(a).put(snapshot, { baseRevision: 2, files: withLonely }).expect(201);
    const live = await request(a.app)
      .get('/cubejs-api/v1/sql')
      .query({ query: JSON.stringify({ measures: ['orders.count'], dimensions: ['lonely.id'] }) })
      .set('Authorization', token({ wechartModel: 'dev', wechartRevision: 3 }))
      .expect(400);
    expect(live.body.error).toEqual(res.body.probes[1].candidate.error);
  });

  test('a dry run with a broken model reports it, and runs no probes', async () => {
    const res = await admin(a).put(`${snapshot}?dryRun=true`, {
      files: [{ path: 'm.yml', content: 'cubes:\n  - name: m\n    sql_table: t\n    measures:\n      - name: c\n        type: nope\n' }],
      probes: [{ id: 'x', query: { measures: ['m.c'] } }],
    }).expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.probes).toEqual([]);
    expect(res.body.errors[0]).toMatchObject({ kind: 'compile' });
  });

  test('tokens: no model is the disk model; an unknown or invalid model is refused', async () => {
    const disk = await meta(a, {}).expect(200);
    expect(disk.body.cubes.map((c: any) => c.name)).toEqual(['on_disk']);
    expect(disk.headers['x-xcube-revision']).toBe('disk');

    const unknown = await meta(a, { wechartModel: 'nobody' });
    expect(unknown.status).toBe(403);
    expect(unknown.body.error).toMatch(/Unknown model/);

    await meta(a, { wechartModel: 'Not A Model' }).expect(403);
    await meta(a, { wechartModel: 'dev', wechartRevision: 'x' }).expect(403);
  });

  test('a revision the database never had is answered from the current one', async () => {
    const res = await meta(a, { wechartModel: 'dev', wechartRevision: 99 }).expect(200);
    expect(res.headers['x-xcube-revision']).toBe('dev@3');
  });

  test('no request fails while revisions switch', async () => {
    let stop = false;
    const failures: string[] = [];
    let answered = 0;
    const loop = async (i: Instance) => {
      while (!stop) {
        try {
          const res = await load(i, { wechartModel: 'dev' }, { measures: ['orders.count'] });
          answered++;
          if (res.status !== 200 && res.body?.error !== 'Continue wait') {
            failures.push(`${res.status} ${JSON.stringify(res.body)}`);
          }
        } catch (e: any) {
          failures.push(`request failed: ${e.message}`);
        }
      }
    };
    const loops = [loop(a), loop(b), loop(a), loop(b)];

    let base = 3;
    for (const extra of ['a', 'b', 'c']) {
      const files = [...v2, { path: `cubes/extra_${extra}.yml`, content: lonelyCube.replace('lonely', `extra_${extra}`) }];
      const res = await admin(extra === 'b' ? b : a).put(snapshot, { baseRevision: base, files }).expect(201);
      base = res.body.revision;
      await meta(a, { wechartModel: 'dev', wechartRevision: base }).expect(200);
      await meta(b, { wechartModel: 'dev', wechartRevision: base }).expect(200);
    }
    stop = true;
    await Promise.all(loops);

    expect(failures).toEqual([]);
    expect(answered).toBeGreaterThan(10);
  });

  test('refresh contexts are pinned to each model\'s active revision', async () => {
    const contexts = await (a.core as any).options.scheduledRefreshContexts();
    expect(contexts).toEqual([
      { securityContext: {} },
      { securityContext: { wechartModel: 'dev' }, xcubePin: { model: 'dev', appId: expect.stringMatching(/^xcube:dev:6:/) } },
    ]);
  });

  test('retention keeps the newest revisions', async () => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT rev FROM ${schema}.revisions ORDER BY rev`);
      expect(rows.map((r) => r.rev)).toEqual([4, 5, 6]);
      const { rows: [{ orphans }] } = await client.query(
        `SELECT count(*)::int AS orphans FROM ${schema}.files f
          WHERE NOT EXISTS (SELECT 1 FROM ${schema}.revision_files rf WHERE rf.model = f.model AND rf.hash = f.hash)`
      );
      expect(orphans).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('queries keep being answered with every database connection gone', async () => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE application_name LIKE 'xcube%' AND pid <> pg_backend_pid()`
      );
    } finally {
      await client.end();
    }
    const res = await load(b, { wechartModel: 'dev' }, { measures: ['orders.total'] }).expect(200);
    expect(Number(res.body.data[0]['orders.total'])).toBe(50);
  });
});
