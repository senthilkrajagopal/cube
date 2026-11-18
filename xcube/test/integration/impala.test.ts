/**
 * Impala as a data source, on a real cluster: xcube's driver (the Hive one,
 * `flavour: 'impala'`) for Cube's queries, the SQL runner's session, exports,
 * its sign-ins and the connection's failures, and the SQL xcube's Impala
 * dialect compiles. Runs when given:
 *
 *   XCUBE_TEST_IMPALA           an Impala daemon's HiveServer2 port as host:port, without LDAP (the `none`
 *                               sign-in), where tables may be created in `default`
 *   XCUBE_TEST_IMPALA_WEB       the first daemon's web UI as host:port, for the queries it has in flight
 *                               (default: its host, port 25000)
 *   XCUBE_TEST_IMPALA_LDAP      a daemon of the same cluster with LDAP and TLS on, as host:port, its
 *                               certificate for that host name
 *   XCUBE_TEST_IMPALA_USER      a user LDAP signs in, and
 *   XCUBE_TEST_IMPALA_PASSWORD  its password
 *   XCUBE_TEST_IMPALA_CA        a PEM file of the CA that signed the certificate
 *   XCUBE_TEST_IMPALA_OTHER     a PEM file of a CA that didn't
 *
 * xcube's own cluster for these: Impala 4.5.3's quickstart images (amd64),
 * its statestore, catalog and metastore, a coordinator and executor without
 * LDAP, and a second coordinator with LDAP (glauth) and TLS.
 */
/* eslint-disable no-template-curly-in-string -- `${…}` here is SQL under test */
import crypto from 'crypto';
import net from 'net';

import { prepareCompiler } from '@cubejs-backend/schema-compiler';

import { DRIVERS, type Fields } from '../../src/connections/drivers';
import { HiveConnection, HiveDriver, type HiveConfig } from '../../src/connections/hive';
import { XcubeImpalaQuery } from '../../src/model/impala-dialect';
import { ExportRows } from '../../src/sql/export';
import { SqlRunError } from '../../src/sql/runner';
import { SqlRuns, type SqlRunRequest, type SqlTarget } from '../../src/sql/runs';

const IMPALA = process.env.XCUBE_TEST_IMPALA;
const LDAP = process.env.XCUBE_TEST_IMPALA_LDAP;

jest.setTimeout(10 * 60 * 1000);

/** The fixture's facts: times across 2026-03-08's change in Los Angeles, and a name holding %, _ and '. */
const FACTS: [number, string, string, string][] = [
  [1, '2026-01-15 10:00:00', 'east', '10.25'],
  [2, '2026-03-08 09:30:00', 'west', '5.50'],
  [3, '2026-03-08 10:30:00', 'a%_\'x', '7.00'],
  [4, '2026-04-10 23:59:59', 'east', '1.00'],
  [5, '2026-11-01 08:30:00', 'west', '2.75'],
  [6, '2026-11-01 09:30:00', 'East', '3.00'],
];

(IMPALA ? describe : describe.skip)('Impala as a data source', () => {
  const [host, port] = (IMPALA ?? 'x:0').split(':');
  const fields = { host, port: Number(port), database: 'default', ssl: false };
  const config = (over: Partial<HiveConfig> = {}): HiveConfig => ({ ...DRIVERS.impala.config(fields, 'none', {}), ...over } as HiveConfig);
  const runs = new SqlRuns('here', () => null, () => undefined);
  const suffix = crypto.randomBytes(3).toString('hex');
  const facts = `xcube_it_facts_${suffix}`;
  const cells = `xcube_it_cells_${suffix}`;
  const thousand = `xcube_it_thousand_${suffix}`;
  let admin: HiveConnection;

  const exec = (sql: string) => admin.all(sql, 600, () => false);

  beforeAll(async () => {
    admin = await HiveConnection.open(config());
    await exec(`CREATE TABLE ${facts} (id INT, ts TIMESTAMP, name STRING, amount DECIMAL(10,2))`);
    await exec(`INSERT INTO ${facts} VALUES ${FACTS.map(([id, ts, name, amount]) => `(${id}, CAST('${ts}' AS TIMESTAMP), '${name.replace(/'/g, '\\\'')}', ${amount})`).join(', ')}`);
    await exec(`CREATE TABLE ${cells} (big BIGINT, d DECIMAL(38,9), ts TIMESTAMP, dt DATE, b BOOLEAN, bin BINARY, dbl DOUBLE, s STRING, v VARCHAR(10), c CHAR(3), f FLOAT, t TINYINT)`);
    await exec(`INSERT INTO ${cells} SELECT CAST(9007199254740993 AS BIGINT), CAST('12345678901234567890.123456789' AS DECIMAL(38,9)),
      CAST('2026-03-08 02:30:00.123456789' AS TIMESTAMP), CAST('2026-01-02' AS DATE), true, CAST('ab' AS BINARY), CAST(1.5 AS DOUBLE),
      'it\\'s \\\\ "q"', CAST('v' AS VARCHAR(10)), CAST('c' AS CHAR(3)), CAST(1.25 AS FLOAT), CAST(-3 AS TINYINT)`);
    const digits = '(VALUES (0 AS d), (1), (2), (3), (4), (5), (6), (7), (8), (9))';
    await exec(`CREATE TABLE ${thousand} (n INT)`);
    await exec(`INSERT INTO ${thousand} SELECT CAST(a.d * 100 + b.d * 10 + c.d AS INT) FROM ${digits} a CROSS JOIN ${digits} b CROSS JOIN ${digits} c`);
  });

  afterAll(async () => {
    for (const table of [facts, cells, thousand]) {
      await exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    }
    await admin?.close();
  });

  const target = (over: Record<string, unknown> = {}): SqlTarget => ({
    dialect: 'impala',
    label: 'impala',
    build: async () => ({ driver: DRIVERS.impala.make!({ ...DRIVERS.impala.config({ ...fields, ...over }, 'none', {}) }), secrets: [] }),
  });
  const request = (sql: string, more: Partial<SqlRunRequest> = {}): SqlRunRequest => ({
    sql, runId: crypto.randomUUID(), maxRows: 100, timeoutMs: 120000, maxBytes: 10 * 1024 * 1024, ...more,
  });
  const run = (sql: string, more: Partial<SqlRunRequest> = {}) => runs.run('m', target(), request(sql, more));
  const failure = (promise: Promise<unknown>) => promise.then(
    () => { throw new Error('the run answered'); },
    (e) => {
      expect(e).toBeInstanceOf(SqlRunError);
      return e as SqlRunError;
    },
  );
  /** A statement that runs for minutes: a hash of each of a billion rows. */
  const slow = () => `SELECT count(*) FROM ${thousand} a CROSS JOIN ${thousand} b CROSS JOIN ${thousand} c
    WHERE sha2(concat(CAST(a.n AS STRING), '-', CAST(b.n AS STRING), '-', CAST(c.n AS STRING)), 256) = 'x'`;
  /**
   * Whether the cluster is running a statement holding `marker`, from its
   * daemon's queries in flight (R5 test 2): one stopped stays listed, ended
   * (`EXCEPTION`), until its client closes it. `null` without the web UI.
   */
  const inFlight = async (marker: string) => {
    const page: any = await fetch(`http://${process.env.XCUBE_TEST_IMPALA_WEB ?? `${host}:25000`}/queries?json`).then((r) => r.json()).catch(() => null);
    return page
      ? (page.in_flight_queries ?? []).some((q: any) => String(q.stmt).includes(marker) && !['EXCEPTION', 'FINISHED'].includes(q.state))
      : null;
  };
  const until = async (check: () => Promise<boolean>, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => { setTimeout(resolve, 1000); })) {
      if (await check()) {
        return true;
      }
    }
    return false;
  };

  test('a read: its columns as Impala names their types, and every cell as R5 has it', async () => {
    const answer = await run(`SELECT * FROM ${cells}`);
    expect(answer.columns.map((c) => c.type)).toEqual([
      'bigint', 'decimal(38,9)', 'timestamp', 'date', 'boolean', 'binary', 'double', 'string', 'varchar(10)', 'char(3)', 'float', 'tinyint',
    ]);
    expect(answer.rows).toEqual([[
      '9007199254740993', '12345678901234567890.123456789', '2026-03-08 02:30:00.123456789', '2026-01-02', true, '\\x6162', 1.5,
      'it\'s \\ "q"', 'v', 'c  ', 1.25, -3,
    ]]);
    expect(answer.statement).toBe('select');
    expect((await run('EXPLAIN SELECT 1')).statement).toBe('explain');
    // Impala substitutes no variable: `${…}` is text.
    expect((await run('SELECT \'${env:HOME}\' AS e')).rows).toEqual([['${env:HOME}']]);
  });

  test('the row cap, and refusals before anything runs (R6)', async () => {
    const capped = await run(`SELECT n FROM ${thousand}`, { maxRows: 5 });
    expect(capped.rowCount).toBe(5);
    expect(capped.truncated).toBe('rows');
    expect((await failure(run('SELECT 1; SELECT 2'))).code).toBe('several_statements');
    for (const sql of [
      `INSERT INTO ${facts} VALUES (9, NULL, 'x', 1)`,
      `WITH q AS (SELECT 9 AS id) INSERT INTO ${facts} (id) SELECT id FROM q`,
      `UPSERT INTO ${facts} (id) VALUES (9)`,
      'SELECT /* +straight_join */ 1',
      `SELECT 1 FROM ${facts} a JOIN [SHUFFLE] ${facts} b ON a.id = b.id`,
      `SET MEM_LIMIT=1`,
      `REFRESH ${facts}`,
      `INVALIDATE METADATA ${facts}`,
      `COMPUTE STATS ${facts}`,
      `COMMENT ON TABLE ${facts} IS 'x'`,
      `ALTER TABLE ${facts} SET TBLPROPERTIES ('x'='y')`,
      ':SHUTDOWN()',
      'USE default',
    ]) {
      expect([sql, (await failure(run(sql))).code]).toEqual([sql, 'not_read_only']);
    }
    // `a\`; drop table t` is one name to Impala, and here: no second statement.
    const name = await failure(run('SELECT `a\\`; drop table t`'));
    expect(name.code).toBe('query_failed');
    expect((await exec(`SELECT count(*) FROM ${facts}`)).rows).toEqual([[FACTS.length]]);
  });

  test('parameters written in as literals: hostile text comes back as data, nothing else runs (R12)', async () => {
    const hostile = [
      '\'; DROP TABLE x; --', 'a\\\'; DROP TABLE x; --', '${env:HOME}', '${system:user.name}', '$', '*/ DROP TABLE x /*', '-- c\n; SELECT 1',
      'back\\slash\\', '\\', 'tab\tq"d', ';', 'line\nbreak\r', '\'\'\'',
    ];
    for (const value of hostile) {
      const answer = await run('SELECT {{t}} AS v', { parameters: { t: { type: 'text', value } } });
      expect([value, answer.rows]).toEqual([value, [[value]]]);
    }
    const named = await run(`SELECT count(*) FROM ${facts} WHERE name = {{t}}`, { parameters: { t: { type: 'text', value: 'a%_\'x' } } });
    expect(named.rows).toEqual([[1]]);
    expect((await exec(`SELECT count(*) FROM ${facts}`)).rows).toEqual([[FACTS.length]]);
  });

  test('parameters written in as literals: a list, a number and a boolean (R12)', async () => {
    const listed = await run(`SELECT count(*) FROM ${facts} WHERE id IN ({{ids}}) AND name IN ({{names}})`, {
      lists: true,
      parameters: { ids: { type: 'number', value: ['1', '3', '4'] }, names: { type: 'text', value: ['east', 'a%_\'x'] } },
    } as any);
    expect(listed.rows).toEqual([[3]]);
    const typed = await run('SELECT {{n}} + 1 AS n, {{b}} AS b', {
      parameters: { n: { type: 'number', value: '-12.50' }, b: { type: 'boolean', value: false } },
    });
    expect(typed.rows).toEqual([['-11.50', false]]);
  });

  // Known to fail where noted (wechart's user, R12): ${label}'s date and time parameters are to be fixed against a live data source.
  test('parameters written in as literals: a date, and a date and time (R12)', async () => {
    const day = await run(`SELECT count(*) FROM ${facts} WHERE CAST(ts AS DATE) = {{d}}`, { parameters: { d: { type: 'date', value: '2026-03-08' } } });
    expect(day.rows).toEqual([[2]]);
    const at = await run(`SELECT count(*) FROM ${facts} WHERE ts = {{at}}`, { parameters: { at: { type: 'datetime', value: '2026-03-08T09:30:00' } } });
    expect(at.rows).toEqual([[1]]);
    const exact = await run('SELECT {{at}} = CAST(\'2026-03-08 02:30:00.5\' AS TIMESTAMP) AS same', {
      parameters: { at: { type: 'datetime', value: '2026-03-08T02:30:00.5' } },
    });
    expect(exact.rows).toEqual([[true]]);
  });

  test('a run past its time ends as `timeout`, and the cluster stops it (R5 test 2)', async () => {
    const started = Date.now();
    const e = await failure(run(`${slow()} AND 'timeout-${suffix}' <> ''`, { timeoutMs: 5000 }));
    expect(e.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(20000);
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
    expect(await inFlight(`timeout-${suffix}`)).not.toBe(true);
    const next = Date.now();
    await run('SELECT 1');
    expect(Date.now() - next).toBeLessThan(15000);
  });

  test('a cancel stops a running statement, which ends `cancelled`', async () => {
    const req = request(`${slow()} AND 'cancel-${suffix}' <> ''`);
    const running = failure(runs.run('m', target(), req));
    await new Promise((resolve) => { setTimeout(resolve, 3000); });
    expect(await inFlight(`cancel-${suffix}`)).not.toBe(false);
    runs.cancelHere(req.runId);
    const started = Date.now();
    expect((await running).code).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(10000);
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
    expect(await inFlight(`cancel-${suffix}`)).not.toBe(true);
  });

  test('an export of 1,000,000 rows arrives whole, the event loop free throughout (R4 test 4, R5 test 5)', async () => {
    let lines = 0;
    let last = '';
    const rows = new ExportRows((line) => {
      lines += 1;
      last = line;
      return true;
    });
    let worst = 0;
    let tick = Date.now();
    const lag = setInterval(() => {
      worst = Math.max(worst, Date.now() - tick - 50);
      tick = Date.now();
    }, 50);
    try {
      await runs.run('m', target(), request(`SELECT a.n * 1000 + b.n AS n, concat('row-', CAST(a.n AS STRING)) AS s FROM ${thousand} a CROSS JOIN ${thousand} b`, {
        maxRows: Number.MAX_SAFE_INTEGER - 1, maxBytes: Number.MAX_SAFE_INTEGER, selectOnly: true,
      }), rows);
    } finally {
      clearInterval(lag);
    }
    expect(rows.count).toBe(1000000);
    expect(lines).toBe(1000001);
    expect(last.startsWith('[')).toBe(true);
    expect(worst).toBeLessThan(1000);
  });

  test('a client that stops reading holds the export, then ends it `client_too_slow`', async () => {
    let lines = 0;
    const rows = new ExportRows(() => {
      lines += 1;
      return true;
    }, { rows: 1000, bytes: 64 * 1024 }, async () => false);
    await runs.run('m', target(), request(`SELECT a.n FROM ${thousand} a CROSS JOIN ${thousand} b`, {
      maxRows: Number.MAX_SAFE_INTEGER - 1, maxBytes: Number.MAX_SAFE_INTEGER, selectOnly: true,
    }), rows);
    expect(rows.slow).toBe(true);
    expect(lines).toBeLessThan(2000);
  });

  test('Cube\'s queries: rows by name, values written in as literals, a cancel', async () => {
    const driver = new HiveDriver(config({ maxPoolSize: 2 }));
    try {
      await driver.testConnection();
      const rows = await driver.query(`SELECT id, name FROM ${facts} WHERE name = ? AND amount > ? ORDER BY id`, ['a%_\'x', 1]);
      expect(rows).toEqual([{ id: 3, name: 'a%_\'x' }]);
      const decimal = await driver.query('SELECT CAST(? AS DECIMAL(38,9)) AS d', ['12345678901234567890.123456789']);
      expect(decimal).toEqual([{ d: '12345678901234567890.123456789' }]);
      const literal = await driver.query('SELECT ? AS s, ? AS t', ['${env:HOME} \\ \'', 'a\nb']);
      expect(literal).toEqual([{ s: '${env:HOME} \\ \'', t: 'a\nb' }]);
      const slowQuery = driver.query(slow()) as Promise<unknown> & { cancel: () => Promise<void> };
      await new Promise((resolve) => { setTimeout(resolve, 3000); });
      await slowQuery.cancel();
      await expect(slowQuery).rejects.toThrow(/cancel/i);
    } finally {
      await driver.release();
    }
  });

  test('the catalog: schemas, tables and their columns with Impala\'s types (R4 test 5)', async () => {
    const driver = new HiveDriver(config());
    try {
      expect((await driver.getSchemas()).map((s) => s.schema_name)).toContain('default');
      const tables = await driver.getTablesForSpecificSchemas([{ schema_name: 'default' }]);
      expect(tables.map((t) => t.table_name)).toContain(facts);
      const columns = await driver.getColumnsForSpecificTables([{ schema_name: 'default', table_name: facts }]);
      expect(columns.map((c: any) => [c.column_name, c.data_type])).toEqual([
        ['id', 'int'], ['ts', 'timestamp'], ['name', 'string'], ['amount', expect.stringMatching(/^decimal/)],
      ]);
    } finally {
      await driver.release();
    }
  });

  (LDAP ? describe : describe.skip)('its sign-ins, and TLS (R3)', () => {
    // eslint-disable-next-line global-require
    const fs = require('fs');
    const [ldapHost, ldapPort] = (LDAP ?? 'x:0').split(':');
    const ca = LDAP ? fs.readFileSync(process.env.XCUBE_TEST_IMPALA_CA!, 'utf8') : '';
    const other = LDAP ? fs.readFileSync(process.env.XCUBE_TEST_IMPALA_OTHER!, 'utf8') : '';
    const ldapFields: Fields = { host: ldapHost, port: Number(ldapPort), database: 'default', ssl: true, sslCa: ca, user: process.env.XCUBE_TEST_IMPALA_USER };
    const password = { password: process.env.XCUBE_TEST_IMPALA_PASSWORD! };
    const signIn = async (f: Fields, method: string, secrets: Record<string, string> = {}) => {
      const driver = DRIVERS.impala.make!(DRIVERS.impala.config(f, method, secrets));
      try {
        await driver.testConnection();
        return await driver.query('SELECT effective_user() AS u');
      } finally {
        await driver.release();
      }
    };

    test('a user and password, to a daemon with LDAP', async () => {
      expect(await signIn(ldapFields, 'password', password)).toEqual([{ u: process.env.XCUBE_TEST_IMPALA_USER }]);
    });

    test('TLS: a certificate the CA doesn\'t sign is refused, and taken with sslRejectUnauthorized false (R3 test 5)', async () => {
      await expect(signIn({ ...ldapFields, sslCa: other }, 'password', password)).rejects.toThrow(/certificate/i);
      // The system's CAs alone: a private CA's certificate isn't trusted.
      await expect(signIn({ ...ldapFields, sslCa: undefined }, 'password', password)).rejects.toThrow(/certificate/i);
      expect(await signIn({ ...ldapFields, sslCa: other, sslRejectUnauthorized: false }, 'password', password))
        .toEqual([{ u: process.env.XCUBE_TEST_IMPALA_USER }]);
    });

    test('TLS: a connection without it, to its TLS port, fails', async () => {
      await expect(signIn({ ...ldapFields, ssl: false }, 'password', password)).rejects.toThrow();
    });

    test('a wrong password, or none, is refused with a reason', async () => {
      await expect(signIn(ldapFields, 'password', { password: 'wrong' })).rejects.toThrow(/closed the connection at the sign-in: the user or password is wrong/);
      await expect(signIn(ldapFields, 'username')).rejects.toThrow(/closed the connection at the sign-in/);
    });

    test('no sign-in, to a daemon with LDAP, is refused with a reason', async () => {
      await expect(signIn({ ...ldapFields, user: undefined }, 'none')).rejects.toThrow(/closed the connection before a session opened: it wants a sign-in/);
    });

    test('a sign-in, to a daemon without LDAP, fails within the connect deadline, saying so', async () => {
      const c = HiveConnection.open({ ...config(), mechanism: 'plain', user: 'ana', password: 'x', connectTimeoutMs: 3000 });
      await expect(c).rejects.toThrow(/didn't complete the sign-in within 3000 ms.*takes no sign-in: the `none` method/);
    });
  });

  describe('a connection that fails', () => {
    /** A port that takes connections and passes them on to the server, or says nothing. */
    function proxy(mode: 'silent' | 'pass') {
      const sockets = new Set<net.Socket>();
      const server = net.createServer((client) => {
        sockets.add(client);
        client.on('error', () => undefined);
        if (mode === 'pass') {
          const upstream = net.connect(Number(port), host);
          upstream.on('error', () => client.destroy());
          sockets.add(upstream);
          client.pipe(upstream).pipe(client);
        }
      });
      return new Promise<{ port: number; reset: () => void; close: () => Promise<void> }>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
          port: (server.address() as net.AddressInfo).port,
          reset: () => sockets.forEach((s) => s.resetAndDestroy()),
          close: () => new Promise((done) => {
            sockets.forEach((s) => s.destroy());
            server.close(() => done());
          }),
        }));
      });
    }

    let uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    beforeEach(() => {
      uncaught = [];
      process.on('uncaughtException', onUncaught);
    });
    afterEach(() => {
      process.off('uncaughtException', onUncaught);
      expect(uncaught).toEqual([]);
    });

    test('a port that accepts and says nothing fails within the connect deadline (R4 test 2)', async () => {
      const silent = await proxy('silent');
      try {
        const started = Date.now();
        await expect(HiveConnection.open({ ...config(), host: '127.0.0.1', port: silent.port, connectTimeoutMs: 3000 }))
          .rejects.toThrow(/within 3000 ms/);
        expect(Date.now() - started).toBeLessThan(6000);
      } finally {
        await silent.close();
      }
    });

    test('a connection reset mid-statement rejects at once, and the driver serves on (R4 test 1)', async () => {
      const pass = await proxy('pass');
      const driver = new HiveDriver({ ...config(), host: '127.0.0.1', port: pass.port, maxPoolSize: 1 });
      try {
        const query = driver.query(`${slow()} AND 'reset-${suffix}' <> ''`);
        await new Promise((resolve) => { setTimeout(resolve, 3000); });
        const started = Date.now();
        pass.reset();
        await expect(query).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(5000);
        // The failed connection isn't given back: a new one answers.
        expect(await driver.query('SELECT 1 AS a')).toEqual([{ a: 1 }]);
        // Its statement runs on until Impala sees its client gone (idle_client_poll_period_s, 30 s by default).
        expect(await until(async () => (await inFlight(`reset-${suffix}`)) === false, 90000)).toBe(true);
      } finally {
        await driver.release();
        await pass.close();
      }
    });

    test('a wrong port, and the connection test\'s step failing with the driver\'s words', async () => {
      const driver = DRIVERS.impala.make!(DRIVERS.impala.config({ ...fields, host: '127.0.0.1', port: 1 }, 'none', {}));
      try {
        await expect(driver.testConnection()).rejects.toThrow(/ECONNREFUSED|connect/);
      } finally {
        await driver.release();
      }
    });
  });

  describe('xcube\'s dialect, its SQL run on the server (R8)', () => {
    let compiled: any;
    let driver: HiveDriver;
    const planner = process.env.CUBEJS_TESSERACT_SQL_PLANNER;

    beforeAll(async () => {
      process.env.CUBEJS_TESSERACT_SQL_PLANNER = 'true';
      compiled = prepareCompiler({
        localPath: () => '/nowhere',
        dataSchemaFiles: async () => [{
          fileName: 'cubes/f.yml',
          content: `cubes:
  - name: f
    sql_table: default.${facts}
    dimensions:
      - { name: id, sql: id, type: number, primary_key: true }
      - { name: at, sql: ts, type: time }
      - { name: name, sql: name, type: string }
    measures:
      - { name: total, sql: amount, type: sum }
      - { name: n, type: count }
      - { name: names, sql: name, type: count_distinct }
      - { name: approx, sql: name, type: count_distinct_approx }
      - name: trailing
        sql: amount
        type: sum
        rolling_window: { trailing: 2 month }
`,
        }],
      }, { standalone: true, allowNodeRequire: false });
      await compiled.compiler.compile();
      driver = new HiveDriver(config({ maxPoolSize: 2 }));
    });

    afterAll(async () => {
      await driver?.release();
      if (planner === undefined) {
        delete process.env.CUBEJS_TESSERACT_SQL_PLANNER;
      } else {
        process.env.CUBEJS_TESSERACT_SQL_PLANNER = planner;
      }
    });

    const sqlOf = (query: Record<string, unknown>) => new XcubeImpalaQuery(compiled, { timezone: 'UTC', ...query }).buildSqlAndParams();
    const rowsOf = async (query: Record<string, unknown>) => {
      const [sql, params] = sqlOf(query);
      return driver.query<Record<string, unknown>>(sql, params);
    };

    /** The fixture's sums by period, computed here: each timestamp read as UTC and moved to `zone`. */
    const expected = (granularity: string, zone: string) => {
      const sums = new Map<string, number>();
      for (const [, ts, , amount] of FACTS) {
        const at = new Date(`${ts.replace(' ', 'T')}Z`);
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
          timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(at).map((p) => [p.type, p.value]));
        const wall = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second));
        const start = new Date(wall);
        switch (granularity) {
          case 'year': start.setUTCMonth(0, 1); start.setUTCHours(0, 0, 0, 0); break;
          case 'quarter': start.setUTCMonth(Math.floor(start.getUTCMonth() / 3) * 3, 1); start.setUTCHours(0, 0, 0, 0); break;
          case 'month': start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0); break;
          case 'week': start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); start.setUTCHours(0, 0, 0, 0); break;
          case 'day': start.setUTCHours(0, 0, 0, 0); break;
          case 'hour': start.setUTCMinutes(0, 0, 0); break;
          case 'minute': start.setUTCSeconds(0, 0); break;
          default: break;
        }
        const key = start.toISOString().slice(0, 19).replace('T', ' ');
        sums.set(key, (sums.get(key) ?? 0) + Number(amount));
      }
      return [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([at, total]) => [at, total.toFixed(2)]);
    };

    for (const zone of ['UTC', 'America/Los_Angeles']) {
      for (const granularity of ['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year']) {
        test(`a measure by ${granularity}, in ${zone}`, async () => {
          const rows = await rowsOf({
            measures: ['f.total'],
            timeDimensions: [{ dimension: 'f.at', granularity }],
            order: [{ id: 'f.at', desc: false }],
            timezone: zone,
          });
          expect(rows.map((r) => [String(r[`f__at_${granularity}`]).slice(0, 19), Number(r.f__total).toFixed(2)])).toEqual(expected(granularity, zone));
        });
      }
    }

    test('a date range, a count distinct (exact and NDV), a limit with an offset and an order', async () => {
      const query = {
        measures: ['f.n', 'f.names', 'f.approx'],
        dimensions: ['f.name'],
        timeDimensions: [{ dimension: 'f.at', dateRange: ['2026-01-01', '2026-06-30'] }],
        order: [{ id: 'f.name', desc: false }],
        rowLimit: 2,
        offset: 1,
      };
      const [sql] = sqlOf(query);
      expect(sql).toMatch(/NDV\(/);
      expect(sql).toMatch(/ORDER BY[\s\S]*LIMIT 2[\s\S]*OFFSET 1/);
      // In the range: a%_'x, east (1, 4), west (2); ordered, the second and third.
      expect(await rowsOf(query)).toEqual([
        { f__name: 'east', f__n: 2, f__names: 1, f__approx: 1 },
        { f__name: 'west', f__n: 1, f__names: 1, f__approx: 1 },
      ]);
    });

    test('`contains` holding %, _ and \', case-insensitively', async () => {
      const count = async (operator: string, value: string) => Number((await rowsOf({
        measures: ['f.n'], filters: [{ member: 'f.name', operator, values: [value] }],
      }))[0].f__n);
      expect(await count('contains', '%_\'')).toBe(1);
      expect(await count('contains', 'A%_\'X')).toBe(1);
      expect(await count('contains', '%')).toBe(1);
      expect(await count('contains', '_')).toBe(1);
      expect(await count('notContains', '_')).toBe(FACTS.length - 1);
      expect(await count('startsWith', 'ea')).toBe(3);
      expect(await count('endsWith', 'X')).toBe(1);
      expect(await count('equals', 'east')).toBe(2);
    });

    test('a rolling window', async () => {
      const rows = await rowsOf({
        measures: ['f.trailing'],
        timeDimensions: [{ dimension: 'f.at', granularity: 'month', dateRange: ['2026-01-01', '2026-05-31'] }],
        order: [{ id: 'f.at', desc: false }],
      });
      expect(rows.map((r) => [String(r.f__at_month).slice(0, 10), Number(r.f__trailing).toFixed(2)])).toEqual([
        ['2026-01-01', '10.25'], ['2026-02-01', '10.25'], ['2026-03-01', '12.50'], ['2026-04-01', '13.50'], ['2026-05-01', '1.00'],
      ]);
    });

    test('the legacy planner\'s SQL runs too: a measure by quarter in Los Angeles, and `contains` %', async () => {
      process.env.CUBEJS_TESSERACT_SQL_PLANNER = 'false';
      try {
        const byQuarter = await rowsOf({
          measures: ['f.total'], timeDimensions: [{ dimension: 'f.at', granularity: 'quarter' }], order: [{ id: 'f.at', desc: false }], timezone: 'America/Los_Angeles',
        });
        expect(byQuarter.map((r) => [String(r.f__at_quarter).slice(0, 19), Number(r.f__total).toFixed(2)])).toEqual(expected('quarter', 'America/Los_Angeles'));
        const contains = await rowsOf({ measures: ['f.n'], filters: [{ member: 'f.name', operator: 'contains', values: ['A%'] }] });
        expect(Number(contains[0].f__n)).toBe(1);
      } finally {
        process.env.CUBEJS_TESSERACT_SQL_PLANNER = 'true';
      }
    });
  });
});
