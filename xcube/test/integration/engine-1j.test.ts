/**
 * What wechart's sub-phase 1j relies on, on a stand-in for its engine (a
 * real DuckDB in this process behind the engine's routes), modelled as
 * wechart generates its cubes: tables `main.t_<32 hex>` with columns
 * `"c_<32 hex>"`, a hidden primary key `sf__row` over `__sf_row`, and each
 * cube's refresh key read from the engine's catalog (`sf_table_version`).
 * Runs when XCUBE_TEST_DATABASE_URL names a Postgres, for xcube's store.
 *
 * - C1: the refresh key is published, sent to the engine as written, and
 *   read again before an answer once it expires (R9); the refresh worker's
 *   cycle runs it.
 * - C2–C5: row-sets over a hidden key, a view without the key, a measure
 *   that aggregates in its own SQL, no measures, and a date range alone.
 * - C6: the engine's error code reaches the client of `/v1/load`.
 * - C7: `/v1/cubesql` answers over an engine cube.
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

const API_SECRET = 'engine-1j-test-secret';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef-engine-1j';

const FACTS_ID = '0123456789abcdef0123456789abcdef';
const REGIONS_ID = 'fedcba9876543210fedcba9876543210';
/** A column as wechart names it: `c_` and 32 hex digits. */
const col = (n: number) => `c_${n.toString(16).padStart(32, '0')}`;
const refreshKeySql = (id: string) => `SELECT sf_table_version('${id}') AS refresh_key`;

const TABLES = [
  `CREATE TABLE main.sf_versions (id VARCHAR, v BIGINT)`,
  `INSERT INTO main.sf_versions VALUES ('${FACTS_ID}', 1), ('${REGIONS_ID}', 1)`,
  `CREATE MACRO sf_table_version(tid) AS (SELECT v FROM main.sf_versions WHERE id = tid)`,
  `CREATE TABLE main.t_${FACTS_ID} AS SELECT * FROM (VALUES
    (1, 'east', 10.0, 2.0, TIMESTAMP '2024-01-15 10:00:00'),
    (2, 'east', 4.0, 1.0, TIMESTAMP '2024-02-03 00:00:00'),
    (3, 'west', 7.0, 7.0, TIMESTAMP '2024-02-20 12:00:00'),
    (4, 'west', 2.0, 4.0, TIMESTAMP '2024-03-01 08:00:00')
  ) AS t(__sf_row, "${col(1)}", "${col(2)}", "${col(3)}", "${col(4)}")`,
  `CREATE TABLE main.t_${REGIONS_ID} AS SELECT * FROM (VALUES
    (1, 'east', 'East'), (2, 'west', 'West')
  ) AS t(__sf_row, "${col(1)}", "${col(5)}")`,
];

const FACTS = `cubes:
  - name: facts
    sql_table: main.t_${FACTS_ID}
    refresh_key:
      sql: "${refreshKeySql(FACTS_ID)}"
      every: 1 second
    joins:
      - name: regions
        relationship: many_to_one
        sql: '{CUBE}."${col(1)}" = {regions}."${col(1)}"'
    dimensions:
      - { name: sf__row, sql: '{CUBE}.__sf_row', type: number, primary_key: true, public: false }
      - { name: region, sql: '{CUBE}."${col(1)}"', type: string }
      - { name: at, sql: '{CUBE}."${col(4)}"', type: time }
    measures:
      - { name: total, sql: '{CUBE}."${col(2)}"', type: sum }
      - { name: weight, sql: '{CUBE}."${col(3)}"', type: sum }
      - { name: count, type: count }
      - { name: per_weight, sql: "{total} / {weight}", type: number }
      - { name: ratio, sql: 'sum({CUBE}."${col(2)}") / sum({CUBE}."${col(3)}")', type: number }
      - { name: ratio_twice, sql: "{ratio} * 2", type: number }
      - { name: p90, sql: 'quantile_cont({CUBE}."${col(2)}", 0.9)', type: number }
`;

const REGIONS = `cubes:
  - name: regions
    sql_table: main.t_${REGIONS_ID}
    refresh_key:
      sql: "${refreshKeySql(REGIONS_ID)}"
      every: 1 second
    dimensions:
      - { name: sf__row, sql: '{CUBE}.__sf_row', type: number, primary_key: true, public: false }
      - { name: code, sql: '{CUBE}."${col(1)}"', type: string }
      - { name: label, sql: '{CUBE}."${col(5)}"', type: string }
    measures:
      - { name: count, type: count }
`;

const VIEW = `views:
  - name: v_facts
    cubes:
      - join_path: facts
        includes: [region, at, total, weight, count, per_weight]
      - join_path: facts.regions
        prefix: true
        includes: [label]
`;

describeWithDatabase('wechart\'s sub-phase 1j on its engine', () => {
  const schema = `xcube_t_${crypto.randomBytes(4).toString('hex')}`;
  const allowHttp = process.env.XCUBE_ENGINE_ALLOW_HTTP;
  let engine: Awaited<ReturnType<typeof standInEngine>>;
  let keysDir: string;
  let modelDir: string;
  let runtime: XcubeRuntime;
  let core: XcubeServerCore;
  let server: http.Server;
  let sqlInterface: Awaited<ReturnType<XcubeServerCore['initSqlInterface']>> | undefined;
  let revision: number;

  const admin = (method: 'put' | 'post', route: string, body: object) => request(server)[method](`/cubejs-api/v1/semantic/models/dev${route}`)
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .send(body);
  const snapshot = (facts: string, baseRevision: number | null) => admin('put', '/snapshot', {
    baseRevision,
    folders: [{ id: 'froot', parentId: null }],
    items: [
      { folderId: 'froot', name: 'facts', kind: 'cube', yaml: facts },
      { folderId: 'froot', name: 'regions', kind: 'cube', yaml: REGIONS },
      { folderId: 'froot', name: 'v_facts', kind: 'view', yaml: VIEW },
    ],
  });

  beforeAll(async () => {
    process.env.XCUBE_ENGINE_ALLOW_HTTP = 'true';
    engine = await standInEngine(TABLES);
    keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-credential-keys-'));
    const key = generateCredentialKey();
    fs.writeFileSync(path.join(keysDir, `${key.kid}.pem`), key.pem);
    fs.writeFileSync(path.join(keysDir, `${key.kid}.check`), key.check);
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-engine-1j-'));
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
    // As XcubeServer.listen starts it: Cube's SQL interface, with no Postgres-wire port.
    sqlInterface = await core.initSqlInterface({});
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
  });

  afterAll(async () => {
    server?.close();
    await sqlInterface?.shutdown('fast');
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
  const load = (query: object) => request(server).post('/cubejs-api/v1/load').set('Authorization', token()).send({ query });
  const loaded = async (query: object) => {
    const answer = await load(query);
    expect({ status: answer.status, error: answer.body.error }).toEqual({ status: 200, error: undefined });
    return answer.body.data as Record<string, unknown>[];
  };
  const rowSet = (query: object) => request(server).post('/cubejs-api/v1/row-set').set('Authorization', token()).send({ query });
  const run = async (sql: string, params: unknown[] = []) => {
    const reader = await engine.connection.runAndReadAll(sql, params as any);
    return reader.getRowObjectsJS() as Record<string, unknown>[];
  };
  const posted = () => engine.calls.filter((c) => c.method === 'POST' && c.url === '/v1/query');
  const refreshKeyCalls = () => posted().filter((c) => c.body.sql.includes('sf_table_version('));
  const bump = async (id: string, amount: number) => {
    await engine.connection.run(`UPDATE main.t_${FACTS_ID} SET "${col(2)}" = "${col(2)}" + ${amount}`);
    await engine.connection.run(`UPDATE main.sf_versions SET v = v + 1 WHERE id = '${id}'`);
  };
  const totalOf = (rows: Record<string, unknown>[]) => Number(rows[0]['facts.total']);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  describe('C1: a refresh key read from the engine', () => {
    test('(a) publish accepts it, and (b) the engine is sent it exactly as written', async () => {
      const published = await snapshot(FACTS, null);
      expect({ status: published.status, body: published.status === 201 ? undefined : published.body }).toEqual({ status: 201, body: undefined });
      revision = published.body.revision;
      const before = posted().length;
      expect(totalOf(await loaded({ measures: ['facts.total'] }))).toBe(23);
      const sent = posted().slice(before).filter((c) => c.body.sql.includes('sf_table_version('));
      expect(sent.length).toBeGreaterThanOrEqual(1);
      for (const call of sent) {
        expect({ sql: call.body.sql, params: call.body.params }).toEqual({ sql: refreshKeySql(FACTS_ID), params: [] });
      }
    });

    test('(c) after the version changes, no-cache answers fresh rows at once', async () => {
      expect(totalOf(await loaded({ measures: ['facts.total'] }))).toBe(23);
      await bump(FACTS_ID, 1);
      const fresh = await request(server).post('/cubejs-api/v1/load').set('Authorization', token())
        .send({ query: { measures: ['facts.total'] }, cache: 'no-cache' });
      expect(fresh.status).toBe(200);
      expect(Number(fresh.body.data[0]['facts.total'])).toBe(27);
    });

    test('(d) with the default cache mode, the first request a second past the change answers fresh rows (R9)', async () => {
      for (let i = 0; i < 4; i++) {
        const before = totalOf(await loaded({ measures: ['facts.total'] }));
        await bump(FACTS_ID, 1);
        await sleep(1100);
        // On an engine, an expired refresh key is read before the answer, not renewed behind it.
        expect(totalOf(await loaded({ measures: ['facts.total'] }))).toBe(before + 4);
        expect(totalOf(await loaded({ measures: ['facts.total'] }))).toBe(before + 4);
      }
    });

    test('(e) the refresh worker\'s cycle runs, sending each cube\'s refresh key', async () => {
      const contexts = (await runtime.refreshContexts()).filter((c: any) => c.securityContext?.wechartModel === 'dev');
      expect(contexts.length).toBeGreaterThanOrEqual(1);
      const counts: number[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        // Past every refresh key's `every`.
        await sleep(1100);
        const before = refreshKeyCalls().length;
        const queriesBefore = posted().length;
        for (const context of contexts) {
          const result = await core.runScheduledRefresh(context, { throwErrors: true });
          expect(result).toEqual({ finished: true });
        }
        const sent = refreshKeyCalls().slice(before);
        counts.push(sent.length);
        expect(new Set(sent.map((c) => c.body.sql))).toEqual(new Set([refreshKeySql(FACTS_ID), refreshKeySql(REGIONS_ID)]));
        // Only refresh keys: the worker runs no data query on a model without rollups.
        expect(posted().length - queriesBefore).toBe(sent.length);
      }
      // eslint-disable-next-line no-console
      console.info(`C1 (e): refresh-key statements per cycle, ${contexts.length} context(s): ${counts.join(', ')}`);
    });
  });

  describe('C2–C5: row-sets', () => {
    test('C2: a hidden key is in the SQL and in keys, through the cube and through a view without it', async () => {
      const direct = await rowSet({ measures: ['facts.total'], dimensions: ['facts.region'] });
      expect({ status: direct.status, body: direct.status === 200 ? undefined : direct.body }).toEqual({ status: 200, body: undefined });
      expect(direct.body.keys).toEqual({ facts: ['facts__sf__row'] });
      expect(direct.body.rowSet.sql).toContain('__sf_row');
      const rows = await run(direct.body.rowSet.sql, direct.body.rowSet.params);
      expect(rows.map((r) => Number(r.facts__sf__row)).sort()).toEqual([1, 2, 3, 4]);

      const viaView = await rowSet({ measures: ['v_facts.total'], dimensions: ['v_facts.region', 'v_facts.regions_label'] });
      expect({ status: viaView.status, body: viaView.status === 200 ? undefined : viaView.body }).toEqual({ status: 200, body: undefined });
      const { keys, aliasToMember, rowSet: set } = viaView.body;
      expect(Object.keys(keys).sort()).toEqual(['facts', 'regions']);
      for (const alias of Object.values<string[]>(keys).flat()) {
        expect(aliasToMember[alias]).toBeDefined();
      }
      expect(set.sql).toContain('__sf_row');
      const viewRows = await run(set.sql, set.params);
      expect(viewRows).toHaveLength(4);
      expect(viewRows.map((r) => Number(r[keys.facts[0]])).sort()).toEqual([1, 2, 3, 4]);
    });

    test('C3: a number measure whose own SQL aggregates is refused with a reason; one over measures is answered', async () => {
      for (const measure of ['facts.ratio', 'facts.p90']) {
        const refused = await rowSet({ measures: [measure], dimensions: ['facts.region'] });
        expect({ status: refused.status, code: refused.body.code, members: refused.body.refusals?.map((r: any) => r.member) })
          .toEqual({ status: 400, code: 'unsupported_measure', members: [measure] });
        expect(refused.body.refusals[0].reason).toEqual(expect.any(String));
      }
      const through = await rowSet({ measures: ['facts.ratio_twice'] });
      expect({ status: through.status, code: through.body.code }).toEqual({ status: 400, code: 'unsupported_measure' });
      expect(through.body.refusals).toEqual([{ member: 'facts.ratio_twice', reason: expect.stringMatching(/^it reads facts\.ratio: /) }]);
      const answered = await rowSet({ measures: ['facts.per_weight'], dimensions: ['facts.region'] });
      expect(answered.status).toBe(200);
      expect(answered.body.rowSet.sql).not.toMatch(/\bsum\s*\(/i);
      expect(answered.body.measures['facts.per_weight'].leaves.map((l: any) => l.member)).toEqual(['facts.total', 'facts.weight']);
    });

    test('C4: dimensions and no measure, and the key alone, are answered', async () => {
      const dims = await rowSet({ dimensions: ['facts.region'] });
      expect({ status: dims.status, body: dims.status === 200 ? undefined : dims.body }).toEqual({ status: 200, body: undefined });
      expect(dims.body.measures).toEqual({});
      expect(await run(dims.body.rowSet.sql, dims.body.rowSet.params)).toHaveLength(4);

      const keyOnly = await rowSet({ dimensions: ['facts.sf__row'] });
      expect({ status: keyOnly.status, body: keyOnly.status === 200 ? undefined : keyOnly.body }).toEqual({ status: 200, body: undefined });
      expect(keyOnly.body.keys).toEqual({ facts: ['facts__sf__row'] });
      expect(Object.keys(keyOnly.body.aliasToMember)).toEqual(['facts__sf__row']);
      expect(await run(keyOnly.body.rowSet.sql, keyOnly.body.rowSet.params)).toHaveLength(4);
    });

    test('C5: a date range with no granularity filters the rows, with no bucket column', async () => {
      const answer = await rowSet({
        measures: ['facts.total'],
        timeDimensions: [{ dimension: 'facts.at', dateRange: ['2024-02-01', '2024-02-29'] }],
      });
      expect({ status: answer.status, body: answer.status === 200 ? undefined : answer.body }).toEqual({ status: 200, body: undefined });
      expect(Object.values(answer.body.aliasToMember).some((m: any) => m.startsWith('facts.at'))).toBe(false);
      const rows = await run(answer.body.rowSet.sql, answer.body.rowSet.params);
      expect(rows.map((r) => Number(r.facts__sf__row)).sort()).toEqual([2, 3]);
      expect(Object.keys(rows[0]).sort()).toEqual(Object.keys(answer.body.aliasToMember).sort());
    });
  });

  describe('C6: the engine\'s error code reaches /v1/load\'s client', () => {
    const cases: [number, string][] = [
      [504, 'timeout'], [409, 'cancelled'], [503, 'over_budget'], [422, 'query_failed'], [403, 'table_out_of_scope'],
    ];
    afterEach(() => engine.intercept(undefined));
    test.each(cases)('%i %s', async (status, code) => {
      const marker = `c6_${code}`;
      engine.intercept((body) => ((body.params ?? []).includes(marker) ? { status, body: { error: `The engine says ${code}`, code } } : undefined));
      const answer = await load({
        measures: ['facts.total'],
        filters: [{ member: 'facts.region', operator: 'notEquals', values: [marker] }],
      });
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(answer.body.error).toContain(`The engine says ${code}`);
      expect(answer.body.engineCode).toBe(code);
    });
  });

  test('C7: /v1/cubesql answers one SELECT over an engine cube', async () => {
    const res = await request(server).post('/cubejs-api/v1/cubesql').set('Authorization', token())
      .send({ query: 'SELECT region, MEASURE(total) AS total FROM facts GROUP BY 1 ORDER BY 1' })
      .buffer(true)
      .parse((r: any, cb: any) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (chunk: string) => { text += chunk; });
        r.on('end', () => cb(null, text));
      });
    const lines = (res.body as string).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect({ status: res.status, error: lines.find((l) => l.error)?.error }).toEqual({ status: 200, error: undefined });
    const data = lines.flatMap((l) => l.data ?? []);
    expect(data.map((row: any[]) => [row[0], Number(row[1])])).toEqual([['east', 24], ['west', 19]]);
  });
});
