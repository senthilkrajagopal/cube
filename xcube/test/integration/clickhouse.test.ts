/**
 * The SQL runner on a real ClickHouse, through xcube's own driver and run
 * path, with no store: a run's checks, caps, binds, stop and cancel, and the
 * connection test's steps. Runs when given:
 *
 *   XCUBE_TEST_CLICKHOUSE          a ClickHouse's HTTP port as host:port, with a database `shop`
 *                                  (orders: id UInt64, customer String, amount Decimal(18, 2), at DateTime;
 *                                  customers: name String, tier String, c1 and c2 only) and a user
 *                                  wechart/pw with readonly=2 and SELECT on shop.* alone, as wechart's compose's
 *   XCUBE_TEST_CLICKHOUSE_ADMIN    user:password of a login that reads system.processes and system.query_log
 */
import crypto from 'crypto';
import { createClient } from '@clickhouse/client';

import { DRIVERS } from '../../src/connections/drivers';
import { SqlRunError } from '../../src/sql/runner';
import { SqlRuns, type SqlRunRequest, type SqlTarget } from '../../src/sql/runs';

const CLICKHOUSE = process.env.XCUBE_TEST_CLICKHOUSE;
const ADMIN = process.env.XCUBE_TEST_CLICKHOUSE_ADMIN;

jest.setTimeout(120 * 1000);

(CLICKHOUSE ? describe : describe.skip)('the SQL runner on ClickHouse', () => {
  const [host, port] = (CLICKHOUSE ?? 'x:0').split(':');
  const fields = { host, port: Number(port), database: 'shop', user: 'wechart', ssl: false };
  const runs = new SqlRuns('here', () => null, () => undefined);
  const admin = ADMIN ? createClient({
    url: `http://${CLICKHOUSE}`,
    username: ADMIN.slice(0, ADMIN.indexOf(':')),
    password: ADMIN.slice(ADMIN.indexOf(':') + 1),
  }) : null;
  const mark = crypto.randomBytes(4).toString('hex');

  afterAll(async () => {
    await admin?.close();
  });

  const target = (over: Record<string, unknown> = {}): SqlTarget => ({
    dialect: 'clickhouse',
    label: 'ch',
    build: async (caps) => ({
      driver: DRIVERS.clickhouse.make!({
        ...DRIVERS.clickhouse.config({ ...fields, ...over }, 'password', { password: 'pw' }),
        requestTimeout: caps.timeoutMs + 30000,
      }),
      secrets: ['pw'],
    }),
  });
  const run = (sql: string, more: Partial<SqlRunRequest> = {}) => runs.run('m', target(), {
    sql, runId: crypto.randomUUID(), maxRows: 100, timeoutMs: 30000, maxBytes: 10 * 1024 * 1024, ...more,
  });
  const failure = (promise: Promise<unknown>) => promise.then(
    () => { throw new Error('the run answered'); },
    (e) => {
      expect(e).toBeInstanceOf(SqlRunError);
      return e as SqlRunError;
    },
  );
  const adminRows = async (query: string) => {
    const result = await admin!.query({ query, format: 'JSONEachRow' });
    return result.json<Record<string, unknown>>();
  };

  test('a read: its columns and types; 64-bit integers and decimals as strings; a join\'s unmatched rows as nulls', async () => {
    const answer = await run(`SELECT o.id, o.amount, o.at, c.tier FROM orders o LEFT JOIN customers c ON c.name = o.customer
      WHERE o.id < 3 ORDER BY o.id`);
    expect(answer.columns).toEqual([
      { name: 'id', type: 'UInt64' }, { name: 'amount', type: 'Decimal(18, 2)' },
      { name: 'at', type: 'DateTime' }, { name: 'tier', type: 'Nullable(String)' },
    ]);
    expect(answer.rows).toEqual([
      ['0', '0', '2024-01-01T00:00:00Z', null],
      ['1', '0.25', '2024-01-01T00:00:01Z', 'gold'],
      ['2', '0.5', '2024-01-01T00:00:02Z', 'silver'],
    ]);
    expect(answer.truncated).toBeNull();
    expect((await run('EXPLAIN SELECT 1')).statement).toBe('explain');
  });

  test('the row cap: the first rows, marked truncated', async () => {
    const answer = await run('SELECT number FROM numbers(1000000)', { maxRows: 5 });
    expect(answer.rowCount).toBe(5);
    expect(answer.truncated).toBe('rows');
  });

  test('refused before they run: url(), a FROM\'s other table functions, SETTINGS and FORMAT, and writes', async () => {
    const refused = [
      `SELECT * FROM url('http://169.254.169.254/latest/meta-data/x${mark}', CSV, 'a String')`,
      `SELECT * FROM numbers(1) WHERE 1 IN (SELECT 1 FROM s3('http://x${mark}/a.csv'))`,
      'SELECT * FROM orders, mergeTreeIndex(shop, orders) LIMIT 1',
      'SELECT 1 SETTINGS readonly = 0',
      'SELECT 1 FORMAT TSV',
      `INSERT INTO orders SELECT * FROM orders WHERE customer = '${mark}'`,
    ];
    for (const sql of refused) {
      expect((await failure(run(sql))).code).toBe('not_read_only');
    }
    if (admin) {
      await admin.command({ query: 'SYSTEM FLUSH LOGS' });
      expect(await adminRows(`SELECT query FROM system.query_log WHERE query LIKE '%${mark}%' AND query NOT LIKE '%query_log%'`)).toEqual([]);
    }
  });

  test('the run\'s settings as ClickHouse reads them: readonly=2, and the row cap\'s one more row', async () => {
    const answer = await run('SELECT getSetting(\'readonly\'), getSetting(\'max_result_rows\')', { maxRows: 7 });
    expect(answer.rows).toEqual([[2, 8]]);
  });

  test('bound values: text, a decimal, a Date32 and a Boolean, as data', async () => {
    const answer = await runs.run('m', target(), {
      sql: 'SELECT {{t}} AS t, toTypeName({{t}}), {{n}} * 2, {{d}}, {{b}}, count() FROM orders WHERE customer = {{t}}',
      runId: crypto.randomUUID(),
      maxRows: 10,
      timeoutMs: 30000,
      maxBytes: 1024 * 1024,
      parameters: {
        t: { type: 'text', value: 'c1\' OR \'1\'=\'1' },
        n: { type: 'number', value: '12.25' },
        d: { type: 'date', value: '2299-12-31' },
        b: { type: 'boolean', value: true },
      },
    });
    expect(answer.rows).toEqual([['c1\' OR \'1\'=\'1', 'String', '24.5', '2299-12-31', true, '0']]);
    const outside = await failure(runs.run('m', target(), {
      sql: 'SELECT {{d}}', runId: crypto.randomUUID(), maxRows: 1, timeoutMs: 30000, maxBytes: 1024, parameters: { d: { type: 'date', value: '1899-12-31' } },
    }));
    expect(outside.code).toBe('invalid_parameters');
  });

  test('the timeout: ClickHouse\'s own, in whole seconds', async () => {
    const e = await failure(run('SELECT sum(number) FROM numbers(1000000000000)', { timeoutMs: 1000 }));
    expect(e.code).toBe('timeout');
    expect(e.message).toMatch(/ran past/);
  });

  test('a cancel lets the request go, and ClickHouse stops the query', async () => {
    const runId = crypto.randomUUID();
    const running = failure(runs.run('m', target(), {
      sql: `SELECT sum(number), '${mark}-cancel' FROM numbers(1000000000000)`, runId, maxRows: 10, timeoutMs: 60000, maxBytes: 1024,
    }));
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
    expect(await runs.cancel('m', runId)).toEqual({ found: true });
    const e = await running;
    expect(e.code).toBe('cancelled');
    if (admin) {
      let left: unknown[] = [];
      for (let i = 0; i < 20; i++) {
        left = await adminRows(`SELECT query_id FROM system.processes WHERE query LIKE '%${mark}-cancel%' AND query NOT LIKE '%system.processes%'`);
        if (!left.length) {
          break;
        }
        await new Promise((resolve) => { setTimeout(resolve, 250); });
      }
      expect(left).toEqual([]);
    }
  });

  test('the connection test: a database that isn\'t there fails it', async () => {
    const good = DRIVERS.clickhouse.make!(DRIVERS.clickhouse.config(fields, 'password', { password: 'pw' }));
    await good.testConnection();
    await expect(good.getSchemas()).resolves.toEqual([{ schema_name: 'shop' }]);
    await good.release();
    const missing = DRIVERS.clickhouse.make!(DRIVERS.clickhouse.config({ ...fields, database: `none_${mark}` }, 'password', { password: 'pw' }));
    await expect((async () => {
      await missing.testConnection();
      await missing.getSchemas();
    })()).rejects.toThrow(/UNKNOWN_DATABASE|does not exist/);
    await missing.release();
  });
});
