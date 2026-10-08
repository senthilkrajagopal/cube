/**
 * The SQL runner: read-only SQL on a model's data source, or on Cube Store,
 * for wechart's server alone. Each run gets a driver of its own, never one
 * Cube serves with, so nothing it sets outlives it. On it, the statement runs
 * as far as the database allows only as a read:
 *
 * - it passed the check (`classify.ts`): one statement, a SELECT or an
 *   EXPLAIN without ANALYZE, nothing in it that writes or locks;
 * - in a read-only transaction where the database has one (PostgreSQL,
 *   Redshift, MySQL, Oracle), which is always rolled back; on SQL Server in a
 *   transaction that is always rolled back; BigQuery's dry run must call it a
 *   SELECT before it runs;
 * - with the database's own statement timeout where it has one, and a clock
 *   of xcube's that cancels it on the database;
 * - its rows read as they come, up to the cap of rows and of bytes, and no
 *   further: a database that answers every row at once (Cube Store) is asked
 *   for one row more than the cap.
 */
import type { StatementKind } from './classify';

export interface SqlColumn {
  name: string;
  /** The database's name for its type, as its driver reports it; `null` where it reports none (Cube Store). */
  type: string | null;
}

export interface SqlCaps {
  maxRows: number;
  timeoutMs: number;
  maxBytes: number;
  /** BigQuery: fails the job, without charge, past this many bytes billed. */
  maxBytesBilled?: number;
}

/** The rows a run read: all of them, or those before a cap (`rows`, `bytes`) or a stop (`stopped`). */
export interface SqlRows {
  columns: SqlColumn[];
  rows: unknown[][];
  rowCount: number;
  truncated: 'rows' | 'bytes' | 'stopped' | null;
}

export interface SqlAnswer extends SqlRows {
  durationMs: number;
  statement: StatementKind;
  redactedSql: string;
}

/** How a run failed: refused, stopped, or failed on the database. */
export type SqlFailure = 'not_read_only' | 'several_statements' | 'timeout' | 'cancelled' | 'connect_failed' | 'query_failed'
  | 'unknown_connection' | 'unknown_overlay' | 'run_in_progress' | 'busy';

export class SqlRunError extends Error {
  public constructor(
    public readonly code: SqlFailure,
    message: string,
    public readonly redactedSql: string | null = null,
    public readonly statement: string | null = null,
    public readonly durationMs: number | null = null,
    /** A run stopped at its time cap or cancelled: the rows it read before. */
    public readonly partial: SqlRows | null = null,
    /** A stopped run the database runs on (Cube Store): when it ends at the latest, `endsBy: null` when nothing bounds it. */
    public readonly runsOn: { endsBy: Date | null } | null = null,
    /** Why a refusal refused, for the client to word: `cubestore_router_join`. */
    public readonly reason: string | null = null,
  ) {
    super(message);
  }
}

/** A JSON value for a cell: binary as `\x` and hex, dates as ISO 8601, big numbers as strings. */
export function cellOf(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return value.toString();
    case 'object': {
      if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
      }
      if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return `\\x${Buffer.from(value).toString('hex')}`;
      }
      if (Array.isArray(value)) {
        return value.map(cellOf);
      }
      if (typeof (value as any).toJSON === 'function') {
        return cellOf((value as any).toJSON());
      }
      const keys = Object.keys(value);
      // BigQuery's wrappers of a date, time, timestamp or integer: `{ value }`.
      if (keys.length === 1 && keys[0] === 'value' && value.constructor !== Object) {
        return cellOf((value as any).value);
      }
      return Object.fromEntries(keys.map((k) => [k, cellOf((value as any)[k])]));
    }
    default:
      return String(value);
  }
}

/** The rows of a run, as they come, up to its caps. */
export class RowCollector {
  public columns: SqlColumn[] = [];

  public readonly rows: unknown[][] = [];

  public truncated: 'rows' | 'bytes' | null = null;

  protected bytes = 256;

  public constructor(protected readonly maxRows: number, protected readonly maxBytes: number) {}

  public setColumns(columns: SqlColumn[]) {
    this.columns = columns;
    this.bytes += Buffer.byteLength(JSON.stringify(columns), 'utf8');
  }

  /** Takes a row; `false` once it holds as many as the caps allow, and the run should stop reading. */
  public add(row: unknown[]): boolean {
    if (this.truncated) {
      return false;
    }
    if (this.rows.length >= this.maxRows) {
      this.truncated = 'rows';
      return false;
    }
    const cells = row.map(cellOf);
    const size = Buffer.byteLength(JSON.stringify(cells), 'utf8') + 1;
    if (this.bytes + size > this.maxBytes) {
      this.truncated = 'bytes';
      return false;
    }
    this.bytes += size;
    this.rows.push(cells);
    return true;
  }

  public get full(): boolean {
    return this.truncated !== null;
  }

  /** The rows read before a stop, as they stand: a session let go of may still be adding. */
  public stopped(): SqlRows {
    const rows = this.rows.slice();
    return { columns: this.columns, rows, rowCount: rows.length, truncated: 'stopped' };
  }
}

/** A run's connection: the statement run on it, stopped on the database, and let go. */
export interface SqlSession {
  run(sql: string, rows: RowCollector): Promise<void>;
  /** Stops the statement on the database, as far as it can; never throws. */
  cancel(): Promise<void>;
  /** Where the database can't stop a statement (Cube Store): resolves once it has really ended; never rejects. */
  ended?(): Promise<void>;
  /** Whether the database's own query timeout ends the statement (Cube Store's select workers), once it has run. */
  endsAtTimeout?(): boolean;
  /** Rolls back, and lets the connection go; never throws. */
  close(): Promise<void>;
}

/** Refuses a statement a database's own check found not to be one read (BigQuery's dry run, Cube Store's plan). */
export type Refuse = (message: string, statement: string, reason?: string) => never;

export type SessionDialect = 'postgres' | 'redshift' | 'mysql' | 'snowflake' | 'bigquery' | 'mssql' | 'oracle' | 'dremio' | 'cubestore';

const quietly = async (fn: () => unknown) => {
  try {
    await fn();
  } catch {
    // Best effort: the connection goes anyway.
  }
};

const sleep = (ms: number) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** How many rows to read at a time: never more than the cap's one past. */
const batchOf = (rows: RowCollector, maxRows: number) => Math.max(1, Math.min(500, maxRows + 1 - rows.rows.length));

/**
 * PostgreSQL and Redshift: a connection of the run's own, in a read-only
 * transaction with `statement_timeout`, the statement through a cursor (the
 * extended protocol, which takes one statement) read a batch at a time.
 */
async function pgSession(driver: any, dialect: 'postgres' | 'redshift', caps: SqlCaps): Promise<SqlSession> {
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const Cursor = require('pg-cursor');
  const client = await driver.pool._factory.create();
  let open = true;
  try {
    // UTC, the timeout, and the database's own types, as Cube's driver prepares a connection.
    await driver.prepareConnection(client, { executionTimeout: caps.timeoutMs });
    if (dialect === 'postgres') {
      // The check reads a backslash as a character in a string.
      await client.query('SET standard_conforming_strings = on');
    }
    await client.query('BEGIN READ ONLY');
  } catch (e) {
    await quietly(() => driver.pool._factory.destroy(client));
    throw e;
  }
  return {
    async run(sql, rows) {
      const cursor = client.query(new Cursor(sql, [], { rowMode: 'array', types: { getTypeParser: driver.getTypeParser } }));
      const columnsOf = (result: any) => {
        if (!rows.columns.length && result?.fields) {
          rows.setColumns(result.fields.map((f: any) => ({
            name: f.name,
            type: driver.getPostgresTypeForField?.(f.dataTypeID) ?? `oid ${f.dataTypeID}`,
          })));
        }
      };
      // The columns as soon as the server describes them, before any row: a stop then still has them.
      const describe = cursor.handleRowDescription?.bind(cursor);
      if (describe) {
        cursor.handleRowDescription = (msg: any) => {
          describe(msg);
          columnsOf(msg);
        };
      }
      // Each row as it arrives, not a batch at a time: a stop keeps those read before it.
      let more = true;
      cursor.on('row', (row: unknown[], result: any) => {
        columnsOf(result);
        more = more && rows.add(row);
      });
      try {
        for (;;) {
          const batch = batchOf(rows, caps.maxRows);
          const [read, result] = await new Promise<[unknown[][], any]>((resolve, reject) => {
            cursor.read(batch, (err: Error | null, got: unknown[][], res: any) => (err ? reject(err) : resolve([got, res])));
          });
          columnsOf(result);
          if (!more || read.length < batch) {
            break;
          }
        }
      } finally {
        await quietly(() => cursor.close());
      }
    },
    async cancel() {
      await quietly(async () => {
        const other = await driver.pool._factory.create();
        try {
          await other.query('SELECT pg_cancel_backend($1)', [client.processID]);
        } finally {
          await quietly(() => driver.pool._factory.destroy(other));
        }
      });
    },
    async close() {
      if (open) {
        open = false;
        await quietly(() => client.query('ROLLBACK'));
        await quietly(() => driver.pool._factory.destroy(client));
      }
    },
  };
}

/**
 * MySQL: a connection of the run's own, its sql_mode without the modes that
 * change how a string is read, `MAX_EXECUTION_TIME`, and a read-only
 * transaction; the rows streamed, and the connection dropped once enough came.
 */
async function mysqlSession(driver: any, caps: SqlCaps): Promise<SqlSession> {
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const { Types } = require('mysql2');
  const conn = await driver.pool._factory.create();
  let open = true;
  try {
    await conn.execute('SET time_zone = \'+00:00\'');
    const [{ mode }] = await conn.execute('SELECT @@SESSION.sql_mode AS mode');
    const modes = String(mode ?? '').split(',').filter((m) => m && !['NO_BACKSLASH_ESCAPES', 'ANSI_QUOTES', 'ANSI'].includes(m));
    await conn.execute('SET SESSION sql_mode = ?', [modes.join(',')]);
    try {
      await conn.execute(`SET SESSION MAX_EXECUTION_TIME = ${Math.floor(caps.timeoutMs)}`);
    } catch {
      // MariaDB's, in seconds.
      await conn.execute(`SET SESSION max_statement_time = ${Math.ceil(caps.timeoutMs / 1000)}`);
    }
    await conn.execute('START TRANSACTION READ ONLY');
  } catch (e) {
    await quietly(() => driver.pool._factory.destroy(conn));
    throw e;
  }
  const drop = () => {
    if (open) {
      open = false;
      conn.destroy();
    }
  };
  return {
    run(sql, rows) {
      return new Promise<void>((resolve, reject) => {
        const query = conn.query({ sql, rowsAsArray: true, supportBigNumbers: true, bigNumberStrings: true });
        query.on('fields', (fields: any[]) => {
          if (Array.isArray(fields)) {
            rows.setColumns(fields.map((f) => ({ name: f.name, type: Types[f.columnType ?? f.type] ?? null })));
          }
        });
        query.on('result', (row: unknown[]) => {
          if (!rows.add(row)) {
            // Enough: the server stops once it can't send.
            drop();
            resolve();
          }
        });
        query.on('error', (e: Error) => (open ? reject(e) : resolve()));
        query.on('end', () => resolve());
      });
    },
    async cancel() {
      await quietly(async () => {
        const other = await driver.pool._factory.create();
        try {
          await other.execute(`KILL QUERY ${Number(conn.threadId)}`);
        } finally {
          await quietly(() => driver.pool._factory.destroy(other));
        }
      });
    },
    async close() {
      if (open) {
        await quietly(() => conn.execute('ROLLBACK'));
        open = false;
        await quietly(() => driver.pool._factory.destroy(conn));
      }
    },
  };
}

/** Snowflake: the driver's own connection (its session's `STATEMENT_TIMEOUT_IN_SECONDS`), one statement, rows streamed to the cap. */
async function snowflakeSession(driver: any, caps: SqlCaps): Promise<SqlSession> {
  const conn = await driver.getConnection();
  let statement: any = null;
  return {
    run(sql, rows) {
      return new Promise<void>((resolve, reject) => {
        statement = conn.execute({
          sqlText: sql,
          streamResult: true,
          rowMode: 'array',
          fetchAsString: ['Number', 'Date'],
          parameters: { MULTI_STATEMENT_COUNT: 1 },
          complete: (err: Error | undefined, stmt: any) => {
            if (err) {
              reject(err);
              return;
            }
            rows.setColumns((stmt.getColumns() ?? []).map((c: any) => ({ name: c.getName(), type: String(c.getType()) })));
            const stream = stmt.streamRows({ start: 0, end: caps.maxRows });
            stream.on('data', (row: unknown[]) => {
              if (!rows.add(row)) {
                stream.destroy();
                resolve();
              }
            });
            stream.on('error', reject);
            stream.on('end', () => resolve());
          },
        });
      });
    },
    async cancel() {
      await quietly(() => new Promise<void>((resolve) => {
        if (!statement) {
          resolve();
          return;
        }
        statement.cancel(() => resolve());
      }));
    },
    async close() {
      await quietly(() => driver.release());
    },
  };
}

/**
 * BigQuery: a dry run first, which must call the statement a SELECT; then
 * the job, with `jobTimeoutMs` (and `maximumBytesBilled` when asked), its
 * results read a page at a time to the cap.
 */
async function bigquerySession(driver: any, caps: SqlCaps, refuse: Refuse): Promise<SqlSession> {
  const bq = driver.bigquery;
  const location = driver.options?.location;
  let job: any = null;
  return {
    async run(sql, rows) {
      const [dry] = await bq.createQueryJob({ query: sql, dryRun: true, useLegacySql: false, location });
      const type = dry?.metadata?.statistics?.query?.statementType;
      if (type !== 'SELECT') {
        refuse(`BigQuery's dry run reads the statement as ${String(type ?? 'unknown')}: only a SELECT runs here`, String(type ?? 'unknown').toLowerCase());
      }
      [job] = await bq.createQueryJob({
        query: sql,
        useLegacySql: false,
        location,
        jobTimeoutMs: String(caps.timeoutMs),
        ...(caps.maxBytesBilled ? { maximumBytesBilled: String(caps.maxBytesBilled) } : {}),
      });
      let pageToken: string | undefined;
      do {
        const [page, next, response] = await job.getQueryResults({
          maxResults: batchOf(rows, caps.maxRows), pageToken, autoPaginate: false, timeoutMs: caps.timeoutMs, wrapIntegers: true,
        });
        const fields: any[] = response?.schema?.fields ?? [];
        if (!rows.columns.length) {
          rows.setColumns(fields.map((f) => ({ name: f.name, type: f.type ?? null })));
        }
        if (!(page ?? []).every((row: any) => rows.add(fields.map((f) => row[f.name])))) {
          return;
        }
        pageToken = next?.pageToken;
      } while (pageToken);
    },
    async cancel() {
      await quietly(() => job?.cancel());
    },
    async close() {
      await quietly(() => driver.release?.());
    },
  };
}

/**
 * SQL Server: the run's own pool of one, `requestTimeout`, the statement in a
 * transaction that is always rolled back; its rows streamed to the cap.
 */
async function mssqlSession(driver: any): Promise<SqlSession> {
  const pool = await driver.initialConnectPromise;
  const transaction = pool.transaction();
  try {
    await transaction.begin();
  } catch (e) {
    await quietly(() => driver.release());
    throw e;
  }
  let request: any = null;
  return {
    run(sql, rows) {
      return new Promise<void>((resolve, reject) => {
        let stopped = false;
        let sets = 0;
        request = transaction.request();
        request.stream = true;
        request.arrayRowMode = true;
        // The request ends once SQL Server takes the cancel: only then may the transaction roll back.
        const stop = () => {
          stopped = true;
          request.cancel();
        };
        request.on('recordset', (columns: any) => {
          sets += 1;
          if (sets > 1) {
            // A second result: not the one statement checked.
            stop();
            return;
          }
          const list: any[] = Array.isArray(columns) ? columns : Object.values(columns ?? {});
          rows.setColumns(list.map((c) => ({ name: c.name, type: c.type?.declaration ?? c.type?.name ?? null })));
        });
        request.on('row', (row: unknown[]) => {
          if (!stopped && !rows.add(row)) {
            stop();
          }
        });
        // A request settles at `done`, after its error: the transaction can't roll back while it is in progress.
        let failed: Error | null = null;
        request.on('error', (e: Error) => {
          failed = stopped ? null : failed ?? e;
        });
        request.on('done', () => (failed ? reject(failed) : resolve()));
        request.query(sql);
      });
    },
    async cancel() {
      await quietly(() => request?.cancel());
    },
    async close() {
      // Closing the pool drops the connection, and SQL Server rolls back whatever is left.
      await quietly(() => Promise.race([transaction.rollback(), sleep(5000)]));
      await quietly(() => driver.release());
    },
  };
}

/** Oracle's rows per round trip. */
const ORACLE_FETCH = 100;

/**
 * Oracle: a connection of the run's own with `callTimeout`, in a read-only
 * transaction, the rows read from a result set to the cap (Cube's driver has
 * no stream, and caps every query at 100,000 rows in memory).
 */
async function oracleSession(driver: any, caps: SqlCaps): Promise<SqlSession> {
  const { db } = driver;
  const conn = await driver.pool._factory.create();
  try {
    conn.callTimeout = caps.timeoutMs;
    await conn.execute('SET TRANSACTION READ ONLY');
  } catch (e) {
    await quietly(() => conn.close());
    throw e;
  }
  return {
    async run(sql, rows) {
      const result = await conn.execute(sql, [], {
        resultSet: true,
        outFormat: db.OUT_FORMAT_ARRAY,
        // One round trip per read: a stop loses at most the fetch it interrupts.
        fetchArraySize: ORACLE_FETCH,
        prefetchRows: ORACLE_FETCH,
        fetchTypeHandler: (meta: any) => {
          if (meta.dbType === db.DB_TYPE_CLOB || meta.dbType === db.DB_TYPE_NCLOB) {
            return { type: db.STRING };
          }
          return meta.dbType === db.DB_TYPE_BLOB ? { type: db.BUFFER } : undefined;
        },
      });
      rows.setColumns((result.metaData ?? []).map((m: any) => ({ name: m.name, type: m.dbTypeName ?? null })));
      const set = result.resultSet;
      try {
        for (;;) {
          const batch = Math.min(ORACLE_FETCH, batchOf(rows, caps.maxRows));
          const read: unknown[][] = await set.getRows(batch);
          if (!read.every((row) => rows.add(row)) || read.length < batch) {
            break;
          }
        }
      } finally {
        await quietly(() => set.close());
      }
    },
    async cancel() {
      await quietly(() => conn.break());
    },
    async close() {
      await quietly(() => conn.rollback());
      await quietly(() => conn.close());
    },
  };
}

/**
 * Dremio: its job API. The job runs; xcube reads its results a page of 500
 * at a time, only to the cap (Cube's driver reads every page), and cancels
 * the job when the clock runs out.
 */
async function dremioSession(driver: any): Promise<SqlSession> {
  await driver.getToken();
  let jobId: string | null = null;
  let stopping = false;
  return {
    async run(sql, rows) {
      jobId = await driver.executeQuery(sql);
      let job: any = null;
      for (let i = 0; !job; i++) {
        if (stopping) {
          throw new Error('stopped');
        }
        job = await driver.getJobStatus(jobId);
        if (!job) {
          await sleep(Math.min(1000, 100 * (i + 1)));
        }
      }
      for (let offset = 0; ; offset += 500) {
        const { data } = await driver.getJobResults(jobId, 500, offset);
        const schema: any[] = data?.schema ?? [];
        if (!rows.columns.length) {
          rows.setColumns(schema.map((f) => ({ name: f.name, type: f.type?.name ?? null })));
        }
        const page: any[] = data?.rows ?? [];
        if (!page.every((row) => rows.add(schema.map((f) => row[f.name])))) {
          return;
        }
        if (page.length < 500 || offset + 500 >= Number(job.rowCount ?? 0)) {
          return;
        }
      }
    },
    async cancel() {
      stopping = true;
      await quietly(() => jobId && driver.restDremioQuery('post', `/job/${jobId}/cancel`));
    },
    async close() {
      await quietly(() => driver.release?.());
    },
  };
}

/**
 * Whether a Cube Store plan joins on its router: a join not under a
 * `ClusterSend`. Its router runs it, and nothing stops that once it starts
 * (`endsAtCubeStoreTimeout`); a join multiplies what it reads.
 */
export function joinsOnRouter(plan: string): boolean {
  const lines = plan.split('\n').filter((l) => l.trim()).map((l) => ({ depth: l.length - l.trimStart().length, text: l.trim() }));
  return lines.some((line, i) => {
    if (!/^(Cross)?Join\b/.test(line.text)) {
      return false;
    }
    // Its ancestors: each line before it less indented than the last one found.
    for (let k = i - 1, { depth } = line; k >= 0; k--) {
      if (lines[k].depth < depth) {
        if (lines[k].text.startsWith('ClusterSend')) {
          return false;
        }
        ({ depth } = lines[k]);
      }
    }
    return true;
  });
}

/**
 * Whether Cube Store's own query timeout ends a query, from its logical plan
 * (`EXPLAIN`). A query over its tables runs on a select worker (under
 * `ClusterSend`), whose process Cube Store kills at its timeout. The router
 * runs the rest itself (VALUES, information_schema, system tables, and any
 * join above a `ClusterSend`), and its timeout can't stop that: work that
 * never yields runs to its end, the timeout with it.
 */
export function endsAtCubeStoreTimeout(plan: string): boolean {
  return /^\s*ClusterSend/m.test(plan) && !joinsOnRouter(plan);
}

/** The refusal of a Cube Store query that joins on its router. */
export const ROUTER_JOIN_REFUSAL = 'Cube Store\'s router would run this query\'s join itself, and nothing stops that work once it starts, '
  + 'not even Cube Store\'s own timeout: join Cube Store\'s tables, whose joins run on its select workers, '
  + 'or read one catalog or system table without a join';

/**
 * Cube Store: a connection of the run's own. It answers every row at once,
 * so a SELECT is asked for at most the cap's one row more (`withRowCap`);
 * its values come as strings, and it reports no types.
 *
 * It can't stop a query: each runs in a task of its own, on however its
 * connection ends, until it finishes or Cube Store's own query timeout
 * (`CUBESTORE_QUERY_TIMEOUT`) stops it. Its answer, on the connection kept
 * open, says when that is.
 */
async function cubeStoreSession(driver: any, refuse: Refuse): Promise<SqlSession> {
  let pending: Promise<any> | null = null;
  let killable = false;
  return {
    async run(sql, rows) {
      if (!/^\s*explain\b/i.test(sql)) {
        // Its plan says where it runs: a join on the router is refused; only work on select
        // workers ends at Cube Store's timeout. A plan that can't be made fails as the query would.
        const answer: any = await driver.query(`EXPLAIN ${sql}`, []);
        const plan = String(answer?.[0]?.['logical plan'] ?? '');
        if (joinsOnRouter(plan)) {
          refuse(ROUTER_JOIN_REFUSAL, 'select', 'cubestore_router_join');
        }
        killable = endsAtCubeStoreTimeout(plan);
      } else {
        killable = true;
      }
      pending = Promise.resolve(driver.query(sql, []));
      const answer: any = await pending;
      const length = Number(answer?.length ?? 0);
      const names = length ? Object.keys(answer[0]) : [];
      rows.setColumns(names.map((name) => ({ name, type: null })));
      for (let i = 0; i < length; i++) {
        if (!rows.add(names.map((name) => answer[i][name]))) {
          return;
        }
      }
    },
    async cancel() {
      // Nothing stops it: see `ended`.
    },
    ended() {
      return pending ? pending.then(() => undefined, () => undefined) : Promise.resolve();
    },
    endsAtTimeout() {
      return killable;
    },
    async close() {
      await quietly(() => driver.release());
    },
  };
}

/** Opens a run's session on a driver built for it (the connect step). */
export function openSession(
  dialect: SessionDialect,
  driver: any,
  caps: SqlCaps,
  refuse: Refuse,
): Promise<SqlSession> {
  switch (dialect) {
    case 'postgres':
    case 'redshift':
      return pgSession(driver, dialect, caps);
    case 'mysql':
      return mysqlSession(driver, caps);
    case 'snowflake':
      return snowflakeSession(driver, caps);
    case 'bigquery':
      return bigquerySession(driver, caps, refuse);
    case 'mssql':
      return mssqlSession(driver);
    case 'oracle':
      return oracleSession(driver, caps);
    case 'dremio':
      return dremioSession(driver);
    default:
      return cubeStoreSession(driver, refuse);
  }
}

/** Whether a database's error is its own statement timeout firing. */
export function isTimeout(dialect: SessionDialect, e: any): boolean {
  const code = String(e?.code ?? '');
  const message = String(e?.message ?? '');
  switch (dialect) {
    case 'postgres':
    case 'redshift':
      return code === '57014' && /statement timeout/i.test(message);
    case 'mysql':
      return e?.errno === 3024 || code === 'ER_QUERY_TIMEOUT' || /max_statement_time|maximum statement execution time/i.test(message);
    case 'snowflake':
      return code === '000630' || /statement or warehouse timeout/i.test(message);
    case 'mssql':
      return code === 'ETIMEOUT';
    case 'oracle':
      return /NJS-123|DPI-1067|ORA-03156/.test(message);
    case 'bigquery':
      return /timed? ?out|jobTimeoutMs/i.test(message);
    default:
      return false;
  }
}
