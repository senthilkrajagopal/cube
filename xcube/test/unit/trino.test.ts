/**
 * Trino through xcube's own driver and run path, against a double of Trino's
 * client protocol in this process: it answers in pages, fails mid-result,
 * runs on until killed, and records each statement, header and kill.
 */
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

import { DRIVERS } from '../../src/connections/drivers';
import { TRINO_JSON } from '../../src/connections/trino';
import { isTimeout, SqlRunError } from '../../src/sql/runner';
import { SqlRuns, type SqlRunRequest, type SqlTarget } from '../../src/sql/runs';

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const COLUMNS = [{ name: 'n', type: 'bigint' }, { name: 's', type: 'varchar(5)' }];
const PAGES = [[[1, 'a'], [2, 'b']], [[3, 'c']], [[4, 'd'], [5, 'e']]];

/**
 * The double. Each statement is one of: three pages, then done; a page, then
 * Trino's error; pages of 100 rows without end; or running without rows. A
 * statement runs on until killed (DELETE /v1/query/{id}) or cancelled
 * (DELETE on its next URI), then answers USER_CANCELED.
 */
class TrinoDouble {
  public readonly seen: Seen[] = [];

  public readonly killed = new Set<string>();

  protected readonly queries = new Map<string, { sql: string; page: number }>();

  protected server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => this.answer(req, res, body));
  });

  public port = 0;

  public password = 'pw';

  public async start() {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  public async stop() {
    await new Promise((resolve) => {
      this.server.close(resolve);
    });
  }

  public statements() {
    return this.seen.filter((s) => s.method === 'POST').map((s) => s.body);
  }

  protected answer(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
    // presto-client sends a cancel's DELETE with its next URI whole as the path.
    const { pathname } = new URL(req.url!, 'http://x');
    this.seen.push({ method: req.method!, path: pathname, headers: req.headers, body });
    const json = (value: unknown, raw?: string) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(raw ?? JSON.stringify(value));
    };
    const expected = `Basic ${Buffer.from(`analyst:${this.password}`).toString('base64')}`;
    if (req.headers.authorization !== expected) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }
    const kill = /^\/v1\/query\/([^/]+)$/.exec(pathname);
    if (req.method === 'DELETE') {
      const id = kill?.[1] ?? /^\/v1\/statement\/executing\/([^/]+)\//.exec(pathname)?.[1];
      if (id) {
        this.killed.add(id);
      }
      res.writeHead(204);
      res.end();
      return;
    }
    const at = (id: string, page: number) => `http://127.0.0.1:${this.port}/v1/statement/executing/${id}/y${page}/${page}`;
    if (req.method === 'POST' && pathname === '/v1/statement') {
      const id = `20261030_${crypto.randomBytes(3).toString('hex')}`;
      this.queries.set(id, { sql: body, page: 0 });
      json({ id, infoUri: `http://127.0.0.1:${this.port}/ui/query.html?${id}`, nextUri: at(id, 1), stats: { state: 'QUEUED' } });
      return;
    }
    const id = /^\/v1\/statement\/executing\/([^/]+)\//.exec(pathname)?.[1] ?? '';
    const query = this.queries.get(id);
    if (!query) {
      res.writeHead(404);
      res.end();
      return;
    }
    query.page += 1;
    const { page, sql } = query;
    const base = { id, infoUri: `http://127.0.0.1:${this.port}/ui/query.html?${id}` };
    if (this.killed.has(id)) {
      json({ ...base, stats: { state: 'FAILED' }, error: { message: 'Query was canceled', errorName: 'USER_CANCELED', errorCode: 3 } });
    } else if (/forever/.test(sql)) {
      json({ ...base, nextUri: at(id, page + 1), stats: { state: 'RUNNING' } });
    } else if (/many/.test(sql)) {
      const data = Array.from({ length: 100 }, (_, i) => [(page - 1) * 100 + i, 'x']);
      json({ ...base, columns: COLUMNS, data, nextUri: at(id, page + 1), stats: { state: 'RUNNING' } });
    } else if (/broken/.test(sql) && page === 2) {
      json({ ...base, stats: { state: 'FAILED' }, error: { message: 'Division by zero', errorName: 'DIVISION_BY_ZERO', errorCode: 8 } });
    } else if (/big/.test(sql)) {
      json(null, `{"id":"${id}","infoUri":"${base.infoUri}","columns":[{"name":"n","type":"bigint"}],"data":[[9007199254740993],[-12]],"stats":{"state":"FINISHED"}}`);
    } else if (/schemata/.test(sql)) {
      json({ ...base, columns: [{ name: 'schema_name', type: 'varchar' }], data: [['sales'], ['empty']], stats: { state: 'FINISHED' } });
    } else {
      const last = page >= PAGES.length;
      json({
        ...base,
        columns: COLUMNS,
        data: PAGES[page - 1],
        ...(last ? {} : { nextUri: at(id, page + 1) }),
        stats: { state: last ? 'FINISHED' : 'RUNNING' },
      });
    }
  }
}

const fields = { host: '127.0.0.1', catalog: 'hive', schema: 'sales', user: 'analyst' };

describe('Trino, against a double of its client protocol', () => {
  const trino = new TrinoDouble();
  const make = (password = 'pw', over: Record<string, unknown> = {}) => {
    const driver: any = DRIVERS.trino.make!({
      ...DRIVERS.trino.config({ ...fields, port: trino.port }, 'password', { password }),
      dataSource: 'conn_x',
      ...over,
    });
    // The double speaks HTTP: the connection's own config always asks for HTTPS (AC-1024).
    expect(driver.client.protocol).toBe('https:');
    driver.client.protocol = 'http:';
    driver.client.checkInterval = 5;
    return driver;
  };

  beforeAll(() => trino.start());
  afterAll(() => trino.stop());

  test('the driver is built from the connection alone, whatever Cube\'s environment holds, and the environment is put back', () => {
    const warn = jest.spyOn(console, 'warn');
    const poison = {
      CUBEJS_DB_USER: 'poison-user',
      CUBEJS_DB_PASS: 'poison-pass',
      CUBEJS_DB_PRESTO_AUTH_TOKEN: 'poison-token',
      CUBEJS_DB_EXPORT_BUCKET_TYPE: 'nowhere',
      CUBEJS_DB_EXPORT_BUCKET: 'poison-bucket',
      CUBEJS_DB_SSL: 'true',
      CUBEJS_DB_SSL_CA: '/poison/ca.pem',
      CUBEJS_DATASOURCES: 'default',
      CUBEJS_DB_QUERY_TIMEOUT: '1s',
    };
    const before = { ...process.env };
    Object.assign(process.env, poison);
    try {
      const driver = make();
      expect(JSON.stringify(driver.config)).not.toMatch(/poison/);
      expect(driver.config).toMatchObject({
        host: '127.0.0.1', catalog: 'hive', schema: 'sales', user: 'analyst', basic_auth: { user: 'analyst', password: 'pw' },
        ssl: { rejectUnauthorized: true }, queryTimeout: 600, exportBucket: undefined,
      });
      expect(driver.client.headers.USER).toBe('X-Trino-User');
      for (const [key, value] of Object.entries(poison)) {
        expect(process.env[key]).toBe(value);
      }
      expect(process.env.CUBEJS_DB_PRESTO_CATALOG).toBeUndefined();
      expect(process.env.CUBEJS_DB_NAME).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      for (const key of Object.keys(poison)) {
        if (before[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = before[key];
        }
      }
    }
  });

  test('Cube\'s reads: a result\'s pages in order, a big integer whole, and no export bucket (AC-1043)', async () => {
    const driver = make();
    expect(await driver.query('SELECT n, s FROM t ORDER BY n', [])).toEqual([
      { n: 1, s: 'a' }, { n: 2, s: 'b' }, { n: 3, s: 'c' }, { n: 4, s: 'd' }, { n: 5, s: 'e' },
    ]);
    expect(await driver.query('SELECT big', [])).toEqual([{ n: '9007199254740993' }, { n: -12 }]);
    expect(TRINO_JSON.parse('{"a":12345678901234567890,"b":1.5,"c":"9007199254740993"}')).toEqual({ a: '12345678901234567890', b: 1.5, c: '9007199254740993' });
    expect(await driver.isUnloadSupported()).toBe(false);
    await expect(driver.query('SELECT broken', [])).rejects.toThrow('Division by zero');
  });

  test('a stream that fails after its columns fails, with Trino\'s error, and doesn\'t hang (AC-1043)', async () => {
    const driver = make();
    const { rowStream, types } = await driver.stream('SELECT broken', [], {});
    expect(types).toEqual(COLUMNS);
    const read: unknown[] = [];
    await expect((async () => {
      for await (const row of rowStream) {
        read.push(row);
      }
    })()).rejects.toThrow('Division by zero');
    expect(read).toEqual([{ n: 1, s: 'a' }, { n: 2, s: 'b' }]);
    const whole = await driver.stream('SELECT n, s FROM t', [], {});
    const rows: unknown[] = [];
    for await (const row of whole.rowStream) {
      rows.push(row);
    }
    expect(rows.map((r: any) => r.n)).toEqual([1, 2, 3, 4, 5]);
  });

  test('the connection test: a SELECT as the user, so a wrong password fails; then the catalog\'s schemas (AC-1031)', async () => {
    const good = make();
    await good.testConnection();
    const select = trino.seen.filter((s) => s.method === 'POST').pop()!;
    expect(select.body).toBe('SELECT 1');
    expect(select.headers).toMatchObject({ 'x-trino-user': 'analyst', 'x-trino-catalog': 'hive' });
    expect(await good.getSchemas()).toEqual([{ schema_name: 'sales' }, { schema_name: 'empty' }]);
    expect(trino.statements().pop()).toMatch(/FROM "hive"\.information_schema\.schemata/);
    await expect(make('wrong').testConnection()).rejects.toThrow(/Unauthorized/);
  });

  describe('the SQL runner', () => {
    const runs = new SqlRuns('here', () => null, () => undefined);
    const target = (password = 'pw'): SqlTarget => ({
      dialect: 'trino',
      label: 'trino',
      build: async () => ({ driver: make(password), secrets: [password] }),
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
    const idOf = (sql: string) => {
      const posted = trino.seen.filter((s) => s.method === 'POST' && s.body === sql).pop();
      return posted ? trino.seen.find((s) => s.method === 'GET' && s.path.includes('/executing/') && trino.seen.indexOf(s) > trino.seen.indexOf(posted))!.path.split('/')[4] : null;
    };

    test('a read: its pages in order, its columns as Trino types them, with the run\'s time cap as Trino\'s', async () => {
      const answer = await run('SELECT n, s FROM t ORDER BY n');
      expect(answer.columns).toEqual([{ name: 'n', type: 'bigint' }, { name: 's', type: 'varchar(5)' }]);
      expect(answer.rows).toEqual([[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd'], [5, 'e']]);
      expect(answer.truncated).toBeNull();
      const posted = trino.seen.filter((s) => s.method === 'POST').pop()!;
      expect(posted.headers).toMatchObject({
        'x-trino-user': 'analyst', 'x-trino-catalog': 'hive', 'x-trino-schema': 'sales', 'x-trino-session': 'query_max_run_time=30s',
      });
      expect((await run('SELECT big')).rows).toEqual([['9007199254740993'], [-12]]);
    });

    test('the row cap: the first rows, marked truncated, and the query killed by its id (AC-1045)', async () => {
      const sql = `SELECT many ${crypto.randomUUID()}`;
      const answer = await run(sql, { maxRows: 250 });
      expect(answer.rowCount).toBe(250);
      expect(answer.truncated).toBe('rows');
      const id = idOf(sql)!;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      expect(trino.seen.some((s) => s.method === 'DELETE' && s.path === `/v1/query/${id}`)).toBe(true);
      // Three pages read, and polling stopped there.
      expect(trino.seen.filter((s) => s.method === 'GET' && s.path.includes(id)).length).toBeLessThanOrEqual(4);
    });

    test('a failure after its first page fails the run with Trino\'s error', async () => {
      const e = await failure(run('SELECT broken'));
      expect(e.code).toBe('query_failed');
      expect(e.message).toBe('Division by zero');
    });

    test('the time cap: the query killed on Trino, and the run timed out (AC-1045)', async () => {
      const sql = `SELECT forever ${crypto.randomUUID()}`;
      const e = await failure(run(sql, { timeoutMs: 500 }));
      expect(e.code).toBe('timeout');
      expect(trino.killed.has(idOf(sql)!)).toBe(true);
      expect(isTimeout('trino', Object.assign(new Error('Query exceeded maximum time limit of 30.00s'), { code: 'EXCEEDED_TIME_LIMIT' }))).toBe(true);
      expect(isTimeout('trino', new Error('Division by zero'))).toBe(false);
    });

    test('a cancel kills the query on Trino', async () => {
      const sql = `SELECT forever ${crypto.randomUUID()}`;
      const runId = crypto.randomUUID();
      const running = failure(run(sql, { runId }));
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      expect(await runs.cancel('m', runId)).toEqual({ found: true });
      const e = await running;
      expect(e.code).toBe('cancelled');
      expect(trino.killed.has(idOf(sql)!)).toBe(true);
    });

    test('refused statements and held parameters never reach Trino (AC-1044, AC-1046)', async () => {
      const before = trino.statements().length;
      for (const sql of [
        'CALL hive.system.drop_stats(\'s\', \'t\')', 'SET SESSION query_max_run_time = \'1h\'', 'EXPLAIN ANALYZE SELECT 1',
        'SELECT * FROM TABLE(pg.system.query(query => \'DELETE FROM t\'))', 'WITH SESSION query_max_run_time = \'1h\' SELECT 1',
      ]) {
        expect((await failure(run(sql))).code).toBe('not_read_only');
      }
      const held = await failure(run('SELECT {{n}}', { parameters: { n: { type: 'number', value: '1' } } }));
      expect(held.code).toBe('parameters_unsupported');
      expect(trino.statements().length).toBe(before);
    });

    test('a wrong password fails the run without saying the password', async () => {
      const e = await failure(runs.run('m', target('wrong-pw-mark'), {
        sql: 'SELECT 1', runId: crypto.randomUUID(), maxRows: 1, timeoutMs: 30000, maxBytes: 1024,
      }));
      expect(e.code).toBe('query_failed');
      expect(e.message).toMatch(/Unauthorized/);
      expect(e.message).not.toContain('wrong-pw-mark');
    });
  });
});
