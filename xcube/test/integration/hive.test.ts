/**
 * Hive (or Spark's Thrift server) as a data source, on a real server:
 * xcube's driver for Cube's queries, the SQL runner's session, exports, the
 * connection's failures, and the SQL xcube's dialect compiles. Runs when
 * given:
 *
 *   XCUBE_TEST_HIVE          a HiveServer2 binary port as host:port, signed in to with SASL PLAIN as
 *                            `hive` and no password (a `NONE` server: apache/hive:4.2.1 or 3.1.3 as it
 *                            starts, or Spark's Thrift server), where `hive` may create tables in `default`
 *   XCUBE_TEST_HIVE_FLAVOUR  `spark` when it is Spark's: what differs is said where it does
 */
/* eslint-disable no-template-curly-in-string -- `${…}` here is Hive's variable syntax, the SQL under test */
import crypto from 'crypto';
import net from 'net';

import { prepareCompiler } from '@cubejs-backend/schema-compiler';

import { DRIVERS } from '../../src/connections/drivers';
import { HiveConnection, HiveDriver, type HiveConfig } from '../../src/connections/hive';
import { XcubeHiveQuery } from '../../src/model/hive-dialect';
import { ExportRows } from '../../src/sql/export';
import { SqlRunError } from '../../src/sql/runner';
import { SqlRuns, type SqlRunRequest, type SqlTarget } from '../../src/sql/runs';

const HIVE = process.env.XCUBE_TEST_HIVE;
const SPARK = process.env.XCUBE_TEST_HIVE_FLAVOUR === 'spark';

jest.setTimeout(10 * 60 * 1000);

/** The fixture's facts: a value of every type, and times across 2026-03-08's change in Los Angeles. */
const FACTS: [number, string, string, string][] = [
  [1, '2026-01-15 10:00:00', 'east', '10.25'],
  [2, '2026-03-08 09:30:00', 'west', '5.50'],
  [3, '2026-03-08 10:30:00', 'a%_\'x', '7.00'],
  [4, '2026-04-10 23:59:59', 'east', '1.00'],
  [5, '2026-11-01 08:30:00', 'west', '2.75'],
  [6, '2026-11-01 09:30:00', 'East', '3.00'],
];

(HIVE ? describe : describe.skip)(`Hive${SPARK ? ' (Spark)' : ''} as a data source`, () => {
  const [host, port] = (HIVE ?? 'x:0').split(':');
  const fields = { host, port: Number(port), database: 'default', user: 'hive', ssl: false };
  const config = (over: Partial<HiveConfig> = {}): HiveConfig => ({ ...DRIVERS.hive.config(fields, 'username', {}), ...over } as HiveConfig);
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
    await exec(`CREATE TABLE ${cells} (big BIGINT, d DECIMAL(38,9), ts TIMESTAMP, dt DATE, b BOOLEAN, bin BINARY, dbl DOUBLE, s STRING, v VARCHAR(10), arr ARRAY<INT>)`);
    await exec(`INSERT INTO ${cells} SELECT CAST(9007199254740993 AS BIGINT), CAST('12345678901234567890.123456789' AS DECIMAL(38,9)),
      CAST('2026-03-08 02:30:00.123456' AS TIMESTAMP), CAST('2026-01-02' AS DATE), true, CAST('ab' AS BINARY), CAST(1.5 AS DOUBLE),
      'it\\'s \\\\ "q"', CAST('v' AS VARCHAR(10)), array(1, 2)`);
    await exec(`CREATE TABLE ${thousand} (n INT)`);
    await exec(`INSERT INTO ${thousand} SELECT pos FROM (SELECT posexplode(split(space(999), ' '))) t`);
  });

  afterAll(async () => {
    for (const table of [facts, cells, thousand]) {
      await exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    }
    await admin?.close();
  });

  const target = (over: Record<string, unknown> = {}): SqlTarget => ({
    dialect: 'hive',
    label: 'hive',
    build: async () => ({ driver: DRIVERS.hive.make!({ ...DRIVERS.hive.config({ ...fields, ...over }, 'username', {}) }), secrets: [] }),
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
  /** A statement that runs for minutes, on Hive and Spark alike: a hash of each of a billion rows. */
  const slow = () => `SELECT count(*) FROM ${thousand} a CROSS JOIN ${thousand} b CROSS JOIN ${thousand} c
    WHERE md5(concat(CAST(a.n AS STRING), '-', CAST(b.n AS STRING), '-', CAST(c.n AS STRING))) = 'x'`;

  test('a read: its columns as Hive names their types, and every cell as R5 has it', async () => {
    const answer = await run(`SELECT * FROM ${cells}`);
    expect(answer.columns.map((c) => c.type)).toEqual([
      'bigint', 'decimal(38,9)', 'timestamp', 'date', 'boolean', 'binary', 'double', 'string', 'varchar(10)', 'array',
    ]);
    expect(answer.rows).toEqual([[
      '9007199254740993', '12345678901234567890.123456789', '2026-03-08 02:30:00.123456', '2026-01-02', true, '\\x6162', 1.5,
      'it\'s \\ "q"', 'v', '[1,2]',
    ]]);
    expect(answer.statement).toBe('select');
    expect((await run('EXPLAIN SELECT 1')).statement).toBe('explain');
  });

  test('the row cap, and refusals before anything runs', async () => {
    const capped = await run(`SELECT n FROM ${thousand}`, { maxRows: 5 });
    expect(capped.rowCount).toBe(5);
    expect(capped.truncated).toBe('rows');
    expect((await failure(run('SELECT 1; SELECT 2'))).code).toBe('several_statements');
    expect((await failure(run('SELECT \'${env:HOME}\''))).code).toBe('not_read_only');
    expect((await failure(run('SELECT reflect(\'java.lang.System\', \'getenv\', \'HOME\')'))).code).toBe('not_read_only');
    expect((await failure(run(`INSERT INTO ${facts} VALUES (9, NULL, 'x', 1)`))).code).toBe('not_read_only');
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

  test('a run past its time ends as `timeout`, and the server stops it', async () => {
    const started = Date.now();
    const e = await failure(run(slow(), { timeoutMs: 5000 }));
    expect(e.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(20000);
    // The server is free again: a statement after it answers at once.
    const next = Date.now();
    await run('SELECT 1');
    expect(Date.now() - next).toBeLessThan(15000);
  });

  test('a cancel stops a running statement, which ends `cancelled`', async () => {
    const req = request(slow());
    const running = failure(runs.run('m', target(), req));
    await new Promise((resolve) => { setTimeout(resolve, 3000); });
    runs.cancelHere(req.runId);
    const started = Date.now();
    expect((await running).code).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(10000);
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
      await runs.run('m', target(), request(`SELECT a.n * 1000 + b.n AS n, concat('row-', a.n) AS s FROM ${thousand} a CROSS JOIN ${thousand} b`, {
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
      const literal = await driver.query('SELECT ? AS s', ['${env:HOME}']);
      expect(literal).toEqual([{ s: '${env:HOME}' }]);
      const slowQuery = driver.query(slow()) as Promise<unknown> & { cancel: () => Promise<void> };
      await new Promise((resolve) => { setTimeout(resolve, 3000); });
      await slowQuery.cancel();
      await expect(slowQuery).rejects.toThrow(/cancel/i);
    } finally {
      await driver.release();
    }
  });

  test('the catalog: schemas, tables and their columns with Hive\'s types (R4 test 5)', async () => {
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
          .rejects.toThrow(/didn't complete the sign-in within 3000 ms/);
        expect(Date.now() - started).toBeLessThan(6000);
      } finally {
        await silent.close();
      }
    });

    test('a connection reset mid-statement rejects at once, and the driver serves on (R4 test 1)', async () => {
      const pass = await proxy('pass');
      const driver = new HiveDriver({ ...config(), host: '127.0.0.1', port: pass.port, maxPoolSize: 1 });
      try {
        const query = driver.query(slow());
        await new Promise((resolve) => { setTimeout(resolve, 3000); });
        const started = Date.now();
        pass.reset();
        await expect(query).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(5000);
        // The failed connection isn't given back: a new one answers.
        expect(await driver.query('SELECT 1 AS a')).toEqual([{ a: 1 }]);
      } finally {
        await driver.release();
        await pass.close();
      }
    });

    test('a wrong port, and the connection test\'s step failing with the driver\'s words', async () => {
      const driver = DRIVERS.hive.make!(DRIVERS.hive.config({ ...fields, host: '127.0.0.1', port: 1 }, 'username', {}));
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

    const rowsOf = async (query: Record<string, unknown>) => {
      const built = new XcubeHiveQuery(compiled, { timezone: 'UTC', ...query });
      const [sql, params] = built.buildSqlAndParams();
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

    test('a date range, a count distinct, a limit with an offset and an order', async () => {
      const rows = await rowsOf({
        measures: ['f.n', 'f.names'],
        dimensions: ['f.name'],
        timeDimensions: [{ dimension: 'f.at', dateRange: ['2026-01-01', '2026-06-30'] }],
        order: [{ id: 'f.name', desc: false }],
        rowLimit: 2,
        offset: 1,
      });
      // In the range: a%_'x, east (1, 4), west (2); ordered, the second and third.
      expect(rows).toEqual([{ f__name: 'east', f__n: 2, f__names: 1 }, { f__name: 'west', f__n: 1, f__names: 1 }]);
    });

    test('`contains` holding %, _ and \', case-insensitively', async () => {
      const count = async (operator: string, value: string) => Number((await rowsOf({
        measures: ['f.n'], filters: [{ member: 'f.name', operator, values: [value] }],
      }))[0].f__n);
      expect(await count('contains', '%_\'')).toBe(1);
      expect(await count('contains', 'A%_\'X')).toBe(1);
      expect(await count('contains', '%')).toBe(1);
      expect(await count('notContains', '_')).toBe(FACTS.length - 1);
      expect(await count('startsWith', 'ea')).toBe(3);
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
  });
});

/**
 * TLS (R3 test 5), when given a HiveServer2 with `hive.server2.use.SSL` on:
 *
 *   XCUBE_TEST_HIVE_TLS        its binary port as host:port, its certificate for that host name
 *   XCUBE_TEST_HIVE_TLS_CA     a PEM file of the CA that signed it
 *   XCUBE_TEST_HIVE_TLS_OTHER  a PEM file of a CA that didn't
 */
const TLS = process.env.XCUBE_TEST_HIVE_TLS;

(TLS ? describe : describe.skip)('Hive over TLS', () => {
  // eslint-disable-next-line global-require
  const fs = require('fs');
  const [host, port] = (TLS ?? 'x:0').split(':');
  const ca = TLS ? fs.readFileSync(process.env.XCUBE_TEST_HIVE_TLS_CA!, 'utf8') : '';
  const other = TLS ? fs.readFileSync(process.env.XCUBE_TEST_HIVE_TLS_OTHER!, 'utf8') : '';
  const driver = (over: Record<string, unknown>) => DRIVERS.hive.make!(DRIVERS.hive.config({
    host, port: Number(port), database: 'default', user: 'hive', ssl: true, ...over,
  }, 'username', {}));
  const connects = async (over: Record<string, unknown>) => {
    const d = driver(over);
    try {
      await d.testConnection();
    } finally {
      await d.release();
    }
  };

  test('connects with the CA that signed the server\'s certificate', async () => {
    await connects({ sslCa: ca });
  });

  test('refuses a certificate the CA doesn\'t sign', async () => {
    await expect(connects({ sslCa: other })).rejects.toThrow(/certificate/i);
    // The system's CAs alone: a private CA's certificate isn't trusted.
    await expect(connects({})).rejects.toThrow(/certificate/i);
  });

  test('connects to it all the same with sslRejectUnauthorized false', async () => {
    await connects({ sslCa: other, sslRejectUnauthorized: false });
  });

  test('a connection without TLS to its TLS port fails', async () => {
    await expect(connects({ ssl: false })).rejects.toThrow();
  });
});
