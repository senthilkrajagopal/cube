import { EventEmitter } from 'events';
import { Readable } from 'stream';

import {
  cellOf, openSession, RowCollector, SqlRunError, type SqlCaps,
} from '../../src/sql/runner';
import { MAX_RUNS, SqlRuns, type SqlRunRegistry, type SqlTarget } from '../../src/sql/runs';

const caps: SqlCaps = { maxRows: 3, timeoutMs: 30000, maxBytes: 1024 * 1024 };
const noRefusal = (type: string): never => {
  throw new Error(`refused ${type}`);
};

describe('the SQL runner: cells and caps', () => {
  test('a cell is JSON: binary as hex, dates as ISO 8601, big integers and wrappers as their values', () => {
    expect(cellOf(Buffer.from([1, 255]))).toBe('\\x01ff');
    expect(cellOf(new Date('2024-01-02T03:04:05Z'))).toBe('2024-01-02T03:04:05.000Z');
    expect(cellOf(BigInt('9007199254740993'))).toBe('9007199254740993');
    expect(cellOf(Number.NaN)).toBe('NaN');
    // BigQuery's date and integer wrappers.
    class BigQueryDate {
      public constructor(public value: string) {}
    }
    expect(cellOf(new BigQueryDate('2024-01-02'))).toBe('2024-01-02');
    expect(cellOf({ a: [1, { b: BigInt(2) }] })).toEqual({ a: [1, { b: '2' }] });
    expect(cellOf({ toJSON: () => '1.50' })).toBe('1.50');
    expect(cellOf(undefined)).toBeNull();
  });

  test('rows are taken to the row cap, then to the byte cap; each says it truncated', () => {
    const byRows = new RowCollector(2, 1024);
    expect([byRows.add([1]), byRows.add([2]), byRows.add([3])]).toEqual([true, true, false]);
    expect(byRows).toMatchObject({ rows: [[1], [2]], truncated: 'rows' });
    const byBytes = new RowCollector(100, 256 + 40);
    expect(byBytes.add(['x'.repeat(20)])).toBe(true);
    expect(byBytes.add(['y'.repeat(20)])).toBe(false);
    expect(byBytes.truncated).toBe('bytes');
  });
});

describe('the SQL runner: each database\'s session, on drivers shaped as Cube\'s', () => {
  test('Snowflake: one statement, rows as arrays, streamed only to the cap\'s one past', async () => {
    let options: any;
    let range: any;
    const stmt = {
      getColumns: () => [{ getName: () => 'A', getType: () => 'fixed' }],
      streamRows: (r: any) => {
        range = r;
        return Readable.from([[1], [2], [3], [4], [5]]);
      },
      cancel: (cb: () => void) => cb(),
    };
    const released = jest.fn();
    const driver = {
      getConnection: async () => ({
        execute: (o: any) => {
          options = o;
          setImmediate(() => o.complete(undefined, stmt));
          return stmt;
        },
      }),
      release: released,
    };
    const session = await openSession('snowflake', driver, caps, noRefusal);
    const rows = new RowCollector(caps.maxRows, caps.maxBytes);
    await session.run('SELECT 1', rows);
    await session.close();
    expect(options).toMatchObject({ sqlText: 'SELECT 1', streamResult: true, rowMode: 'array', parameters: { MULTI_STATEMENT_COUNT: 1 } });
    expect(range).toEqual({ start: 0, end: 3 });
    expect(rows).toMatchObject({ columns: [{ name: 'A', type: 'fixed' }], rows: [[1], [2], [3]], truncated: 'rows' });
    expect(released).toHaveBeenCalled();
  });

  test('BigQuery: the dry run must call it a SELECT; then the job, with its timeout and byte limit, a page at a time', async () => {
    const jobs: any[] = [];
    const pages = [
      { rows: [{ a: 1 }, { a: 2 }], token: 'p2' },
      { rows: [{ a: 3 }, { a: 4 }], token: undefined },
    ];
    let statementType = 'SELECT';
    const asked: any[] = [];
    const driver = {
      options: { location: 'EU' },
      bigquery: {
        createQueryJob: async (o: any) => {
          jobs.push(o);
          if (o.dryRun) {
            return [{ metadata: { statistics: { query: { statementType } } } }];
          }
          return [{
            getQueryResults: async (q: any) => {
              asked.push(q);
              const page = pages[q.pageToken ? 1 : 0];
              return [page.rows, page.token ? { pageToken: page.token } : null, { schema: { fields: [{ name: 'a', type: 'INT64' }] } }];
            },
            cancel: jest.fn(),
          }];
        },
      },
    };
    const session = await openSession('bigquery', driver, { ...caps, maxBytesBilled: 1000000 }, noRefusal);
    const rows = new RowCollector(caps.maxRows, caps.maxBytes);
    await session.run('SELECT a FROM t', rows);
    expect(jobs).toEqual([
      { query: 'SELECT a FROM t', dryRun: true, useLegacySql: false, location: 'EU' },
      { query: 'SELECT a FROM t', useLegacySql: false, location: 'EU', jobTimeoutMs: '30000', maximumBytesBilled: '1000000' },
    ]);
    expect(asked.map((q) => [q.maxResults, q.pageToken])).toEqual([[4, undefined], [2, 'p2']]);
    expect(rows).toMatchObject({ columns: [{ name: 'a', type: 'INT64' }], rows: [[1], [2], [3]], truncated: 'rows' });

    statementType = 'SCRIPT';
    const refused = await openSession('bigquery', driver, caps, (type) => {
      throw new SqlRunError('not_read_only', type);
    });
    await expect(refused.run('SELECT 1; SELECT 2', new RowCollector(3, 1024))).rejects.toMatchObject({ code: 'not_read_only', message: 'SCRIPT' });
  });

  test('SQL Server: in a transaction always rolled back; rows as arrays to the cap, then the request cancelled', async () => {
    const rolledBack = jest.fn();
    let request: any;
    const driver = {
      initialConnectPromise: Promise.resolve({
        transaction: () => ({
          begin: async () => undefined,
          rollback: rolledBack,
          request: () => {
            request = new EventEmitter();
            // As mssql: a cancelled request ends with an error.
            request.cancel = jest.fn(() => setImmediate(() => {
              request.emit('error', Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
              request.emit('done');
            }));
            request.query = (sql: string) => {
              request.sql = sql;
              setImmediate(() => {
                request.emit('recordset', [{ name: 'a', type: { declaration: 'int' } }]);
                [1, 2, 3, 4, 5].forEach((n) => request.emit('row', [n]));
                if (!request.cancel.mock.calls.length) {
                  request.emit('done');
                }
              });
            };
            return request;
          },
        }),
      }),
      release: jest.fn(),
    };
    const session = await openSession('mssql', driver, caps, noRefusal);
    const rows = new RowCollector(caps.maxRows, caps.maxBytes);
    await session.run('SELECT a FROM t', rows);
    await session.close();
    expect({ stream: request.stream, arrayRowMode: request.arrayRowMode, sql: request.sql }).toEqual({ stream: true, arrayRowMode: true, sql: 'SELECT a FROM t' });
    expect(request.cancel).toHaveBeenCalled();
    expect(rows).toMatchObject({ columns: [{ name: 'a', type: 'int' }], rows: [[1], [2], [3]], truncated: 'rows' });
    expect(rolledBack).toHaveBeenCalled();
    expect(driver.release).toHaveBeenCalled();
  });

  test('Oracle: callTimeout and a read-only transaction; a result set read to the cap; rolled back and closed', async () => {
    const executed: string[] = [];
    const set = { getRows: jest.fn(async (n: number) => [[1], [2], [3], [4]].slice(0, n)), close: jest.fn() };
    const conn: any = {
      execute: jest.fn(async (sql: string, _binds: any, options: any) => {
        executed.push(sql);
        return options?.resultSet ? { metaData: [{ name: 'A', dbTypeName: 'NUMBER' }], resultSet: set } : {};
      }),
      rollback: jest.fn(),
      close: jest.fn(),
      break: jest.fn(),
    };
    const driver = {
      db: { OUT_FORMAT_ARRAY: 4001, DB_TYPE_CLOB: 'clob', DB_TYPE_NCLOB: 'nclob', DB_TYPE_BLOB: 'blob', STRING: 's', BUFFER: 'b' },
      pool: { _factory: { create: async () => conn } },
    };
    const session = await openSession('oracle', driver, caps, noRefusal);
    const rows = new RowCollector(caps.maxRows, caps.maxBytes);
    await session.run('SELECT a FROM t', rows);
    await session.cancel();
    await session.close();
    expect(conn.callTimeout).toBe(30000);
    expect(executed).toEqual(['SET TRANSACTION READ ONLY', 'SELECT a FROM t']);
    expect(conn.execute.mock.calls[1][2]).toMatchObject({ resultSet: true, outFormat: 4001, fetchArraySize: 100, prefetchRows: 100 });
    expect(conn.execute.mock.calls[1][2].fetchTypeHandler({ dbType: 'clob' })).toEqual({ type: 's' });
    expect(set.getRows).toHaveBeenCalledWith(4);
    expect(rows).toMatchObject({ columns: [{ name: 'A', type: 'NUMBER' }], rows: [[1], [2], [3]], truncated: 'rows' });
    expect(set.close).toHaveBeenCalled();
    expect(conn.break).toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalled();
  });

  test('Dremio: the job polled, its pages read only to the cap, and cancelled through its API', async () => {
    const offsets: number[] = [];
    let polls = 0;
    const posted: string[] = [];
    const driver = {
      getToken: async () => 'token',
      executeQuery: async () => 'job-1',
      getJobStatus: async () => (++polls < 2 ? null : { rowCount: 2000 }),
      getJobResults: async (_id: string, limit: number, offset: number) => {
        offsets.push(offset);
        return {
          data: {
            schema: [{ name: 'a', type: { name: 'INTEGER' } }, { name: 'b', type: { name: 'VARCHAR' } }],
            rows: Array.from({ length: limit }, (_x, i) => ({ b: `r${offset + i}`, a: offset + i })),
          },
        };
      },
      restDremioQuery: async (method: string, path: string) => {
        posted.push(`${method} ${path}`);
      },
      release: jest.fn(),
    };
    const session = await openSession('dremio', driver, { ...caps, maxRows: 600 }, noRefusal);
    const rows = new RowCollector(600, 10 * 1024 * 1024);
    await session.run('SELECT a, b FROM t', rows);
    await session.cancel();
    expect(offsets).toEqual([0, 500]);
    expect(rows.rows.length).toBe(600);
    expect(rows.rows[1]).toEqual([1, 'r1']);
    expect(rows.truncated).toBe('rows');
    expect(posted).toEqual(['post /job/job-1/cancel']);
  });
});

describe('the SQL runner: runs', () => {
  /** A Cube Store-shaped driver: answers every row at once, or waits until let go. */
  const cubeStoreTarget = (answer: () => Promise<any[]>, secrets: string[] = []): SqlTarget & { released: jest.Mock; sent: string[] } => {
    const released = jest.fn();
    const sent: string[] = [];
    return {
      dialect: 'cubestore',
      label: 'cubestore',
      released,
      sent,
      build: async () => ({
        driver: {
          query: (sql: string) => {
            sent.push(sql);
            return answer();
          },
          release: released,
        },
        secrets,
      }),
    };
  };
  const memoryRegistry = () => {
    const runs = new Map<string, { model: string; instance: string }>();
    const announced: any[] = [];
    const registry: SqlRunRegistry & { runs: typeof runs; announced: any[] } = {
      runs,
      announced,
      startSqlRun: async (runId, model, instance) => {
        if (runs.has(runId)) {
          return false;
        }
        runs.set(runId, { model, instance });
        return true;
      },
      endSqlRun: async (runId) => {
        runs.delete(runId);
      },
      sqlRunInstance: async (runId, model) => (runs.get(runId)?.model === model ? runs.get(runId)!.instance : null),
      announceSqlCancel: async (model, runId, instance) => {
        announced.push({ model, runId, instance });
      },
    };
    return registry;
  };
  const request = (over: object = {}) => ({
    sql: 'SELECT a FROM s.t ORDER BY a', runId: 'r1', maxRows: 2, timeoutMs: 30000, maxBytes: 1024 * 1024, ...over,
  });

  test('a run: checked, capped, noted while it runs, and let go', async () => {
    const registry = memoryRegistry();
    const runs = new SqlRuns('here', () => registry, () => undefined);
    const target = cubeStoreTarget(async () => [{ a: '1' }, { a: '2' }, { a: '3' }]);
    const answer = await runs.run('m', target, request());
    expect(target.sent).toEqual(['SELECT a FROM s.t ORDER BY a\nLIMIT 3']);
    expect(answer).toMatchObject({
      columns: [{ name: 'a', type: null }], rows: [['1'], ['2']], rowCount: 2, truncated: 'rows', statement: 'select', redactedSql: 'SELECT a FROM s.t ORDER BY a',
    });
    expect(target.released).toHaveBeenCalled();
    expect(registry.runs.size).toBe(0);
    expect(runs.running).toBe(0);
  });

  test('refused before anything connects, with the SQL redacted', async () => {
    const target = cubeStoreTarget(async () => []);
    const build = jest.spyOn(target, 'build');
    const runs = new SqlRuns('here', () => null, () => undefined);
    await expect(runs.run('m', target, request({ sql: 'CACHE GET \'secret-key\'' }))).rejects.toMatchObject({
      code: 'not_read_only', statement: 'cache', redactedSql: 'CACHE GET ?',
    });
    expect(build).not.toHaveBeenCalled();
  });

  test('a failure is redacted of the connection\'s secrets', async () => {
    const runs = new SqlRuns('here', () => null, () => undefined);
    const target = cubeStoreTarget(async () => {
      throw new Error('auth failed for s3cr3t-value');
    }, ['s3cr3t-value']);
    await expect(runs.run('m', target, request())).rejects.toMatchObject({ code: 'query_failed', message: 'auth failed for [redacted]' });
  });

  test('the clock stops a run past its time; a cancel stops it at once, here or through the instance running it', async () => {
    const registry = memoryRegistry();
    const runs = new SqlRuns('here', () => registry, () => undefined);
    // A statement that ends only when its connection goes.
    const hanging = () => {
      let fail: (e: Error) => void = () => undefined;
      const target = cubeStoreTarget(() => new Promise((_resolve, reject) => {
        fail = reject;
      }));
      target.released.mockImplementation(() => fail(new Error('connection closed')));
      return target;
    };
    const started = Date.now();
    await expect(runs.run('m', hanging(), request({ runId: 'slow', timeoutMs: 10 }))).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(4000);

    const running = runs.run('m', hanging(), request({ runId: 'r2' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registry.runs.get('r2')).toEqual({ model: 'm', instance: 'here' });
    expect(await runs.cancel('other-model', 'r2')).toEqual({ found: false });
    expect(await runs.cancel('m', 'r2')).toEqual({ found: true });
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });

    registry.runs.set('elsewhere', { model: 'm', instance: 'there' });
    expect(await runs.cancel('m', 'elsewhere')).toEqual({ found: true });
    expect(registry.announced).toEqual([{ model: 'm', runId: 'elsewhere', instance: 'there' }]);
    expect(await runs.cancel('m', 'gone')).toEqual({ found: false });
  });

  test('a run stopped at its time cap, or cancelled, answers the rows it read before, marked stopped', async () => {
    // A SQL Server-shaped driver: three rows, then nothing until it is cancelled.
    const slow = (): SqlTarget => ({
      dialect: 'mssql',
      label: 'mssql',
      build: async () => ({
        secrets: [],
        driver: {
          release: jest.fn(),
          initialConnectPromise: Promise.resolve({
            transaction: () => ({
              begin: async () => undefined,
              rollback: async () => undefined,
              request: () => {
                const asked: any = new EventEmitter();
                asked.query = () => setImmediate(() => {
                  asked.emit('recordset', [{ name: 'n', type: { declaration: 'int' } }]);
                  [1, 2, 3].forEach((n) => asked.emit('row', [n]));
                });
                asked.cancel = () => setImmediate(() => {
                  asked.emit('error', Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
                  asked.emit('done');
                });
                return asked;
              },
            }),
          }),
        },
      }),
    });
    const runs = new SqlRuns('here', () => null, () => undefined);
    const read = { columns: [{ name: 'n', type: 'int' }], rows: [[1], [2], [3]], rowCount: 3, truncated: 'stopped' };
    await expect(runs.run('m', slow(), request({ sql: 'SELECT n FROM t', runId: 't1', timeoutMs: 10, maxRows: 10 })))
      .rejects.toMatchObject({ code: 'timeout', partial: read });
    const running = runs.run('m', slow(), request({ sql: 'SELECT n FROM t', runId: 'c1', maxRows: 10 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runs.cancel('m', 'c1');
    await expect(running).rejects.toMatchObject({ code: 'cancelled', partial: read });
    // A refusal, or a failure, has none.
    await expect(runs.run('m', slow(), request({ sql: 'DELETE FROM t', runId: 'd1' }))).rejects.toMatchObject({ code: 'not_read_only', partial: null });
  });

  test('one run per id, and at most so many at once on an instance', async () => {
    const runs = new SqlRuns('here', () => null, () => undefined);
    const releases: (() => void)[] = [];
    const waiting = () => cubeStoreTarget(() => new Promise((resolve) => {
      releases.push(() => resolve([]));
    }));
    const running = Array.from({ length: MAX_RUNS }, (_x, i) => runs.run('m', waiting(), request({ runId: `r${i}` })));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(runs.run('m', waiting(), request({ runId: 'r0' }))).rejects.toMatchObject({ code: 'run_in_progress' });
    await expect(runs.run('m', waiting(), request({ runId: 'one-more' }))).rejects.toMatchObject({ code: 'busy' });
    releases.forEach((release) => release());
    await Promise.all(running);
    expect(runs.running).toBe(0);
  });
});
