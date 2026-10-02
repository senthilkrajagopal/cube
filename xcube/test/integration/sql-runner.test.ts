/**
 * The SQL runner end to end: read-only SQL on a model's connection, on one an
 * overlay brings, and on Cube Store, under the admin credential. The
 * PostgreSQL data source is the test database itself. Each other server runs
 * its part when given:
 *
 *   XCUBE_TEST_DATABASE_URL        xcube's store (Postgres), always needed
 *   INTROSPECTION_TEST_MYSQL       a MySQL as host:port (user root, password test, database test)
 *   XCUBE_TEST_DREMIO_URL          a Dremio Software, its first user made by connection-drivers.test.ts or here
 *   XCUBE_TEST_CUBESTORE           a Cube Store as host:port (docker run cubejs/cubestore)
 *   XCUBE_TEST_MSSQL               a SQL Server as host:port (user sa, password Xcube-test-Pass1)
 *   XCUBE_TEST_ORACLE              an Oracle as host:port (gvenzl/oracle-free: PDB FREEPDB1, user xcube, password xcube_test_pass1)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import bodyParser from 'body-parser';
import express from 'express';
import request from 'supertest';
import { Client } from 'pg';

import {
  createConfig, generateCredentialKey, sealSecretV1, XcubeRuntime, XcubeServerCore, type XcubeSettings,
} from '../../src';
import { initAdminRoutes } from '../../src/admin/routes';

const DATABASE_URL = process.env.XCUBE_TEST_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;
const MYSQL = process.env.INTROSPECTION_TEST_MYSQL;
const DREMIO_URL = process.env.XCUBE_TEST_DREMIO_URL;
const CUBESTORE = process.env.XCUBE_TEST_CUBESTORE;
const MSSQL = process.env.XCUBE_TEST_MSSQL;
const ORACLE = process.env.XCUBE_TEST_ORACLE;

jest.setTimeout(180 * 1000);

const ADMIN_TOKEN = 'admin-token-0123456789abcdef-sql-runner';
const PASSWORD_MARK = 'sql-runner-wrong-password-4711';

describeWithDatabase('the SQL runner: read-only SQL on a model\'s data sources and Cube Store', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const schema = `xcube_t_${suffix}`;
  const warehouse = `sqlr_w_${suffix}`;
  const workspaceDb = `sqlr_ws_${suffix}`;
  const model = `sqlr-${suffix}`;
  const url = new URL(DATABASE_URL ?? 'postgres://x@localhost/x');
  const target = { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), ssl: false };
  const logs: { message: string; params: any }[] = [];
  let keysDir: string;
  let key: ReturnType<typeof generateCredentialKey>;
  let modelDir: string;
  let runtime: XcubeRuntime;
  let other: XcubeRuntime;
  let core: XcubeServerCore;
  let server: http.Server;
  let otherServer: http.Server;
  let cubeStore: any;

  const sql = async (text: string, database?: string) => {
    const at = new URL(DATABASE_URL!);
    if (database) {
      at.pathname = `/${database}`;
    }
    const client = new Client({ connectionString: at.toString() });
    await client.connect();
    try {
      return (await client.query(text)).rows;
    } finally {
      await client.end();
    }
  };

  const settingsOf = (): XcubeSettings => ({
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
  });

  beforeAll(async () => {
    await sql(`CREATE SCHEMA ${warehouse};
      CREATE TABLE ${warehouse}.orders (id int PRIMARY KEY, customer text, amount numeric(10, 2), placed_at timestamptz);
      INSERT INTO ${warehouse}.orders SELECT n, 'c' || (n % 7), n * 1.5, timestamptz '2024-01-01' + n * interval '1 day' FROM generate_series(1, 50) n;
      CREATE TABLE ${warehouse}.audit (n int);
      CREATE SEQUENCE ${warehouse}.seq;
      CREATE FUNCTION ${warehouse}.writes() RETURNS int LANGUAGE sql VOLATILE AS $$ INSERT INTO ${warehouse}.audit VALUES (1) RETURNING 1 $$;`);
    await sql(`CREATE DATABASE ${workspaceDb}`);
    await sql('CREATE TABLE notes (id int, body text); INSERT INTO notes VALUES (1, \'from the workspace\');', workspaceDb);

    keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-credential-keys-'));
    key = generateCredentialKey();
    fs.writeFileSync(path.join(keysDir, `${key.kid}.pem`), key.pem);
    fs.writeFileSync(path.join(keysDir, `${key.kid}.check`), key.check);
    modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcube-sql-runner-'));

    runtime = new XcubeRuntime(settingsOf(), { logger: () => undefined });
    await runtime.start();
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const [csHost, csPort] = (CUBESTORE ?? '').split(':');
    // eslint-disable-next-line global-require
    const { CubeStoreDriver } = require('@cubejs-backend/cubestore-driver');
    const options = createConfig(runtime, { modelClaim: 'wechartModel', revisionClaim: 'wechartRevision' }, {
      apiSecret: 'sql-runner-test-secret',
      schemaPath: path.relative(process.cwd(), modelDir),
      cacheAndQueueDriver: 'memory',
      devServer: false,
      telemetry: false,
      logger: (message: string, params: any) => logs.push({ message, params }),
      ...(CUBESTORE ? {
        externalDbType: 'cubestore',
        externalDriverFactory: () => new CubeStoreDriver({ host: csHost, port: Number(csPort) }),
      } : {}),
    });
    core = new XcubeServerCore(options);
    process.env.NODE_ENV = nodeEnv;
    await runtime.attach(core);
    const app = express();
    app.use(bodyParser.json({ limit: '50mb' }));
    await core.initApp(app);
    server = app.listen(0);

    // A second instance, sharing xcube's database: its admin routes alone.
    other = new XcubeRuntime(settingsOf(), { logger: () => undefined });
    await other.start();
    const otherApp = express();
    initAdminRoutes(otherApp, '/cubejs-api', other, () => undefined);
    otherServer = otherApp.listen(0);

    if (CUBESTORE) {
      cubeStore = new CubeStoreDriver({ host: csHost, port: Number(csPort) });
      await cubeStore.query(`CREATE SCHEMA IF NOT EXISTS sqlr_${suffix}`, []);
      await cubeStore.query(`CREATE TABLE sqlr_${suffix}.t (a int, b text)`, []);
      await cubeStore.query(`INSERT INTO sqlr_${suffix}.t (a, b) VALUES (1, 'x'), (3, 'y'), (2, 'z')`, []);
    }
  });

  afterAll(async () => {
    server?.close();
    otherServer?.close();
    await other?.stop();
    await runtime?.stop();
    await core?.shutdown();
    if (cubeStore) {
      await cubeStore.query(`DROP TABLE sqlr_${suffix}.t`, []).catch(() => undefined);
      await cubeStore.release();
    }
    fs.rmSync(modelDir, { recursive: true, force: true });
    fs.rmSync(keysDir, { recursive: true, force: true });
    await sql(`DROP DATABASE IF EXISTS ${workspaceDb} WITH (FORCE)`).catch(() => undefined);
    await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${warehouse} CASCADE;`).catch(() => undefined);
  });

  const base = `/cubejs-api/v1/semantic/models/${model}`;
  const admin = (method: 'put' | 'post' | 'get' | 'delete', route: string, body?: object, at: http.Server = server) => {
    const req = request(at)[method](`${base}${route}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    return body ? req.send(body) : req;
  };
  const seal = (secret: string, fields: object, driver: any = 'postgres', field = 'password') => sealSecretV1(key.jwk.x, key.kid, driver, field, fields as any, secret);
  const pgConnection = (password = decodeURIComponent(url.password), fields: object = target) => ({
    folderId: 'froot',
    driver: 'postgres',
    authMethod: 'password',
    fields: { ...fields, user: url.username },
    sealed: { password: seal(password, fields) },
  });
  const run = (name: string, body: object, query = '') => admin('post', `/connections/${name}/sql${query}`, { runId: crypto.randomUUID(), ...body });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test('the model, its data source, and a second one whose password is wrong', async () => {
    await admin('put', '/connections/default', pgConnection()).expect(200);
    await admin('put', '/connections/broken', pgConnection(PASSWORD_MARK)).expect(200);
    const published = await admin('put', '/snapshot', {
      baseRevision: null,
      folders: [{ id: 'froot', parentId: null }, { id: 'fsales', parentId: 'froot' }],
      items: [{
        folderId: 'froot',
        name: 'orders',
        kind: 'cube',
        yaml: `cubes:\n  - name: orders\n    sql_table: ${warehouse}.orders\n    measures:\n      - name: count\n        type: count\n`,
      }],
    });
    expect({ status: published.status, body: published.status === 201 ? null : published.body }).toEqual({ status: 201, body: null });
  });

  test('a SELECT answers its columns with the database\'s types, its rows as arrays, and its SQL redacted', async () => {
    const res = await run('default', {
      sql: `SELECT id, customer, amount, placed_at, id AS id FROM ${warehouse}.orders WHERE customer = 'c3' ORDER BY id LIMIT 2`,
    }).expect(200);
    expect(res.body).toEqual({
      columns: [
        { name: 'id', type: 'int4' }, { name: 'customer', type: 'text' }, { name: 'amount', type: 'numeric' },
        { name: 'placed_at', type: 'timestamptz' }, { name: 'id', type: 'int4' },
      ],
      rows: [[3, 'c3', '4.50', '2024-01-04T00:00:00.000', 3], [10, 'c3', '15.00', '2024-01-11T00:00:00.000', 10]],
      rowCount: 2,
      truncated: null,
      durationMs: expect.any(Number),
      statement: 'select',
      redactedSql: `SELECT id, customer, amount, placed_at, id AS id FROM ${warehouse}.orders WHERE customer = ? ORDER BY id LIMIT ?`,
    });
    const explained = await run('default', { sql: `EXPLAIN SELECT * FROM ${warehouse}.orders` }).expect(200);
    expect(explained.body).toMatchObject({ statement: 'explain', columns: [{ name: 'QUERY PLAN', type: 'text' }] });
    expect(explained.body.rows[0][0]).toMatch(/Seq Scan/);
  });

  test('rows stop at the row cap, or at the byte cap, and say which', async () => {
    const capped = await run('default', { sql: `SELECT * FROM ${warehouse}.orders ORDER BY id`, maxRows: 10 }).expect(200);
    expect(capped.body).toMatchObject({ rowCount: 10, truncated: 'rows' });
    expect(capped.body.rows.map((r: any[]) => r[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const exact = await run('default', { sql: `SELECT * FROM ${warehouse}.orders`, maxRows: 50 }).expect(200);
    expect(exact.body).toMatchObject({ rowCount: 50, truncated: null });
    const small = await run('default', { sql: `SELECT * FROM ${warehouse}.orders ORDER BY id`, maxBytes: 1024 }).expect(200);
    expect(small.body.truncated).toBe('bytes');
    expect(small.body.rowCount).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(small.body.rows))).toBeLessThan(1024);
  });

  test('read-only in layers: the check refuses what isn\'t one read; the read-only transaction what calls a write', async () => {
    const del = await run('default', { sql: `DELETE FROM ${warehouse}.orders WHERE customer = 'c1'` }).expect(400);
    expect(del.body).toMatchObject({
      code: 'not_read_only', statement: 'delete', redactedSql: `DELETE FROM ${warehouse}.orders WHERE customer = ?`,
    });
    const two = await run('default', { sql: 'SELECT 1; DROP TABLE x' }).expect(400);
    expect(two.body).toMatchObject({ code: 'several_statements' });
    const cte = await run('default', { sql: `WITH d AS (DELETE FROM ${warehouse}.orders RETURNING *) SELECT * FROM d` }).expect(400);
    expect(cte.body.code).toBe('not_read_only');
    const terminate = await run('default', { sql: 'SELECT pg_terminate_backend(pg_backend_pid())' }).expect(400);
    expect(terminate.body.error).toMatch(/pg_terminate_backend/);
    // Past the check: the database refuses the write the function makes.
    const viaFunction = await run('default', { sql: `SELECT ${warehouse}.writes()` }).expect(422);
    expect(viaFunction.body).toMatchObject({ code: 'query_failed', error: expect.stringMatching(/read-only transaction/) });
    const sequence = await run('default', { sql: `SELECT nextval('${warehouse}.seq')` }).expect(422);
    expect(sequence.body.error).toMatch(/read-only transaction/);
    expect(await sql(`SELECT count(*)::int AS n FROM ${warehouse}.audit`)).toEqual([{ n: 0 }]);
    expect(await sql(`SELECT count(*)::int AS n FROM ${warehouse}.orders`)).toEqual([{ n: 50 }]);
  });

  test('the time cap stops the statement on the database', async () => {
    const started = Date.now();
    const res = await run('default', { sql: 'SELECT pg_sleep(10)', timeoutMs: 1000 }).expect(422);
    expect(res.body).toMatchObject({ code: 'timeout', statement: 'select', redactedSql: 'SELECT pg_sleep(?)' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('a run stopped at its time cap answers the rows read before, marked stopped', async () => {
    const res = await run('default', {
      sql: 'SELECT g, CASE WHEN g > 3 THEN pg_sleep(3)::text END AS slept FROM generate_series(1, 10) g', timeoutMs: 2000,
    }).expect(422);
    expect(res.body).toMatchObject({
      code: 'timeout',
      columns: [{ name: 'g', type: 'int4' }, { name: 'slept', type: 'text' }],
      rows: [[1, null], [2, null], [3, null]],
      rowCount: 3,
      truncated: 'stopped',
    });
    // Stopped before a row: none, and the columns as far as known.
    const none = await run('default', { sql: 'SELECT pg_sleep(5)::text AS slept', timeoutMs: 1000 }).expect(422);
    expect(none.body).toMatchObject({ code: 'timeout', rows: [], rowCount: 0, truncated: 'stopped' });
  });

  test('a run is cancelled by its id, here or from another instance, and stops on the database', async () => {
    const cancelFrom = async (at: http.Server) => {
      const runId = crypto.randomUUID();
      const slow = 'SELECT g, CASE WHEN g > 2 THEN pg_sleep(20)::text END AS slept FROM generate_series(1, 5) g';
      const running = admin('post', '/connections/default/sql', { runId, sql: slow }).then((r) => r);
      for (let i = 0; i < 50 && !(await sql(`SELECT 1 FROM pg_stat_activity WHERE query = '${slow}'`)).length; i++) {
        await sleep(100);
      }
      const started = Date.now();
      const cancelled = await admin('post', '/sql/cancel', { runId }, at).expect(200);
      expect(cancelled.body).toEqual({ model, runId, found: true });
      const res = await running;
      expect(res.status).toBe(422);
      // The rows read before the cancel come back with it, from either instance.
      expect(res.body).toMatchObject({ code: 'cancelled', rows: [[1, null], [2, null]], rowCount: 2, truncated: 'stopped' });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(await sql(`SELECT 1 FROM pg_stat_activity WHERE query = '${slow}'`)).toEqual([]);
    };
    await cancelFrom(server);
    await cancelFrom(otherServer);
    expect((await admin('post', '/sql/cancel', { runId: 'no-such-run' }).expect(200)).body).toEqual({ model, runId: 'no-such-run', found: false });
  });

  test('one run per id at a time', async () => {
    const runId = crypto.randomUUID();
    const first = admin('post', '/connections/default/sql', { runId, sql: 'SELECT pg_sleep(1)' }).then((r) => r);
    await sleep(300);
    const second = await admin('post', '/connections/default/sql', { runId, sql: 'SELECT 1' }).expect(409);
    expect(second.body.code).toBe('run_in_progress');
    expect((await first).status).toBe(200);
    await admin('post', '/connections/default/sql', { runId, sql: 'SELECT 1' }).expect(200);
  });

  test('connecting fails with the password never shown; what isn\'t there is 404; bad requests 400', async () => {
    const res = await run('broken', { sql: 'SELECT 1' }).expect(502);
    expect(res.body).toMatchObject({ code: 'connect_failed', error: expect.stringMatching(/password authentication failed/) });
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD_MARK);
    expect((await run('nothing', { sql: 'SELECT 1' }).expect(404)).body.code).toBe('unknown_connection');
    await request(server).post('/cubejs-api/v1/semantic/models/no-such-model/connections/default/sql')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ runId: 'r1', sql: 'SELECT 1' })
      .expect(404);
    expect((await run('default', { sql: 'SELECT 1' }, '?overlay=bad id').expect(400)).body.code).toBe('invalid_overlay_id');
    expect((await admin('post', '/connections/default/sql', { sql: 'SELECT 1' }).expect(400)).body.code).toBe('bad_request');
    expect((await run('default', { sql: 'SELECT 1', maxRows: 1000000 }).expect(400)).body.code).toBe('bad_request');
    await request(server).post(`${base}/connections/default/sql`).send({ runId: 'r2', sql: 'SELECT 1' }).expect(401);
  });

  test('an overlay\'s own data source, addressed by the overlay and the name its previews use', async () => {
    const fields = { ...target, database: workspaceDb };
    await admin('put', '/overlays/ws-1', {
      connections: [{ ...pgConnection(undefined, fields), folderId: 'fsales', name: 'scratch' }],
    }).expect(201);
    const res = await run('fsales__scratch', { sql: 'SELECT body FROM notes' }, '?overlay=ws-1').expect(200);
    expect(res.body.rows).toEqual([['from the workspace']]);
    expect((await run('fsales__scratch', { sql: 'SELECT 1' }).expect(404)).body.code).toBe('unknown_connection');
    expect((await run('default', { sql: 'SELECT 1' }, '?overlay=ws-1').expect(404)).body.code).toBe('unknown_connection');
    expect((await run('fsales__scratch', { sql: 'SELECT 1' }, '?overlay=ws-2').expect(404)).body.code).toBe('unknown_overlay');
  });

  test('the logs name the run and how it ended, never its SQL', () => {
    const runs = logs.filter((l) => l.message === 'xcube: SQL run');
    expect(runs.length).toBeGreaterThan(5);
    expect(runs.find((l) => l.params.outcome === 'not_read_only')?.params).toMatchObject({ model, target: 'default' });
    const text = JSON.stringify(logs);
    expect(text).not.toContain('customer = \'c3\'');
    expect(text).not.toContain('DELETE FROM');
    expect(text).not.toContain(PASSWORD_MARK);
  });

  (MYSQL ? test : test.skip)('MySQL: a read-only transaction, its own quoting, the caps, and a cancel', async () => {
    const [host, port] = MYSQL!.split(':');
    const fields = { host, port: Number(port || 3306), database: 'test', ssl: false };
    await admin('put', '/connections/mysql', {
      folderId: 'froot', driver: 'mysql', authMethod: 'password', fields: { ...fields, user: 'root' }, sealed: { password: seal('test', fields, 'mysql') },
    }).expect(200);
    const res = await run('mysql', { sql: 'SELECT 1 AS a, \'it\\\'s\' AS b, "x" AS c UNION ALL SELECT 2, \'y\', "z"' }).expect(200);
    expect(res.body).toMatchObject({
      // A 64-bit integer as a string, as PostgreSQL's int8: no precision lost.
      columns: [{ name: 'a', type: 'LONGLONG' }, { name: 'b', type: 'VAR_STRING' }, { name: 'c', type: 'VAR_STRING' }],
      rows: [['1', 'it\'s', 'x'], ['2', 'y', 'z']],
      truncated: null,
    });
    const capped = await run('mysql', { sql: 'SELECT * FROM information_schema.columns', maxRows: 5 }).expect(200);
    expect(capped.body).toMatchObject({ rowCount: 5, truncated: 'rows' });
    const table = `sqlr_${suffix}`;
    const mysql = (await import('mysql2/promise')).default;
    const conn = await mysql.createConnection({ host, port: Number(port || 3306), user: 'root', password: 'test', database: 'test' });
    try {
      await conn.query(`CREATE TABLE ${table} (n int)`);
      await conn.query('SET GLOBAL log_bin_trust_function_creators = 1');
      await conn.query(`CREATE FUNCTION ${table}_w() RETURNS int MODIFIES SQL DATA BEGIN INSERT INTO ${table} VALUES (1); RETURN 1; END`);
      const viaFunction = await run('mysql', { sql: `SELECT ${table}_w()` }).expect(422);
      expect(viaFunction.body.error).toMatch(/READ ONLY transaction/);
      const [[{ n }]]: any = await conn.query(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(Number(n)).toBe(0);
      expect((await run('mysql', { sql: `SELECT * FROM ${table} INTO OUTFILE '/tmp/x'` }).expect(400)).body.code).toBe('not_read_only');

      const runId = crypto.randomUUID();
      const running = admin('post', '/connections/mysql/sql', { runId, sql: 'SELECT SLEEP(20)' }).then((r) => r);
      await sleep(700);
      expect((await admin('post', '/sql/cancel', { runId }).expect(200)).body.found).toBe(true);
      expect((await running).body.code).toBe('cancelled');
      // MAX_EXECUTION_TIME stops a SELECT on the server (SLEEP() would only return 1).
      const started = Date.now();
      const timed = await run('mysql', {
        sql: 'SELECT COUNT(*) FROM information_schema.columns a, information_schema.columns b, information_schema.columns c',
        timeoutMs: 1000,
      }).expect(422);
      expect(timed.body.code).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await conn.query(`DROP FUNCTION IF EXISTS ${table}_w`).catch(() => undefined);
      await conn.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
      await conn.end();
    }
  });

  (DREMIO_URL ? test : test.skip)('Dremio: rows read a page at a time to the cap; EXPLAIN PLAN', async () => {
    const at = new URL(DREMIO_URL!);
    const user = 'xcube';
    const password = 'xcube-dremio-pass1';
    await fetch(`${DREMIO_URL}/apiv2/bootstrap/firstuser`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: '_dremionull' },
      body: JSON.stringify({ userName: user, firstName: 'x', lastName: 'cube', email: 'xcube@example.com', createdAt: Date.now(), password }),
    });
    const fields = { host: at.hostname, port: Number(at.port || 9047), ssl: false };
    await admin('put', '/connections/dremio', {
      folderId: 'froot', driver: 'dremio', authMethod: 'password', fields: { ...fields, user }, sealed: { password: seal(password, fields, 'dremio') },
    }).expect(200);
    const res = await run('dremio', { sql: 'SELECT * FROM (VALUES (1, \'a\'), (2, \'b\'), (3, \'c\')) AS t(id, name)', maxRows: 2 }).expect(200);
    expect(res.body).toMatchObject({
      columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'VARCHAR' }],
      rows: [[1, 'a'], [2, 'b']],
      truncated: 'rows',
    });
    const explained = await run('dremio', { sql: 'EXPLAIN PLAN FOR SELECT 1' }).expect(200);
    expect(explained.body.statement).toBe('explain');
    expect((await run('dremio', { sql: 'CREATE TABLE $scratch.x AS SELECT 1' }).expect(400)).body.code).toBe('not_read_only');
  });

  (CUBESTORE ? test : test.skip)('Cube Store: a SELECT capped by its own LIMIT, its order kept; its cache, queue and SHOW refused', async () => {
    const res = await admin('post', '/cubestore/sql', { runId: crypto.randomUUID(), sql: `SELECT a, b FROM sqlr_${suffix}.t ORDER BY a DESC`, maxRows: 2 }).expect(200);
    expect(res.body).toMatchObject({
      columns: [{ name: 'a', type: null }, { name: 'b', type: null }],
      rows: [['3', 'y'], ['2', 'z']],
      rowCount: 2,
      truncated: 'rows',
      statement: 'select',
    });
    const all = await admin('post', '/cubestore/sql', { runId: crypto.randomUUID(), sql: `SELECT a FROM sqlr_${suffix}.t ORDER BY a LIMIT 10` }).expect(200);
    expect(all.body).toMatchObject({ rows: [['1'], ['2'], ['3']], truncated: null });
    const explained = await admin('post', '/cubestore/sql', { runId: crypto.randomUUID(), sql: `EXPLAIN SELECT * FROM sqlr_${suffix}.t` }).expect(200);
    expect(explained.body.statement).toBe('explain');
    for (const refused of ['SELECT * FROM system.cache', 'CACHE GET \'k\'', 'SHOW TABLES', `DROP TABLE sqlr_${suffix}.t`]) {
      const answer = await admin('post', '/cubestore/sql', { runId: crypto.randomUUID(), sql: refused }).expect(400);
      expect(answer.body.code).toBe('not_read_only');
    }
    expect((await cubeStore.query(`SELECT count(*) AS n FROM sqlr_${suffix}.t`, []))[0].n).toBe('3');
  });
  /** Runs a slow statement with a run id, and cancels it once the database is on it. */
  const cancelled = async (name: string, slow: string) => {
    const runId = crypto.randomUUID();
    const running = admin('post', `/connections/${name}/sql`, { runId, sql: slow }).then((r) => r);
    await sleep(1500);
    const started = Date.now();
    expect((await admin('post', '/sql/cancel', { runId }).expect(200)).body.found).toBe(true);
    const res = await running;
    return { code: res.body.code, ms: Date.now() - started };
  };

  (MSSQL ? test : test.skip)('SQL Server: a batch stays one statement; the caps, the time cap and a cancel', async () => {
    const [host, port] = MSSQL!.split(':');
    const fields = { host, port: Number(port || 1433), database: 'master', encrypt: false, trustServerCertificate: true };
    await admin('put', '/connections/mssql', {
      folderId: 'froot', driver: 'mssql', authMethod: 'sql-login', fields: { ...fields, user: 'sa' }, sealed: { password: seal('Xcube-test-Pass1', fields, 'mssql') },
    }).expect(200);
    const res = await run('mssql', { sql: 'SELECT TOP 2 CAST(1 AS int) AS a, N\'x\' AS b FROM sys.objects UNION ALL SELECT 2, N\'y\'' }).expect(200);
    // Cube's SQL Server driver gives every number as a string.
    expect(res.body).toMatchObject({ columns: [{ name: 'a', type: 'int' }, { name: 'b', type: 'nvarchar' }], rows: [['1', 'x'], ['1', 'x'], ['2', 'y']] });
    const capped = await run('mssql', { sql: 'SELECT name FROM sys.all_objects', maxRows: 5 }).expect(200);
    expect(capped.body).toMatchObject({ rowCount: 5, truncated: 'rows' });
    expect((await run('mssql', { sql: 'SELECT 1 SELECT 2' }).expect(400)).body.code).toBe('several_statements');
    expect((await run('mssql', { sql: 'SELECT 1 AS a INTO #t' }).expect(400)).body.code).toBe('not_read_only');
    expect((await run('mssql', { sql: 'SELECT 1 EXEC sp_who' }).expect(400)).body.code).toBe('not_read_only');
    const heavy = 'SELECT COUNT_BIG(*) FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c WHERE CAST(a.object_id AS bigint) + b.object_id + c.object_id = 7';
    const started = Date.now();
    expect((await run('mssql', { sql: heavy, timeoutMs: 1000 }).expect(422)).body.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(6000);
    const stop = await cancelled('mssql', heavy);
    expect(stop.code).toBe('cancelled');
    expect(stop.ms).toBeLessThan(5000);
  });

  (ORACLE ? test : test.skip)('Oracle: a read-only transaction; the caps, the time cap and a cancel', async () => {
    const [host, port] = ORACLE!.split(':');
    const fields = { host, port: Number(port || 1521), database: 'FREEPDB1' };
    await admin('put', '/connections/oracle', {
      folderId: 'froot', driver: 'oracle', authMethod: 'password', fields: { ...fields, user: 'xcube' }, sealed: { password: seal('xcube_test_pass1', fields, 'oracle') },
    }).expect(200);
    const res = await run('oracle', { sql: 'SELECT 1 AS a, \'x\' AS b FROM dual;' }).expect(200);
    expect(res.body).toMatchObject({ columns: [{ name: 'A', type: 'NUMBER' }, { name: 'B', type: 'CHAR' }], rows: [[1, 'x']] });
    const capped = await run('oracle', { sql: 'SELECT level FROM dual CONNECT BY level <= 100', maxRows: 5 }).expect(200);
    expect(capped.body).toMatchObject({ rowCount: 5, truncated: 'rows' });
    expect((await run('oracle', { sql: 'EXPLAIN PLAN FOR SELECT 1 FROM dual' }).expect(400)).body.code).toBe('not_read_only');
    expect((await run('oracle', { sql: 'SELECT DBMS_PIPE.RECEIVE_MESSAGE(\'a\', 10) FROM dual' }).expect(400)).body.code).toBe('not_read_only');

    // eslint-disable-next-line global-require
    const oracledb = require('oracledb');
    const conn = await oracledb.getConnection({ user: 'xcube', password: 'xcube_test_pass1', connectString: `${host}:${port}/FREEPDB1` });
    const table = `SQLR_${suffix}`.toUpperCase();
    try {
      await conn.execute(`CREATE TABLE ${table} (n NUMBER)`);
      await conn.execute(`CREATE OR REPLACE FUNCTION ${table}_W RETURN NUMBER IS BEGIN INSERT INTO ${table} VALUES (1); RETURN 1; END;`);
      await conn.execute(`CREATE OR REPLACE FUNCTION ${table}_A RETURN NUMBER IS PRAGMA AUTONOMOUS_TRANSACTION; BEGIN INSERT INTO ${table} VALUES (2); COMMIT; RETURN 1; END;`);
      const viaFunction = await run('oracle', { sql: `SELECT ${table}_W FROM dual` }).expect(422);
      expect(viaFunction.body.code).toBe('query_failed');
      // An autonomous transaction is its own: the read-only one doesn't hold it. Only a SELECT-only login does.
      await run('oracle', { sql: `SELECT ${table}_A FROM dual` }).expect(200);
      const { rows } = await conn.execute(`SELECT n FROM ${table}`, [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
      expect(rows).toEqual([[2]]);
    } finally {
      await conn.execute(`DROP FUNCTION ${table}_W`).catch(() => undefined);
      await conn.execute(`DROP FUNCTION ${table}_A`).catch(() => undefined);
      await conn.execute(`DROP TABLE ${table}`).catch(() => undefined);
      await conn.close();
    }
    const heavy = 'SELECT COUNT(*) FROM all_objects a, all_objects b, all_objects c';
    const started = Date.now();
    expect((await run('oracle', { sql: heavy, timeoutMs: 1000 }).expect(422)).body.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(6000);
    const stop = await cancelled('oracle', heavy);
    expect(stop.code).toBe('cancelled');
    expect(stop.ms).toBeLessThan(5000);
  });
});
