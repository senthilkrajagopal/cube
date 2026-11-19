/**
 * xcube's JDBC data sources (Db2 so far): a connection made by the vendor's
 * driver class from xcube's settings alone, over node-java and xcube's helper
 * (`jdbc/src`), never Cube's JDBC driver:
 * - the helper makes the connection from the driver class itself, never
 *   through DriverManager, with the URL and properties xcube built: nothing
 *   is read from Cube's environment (`CUBEJS_JDBC_*`, `CUBEJS_DB_*`), and no
 *   jar is fetched;
 * - rows are read a batch at a time as JSON the helper writes, each cell in
 *   the SQL runner's form (a decimal as its digits, a date and time as the
 *   database's wall time), not a call across the bridge per cell;
 * - a cancel runs on a thread of the JVM's own, never in Node's thread pool
 *   behind statements running;
 * - every call that can wait on the database (connect, execute, fetch)
 *   runs in Node's thread pool, as node-java runs them, but never in all of
 *   it: at most `JDBC_THREADS` at once, the rest queued here, so Node keeps
 *   threads of its own (files, DNS, zlib, crypto) whatever the databases do;
 *   a cancel or a close runs on a thread of the JVM's, never queued;
 * - each data source has a pool of connections; a connection that failed
 *   is dropped.
 */
import { BaseDriver } from '@cubejs-backend/base-driver';

import { assertJdbcAvailable, JDBC_TYPES, jvm, type JdbcType } from './jvm';

/** How long a connection may take to open (the driver's own login timeout is set from it too). */
export const JDBC_CONNECT_MS = 30000;

/** Cube's queries' time limit on the database, in seconds, where the config sets none. */
export const JDBC_QUERY_TIMEOUT_S = 600;

/** The threads of Node's pool JDBC calls may hold at once: all but four (`UV_THREADPOOL_SIZE`, 4 unset). */
export const JDBC_THREADS = Math.max(1, (Number(process.env.UV_THREADPOOL_SIZE) || 4) - 4);

let inPool = 0;
const queued: (() => void)[] = [];

/** A call that may wait on the database, in its turn: at most `JDBC_THREADS` in Node's pool at once. */
export async function inTurn<T>(call: () => Promise<T>): Promise<T> {
  if (inPool >= JDBC_THREADS) {
    await new Promise<void>((resolve) => {
      queued.push(resolve);
    });
  } else {
    inPool += 1;
  }
  try {
    return await call();
  } finally {
    const next = queued.shift();
    if (next) {
      next();
    } else {
      inPool -= 1;
    }
  }
}

/** The most JSON one fetch returns (about): a batch past it ends at the row that passes it. */
const FETCH_CHARS = 8 * 1024 * 1024;

/** How a JDBC call failed: `connect`, `query`, a `timeout` of the database's own, or the pool's `closed` or `deadline`. */
export class JdbcError extends Error {
  public constructor(
    message: string,
    public readonly kind: 'connect' | 'query' | 'timeout' | 'closed' | 'deadline',
    /** The SQLSTATE, where the driver gave one. */
    public readonly sqlState: string | null = null,
    /** The vendor's code (Db2's SQLCODE). */
    public readonly vendorCode: number | null = null,
  ) {
    super(message);
    this.name = 'JdbcError';
  }

  /** The SQLSTATE, as the SQL runner reads a driver's `code`. */
  public get code(): string | undefined {
    return this.sqlState ?? undefined;
  }
}

interface JavaFailure {
  class: string;
  sqlState?: string | null;
  code?: number;
  timeout?: boolean;
  message: string | null;
}

/** A Java exception, as node-java gives it, as a `JdbcError`: the first SQLException's words, else the first message. */
export function jdbcError(java: any, e: any, kind: 'connect' | 'query'): JdbcError {
  if (e instanceof JdbcError) {
    return e;
  }
  let chain: JavaFailure[] = [];
  try {
    if (e?.cause) {
      chain = JSON.parse(java.callStaticMethodSync('xcube.jdbc.Jdbc', 'describe', e.cause));
    }
  } catch {
    chain = [];
  }
  const sql = chain.find((c) => c.sqlState !== undefined);
  const first = sql ?? chain[0];
  const message = first?.message ?? String(e?.message ?? e).split('\n')[0];
  const timeout = chain.some((c) => c.timeout);
  return new JdbcError(message, timeout ? 'timeout' : kind, sql?.sqlState ?? null, sql?.code ?? null);
}

/** What a JDBC connection is opened with: built by its type's spec, never from Cube's environment. */
export interface JdbcTarget {
  type: JdbcType;
  url: string;
  /** The driver's properties, the user and password among them: never in the URL. */
  properties: Record<string, string>;
  /** Files the properties name (a CA certificate), removed when the driver is released. */
  files?: string[];
  connectTimeoutMs?: number;
  queryTimeoutS?: number;
  maxPoolSize?: number;
}

/** A bound value, in the order of the statement's `?`: a boolean bound as one, the rest as text. */
export interface JdbcBind {
  type: string;
  value: string | boolean;
}

const raced = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new JdbcError(message, 'deadline')), ms);
  promise.then((v) => {
    clearTimeout(timer);
    resolve(v);
  }, (e) => {
    clearTimeout(timer);
    reject(e);
  });
});

/** A statement running on a connection: its columns, then its rows a batch at a time. */
export class JdbcStatement {
  public columns: { name: string; type: string | null }[] = [];

  public done = false;

  public constructor(protected readonly java: any, protected readonly run: any, protected readonly owner: JdbcConnection) {}

  /** The next rows: at most `maxRows`, fewer once done; an empty batch only at the end. */
  public async fetch(maxRows: number): Promise<unknown[][]> {
    if (this.done) {
      return [];
    }
    try {
      const rows: unknown[][] = JSON.parse(await inTurn(() => this.run.fetchP(Math.max(1, maxRows), FETCH_CHARS)));
      this.done = this.run.doneSync();
      return rows;
    } catch (e) {
      throw this.owner.failed(e, 'query');
    }
  }

  /** Cancels it on the database, from a thread of the JVM's: returns at once, never throws. */
  public cancel() {
    try {
      this.run.cancelSync();
    } catch {
      // Best effort: the connection is closed after.
    }
  }

  /** Closes its rows and statement, from a thread of the JVM's: returns at once, never throws. */
  public async close() {
    try {
      this.run.closeLaterSync();
    } catch {
      // Closing anyway.
    }
  }
}

/** One JDBC connection: the vendor driver's, opened by the helper. */
export class JdbcConnection {
  /** Why it can't be used again, once a call on it failed so. */
  public broken: JdbcError | null = null;

  /** The statement running, if any: what a cancel stops. */
  public running: JdbcStatement | null = null;

  protected closed = false;

  protected constructor(protected readonly java: any, protected readonly connection: any) {}

  public static async open(target: JdbcTarget): Promise<JdbcConnection> {
    assertJdbcAvailable(target.type);
    const java = await jvm();
    const keys = Object.keys(target.properties);
    const ms = target.connectTimeoutMs ?? JDBC_CONNECT_MS;
    const opening: Promise<any> = inTurn(() => java.callStaticMethodP(
      'xcube.jdbc.Jdbc',
      'connect',
      JDBC_TYPES[target.type].driverClass,
      target.url,
      java.newArray('java.lang.String', keys),
      java.newArray('java.lang.String', keys.map((k) => target.properties[k])),
      true,
    ));
    try {
      return new JdbcConnection(java, await raced(opening, ms + 5000, `The data source didn't answer within ${Math.round(ms / 1000)} s`));
    } catch (e) {
      // One that opens after its deadline is closed as it comes.
      opening.then((c: any) => java.callStaticMethodSync('xcube.jdbc.Jdbc', 'closeLater', c), () => undefined);
      throw jdbcError(java, e, 'connect');
    }
  }

  /** A failure on this connection: one the driver says is of the connection (SQLSTATE 08…) breaks it. */
  public failed(e: unknown, kind: 'connect' | 'query'): JdbcError {
    const error = jdbcError(this.java, e, kind);
    if (/^08/.test(error.sqlState ?? '')) {
      this.broken = error;
    }
    return error;
  }

  /** Executes one statement, its `?` bound in order, with the database's own time limit (seconds; 0 for none). */
  public async execute(sql: string, binds: JdbcBind[], timeoutS: number, fetchRows = 500): Promise<JdbcStatement> {
    if (this.closed || this.broken) {
      throw this.broken ?? new JdbcError('The connection was closed', 'closed');
    }
    const run = this.java.newInstanceSync('xcube.jdbc.Run', this.connection);
    const statement = new JdbcStatement(this.java, run, this);
    this.running = statement;
    try {
      statement.columns = JSON.parse(await inTurn(() => run.executeP(
        sql,
        this.java.newArray('java.lang.String', binds.map((b) => b.type)),
        this.java.newArray('java.lang.String', binds.map((b) => String(b.value))),
        Math.max(0, Math.ceil(timeoutS)),
        Math.max(1, fetchRows),
      )));
      return statement;
    } catch (e) {
      await statement.close();
      throw this.failed(e, 'query');
    }
  }

  /** A statement's every row, as objects by column: Cube's queries'. */
  public async all(sql: string, binds: JdbcBind[], timeoutS: number): Promise<{ columns: string[]; rows: unknown[][] }> {
    const statement = await this.execute(sql, binds, timeoutS, 10000);
    try {
      const rows: unknown[][] = [];
      while (!statement.done) {
        rows.push(...await statement.fetch(10000));
      }
      return { columns: statement.columns.map((c) => c.name), rows };
    } finally {
      this.running = null;
      await statement.close();
    }
  }

  /** Closes it; never throws. */
  public async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      // From a thread of the JVM's: a close never waits for a turn behind statements running.
      this.java.callStaticMethodSync('xcube.jdbc.Jdbc', 'closeLater', this.connection);
    } catch {
      // Closing anyway.
    }
  }
}

/** How long an idle connection is kept. */
const IDLE_MS = 30000;

/** How long a statement waits for a connection while all of them are in use. */
const ACQUIRE_MS = 120000;

/**
 * A data source's connections: at most `max`, an idle one kept for
 * `IDLE_MS`; one that fails to open fails its acquire at once, with the
 * driver's words (as Hive's: `HiveConnections`).
 */
export class JdbcConnections {
  protected readonly idle: { connection: JdbcConnection; timer: NodeJS.Timeout }[] = [];

  protected readonly waiting: { resolve: (c: JdbcConnection) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

  protected size = 0;

  protected closed = false;

  public constructor(protected readonly open: () => Promise<JdbcConnection>, protected readonly max: number) {}

  public async acquire(): Promise<JdbcConnection> {
    if (this.closed) {
      throw new JdbcError('The data source\'s driver was released', 'closed');
    }
    for (let next = this.idle.pop(); next; next = this.idle.pop()) {
      clearTimeout(next.timer);
      if (!next.connection.broken) {
        return next.connection;
      }
      this.size -= 1;
      await next.connection.close();
    }
    if (this.size < this.max) {
      return this.opened();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiting.splice(this.waiting.indexOf(waiter), 1);
          reject(new JdbcError(`No connection to the data source was free within ${ACQUIRE_MS} ms`, 'deadline'));
        }, ACQUIRE_MS),
      };
      this.waiting.push(waiter);
    });
  }

  protected async opened(): Promise<JdbcConnection> {
    this.size += 1;
    try {
      return await this.open();
    } catch (e) {
      this.size -= 1;
      throw e;
    }
  }

  public release(connection: JdbcConnection) {
    if (connection.broken || this.closed) {
      this.size -= 1;
      connection.close().catch(() => undefined);
      const waiter = this.waiting.shift();
      if (waiter && !this.closed) {
        clearTimeout(waiter.timer);
        this.opened().then(waiter.resolve, waiter.reject);
      }
      return;
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(connection);
      return;
    }
    const entry = {
      connection,
      timer: setTimeout(() => {
        this.idle.splice(this.idle.indexOf(entry), 1);
        this.size -= 1;
        connection.close().catch(() => undefined);
      }, IDLE_MS),
    };
    entry.timer.unref?.();
    this.idle.push(entry);
  }

  public async close() {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new JdbcError('The data source\'s driver was released', 'closed'));
    }
    const idle = this.idle.splice(0);
    this.size -= idle.length;
    await Promise.all(idle.map(({ connection, timer }) => {
      clearTimeout(timer);
      return connection.close();
    }));
  }
}

/** What differs per JDBC type in Cube's driver: its SQL for a test, its catalog, how a value is written in, its types. */
export interface JdbcDialect {
  /** A statement that reads one row and nothing else. */
  testSql: string;
  /** Cube's SQL with each `?` replaced by its value as a literal of the database's. */
  inline(sql: string, values: unknown[]): string;
  /** The schemas a user's tables are in: one column, the schema's name. */
  schemasSql(): string;
  /** A schema's tables and views: the table's name, its kind. */
  tablesSql(schema: string): string;
  /** A table's columns, in order: the column's name, its type. */
  columnsSql(schema: string, table: string): string;
  /** Every user table's columns, in order: schema, table, column, type. */
  catalogSql(): string;
  /** A database type's generic name (Cube's). */
  genericType(type: string): string | undefined;
}

/** Cube's driver for a JDBC data source (Db2). */
export class JdbcDriver extends BaseDriver {
  protected readonly pool: JdbcConnections;

  public constructor(public readonly target: JdbcTarget, protected readonly dialect: JdbcDialect, protected readonly cleanup: () => void = () => undefined) {
    super({ testConnectionTimeout: target.connectTimeoutMs ?? JDBC_CONNECT_MS });
    this.pool = new JdbcConnections(() => JdbcConnection.open(this.target), Number(target.maxPoolSize) > 0 ? Number(target.maxPoolSize) : 8);
  }

  /** A connection of the caller's own, outside the pool: the SQL runner's. */
  public openConnection(): Promise<JdbcConnection> {
    return JdbcConnection.open(this.target);
  }

  protected async withConnection<R>(fn: (connection: JdbcConnection) => Promise<R>): Promise<R> {
    const connection = await this.pool.acquire();
    try {
      return await fn(connection);
    } finally {
      this.pool.release(connection);
    }
  }

  protected rowsOf(sql: string): Promise<Record<string, unknown>[]> {
    return this.withConnection(async (c) => {
      const { columns, rows } = await c.all(sql, [], this.target.queryTimeoutS ?? JDBC_QUERY_TIMEOUT_S);
      return rows.map((row) => Object.fromEntries(columns.map((name, i) => [name, row[i]])));
    });
  }

  public override query<R = unknown>(query: string, values?: unknown[]): Promise<R[]> {
    let connection: JdbcConnection | null = null;
    const sql = this.dialect.inline(query, values ?? []);
    const promise = this.withConnection(async (c) => {
      connection = c;
      const { columns, rows } = await c.all(sql, [], this.target.queryTimeoutS ?? JDBC_QUERY_TIMEOUT_S);
      return rows.map((row) => Object.fromEntries(columns.map((name, i) => [name, row[i]])) as R);
    }) as Promise<R[]> & { cancel?: () => Promise<void> };
    promise.cancel = async () => {
      (connection as JdbcConnection | null)?.running?.cancel();
    };
    return promise;
  }

  public override async testConnection(): Promise<void> {
    await this.withConnection((c) => c.all(this.dialect.testSql, [], 30));
  }

  public override readOnly() {
    return true;
  }

  public override capabilities() {
    return { incrementalSchemaLoading: true };
  }

  public override async getSchemas() {
    const rows = await this.rowsOf(this.dialect.schemasSql());
    return rows.map((r) => ({ schema_name: String(Object.values(r)[0] ?? '').trim() })).filter((r) => r.schema_name);
  }

  public override async getTablesForSpecificSchemas(schemas: { schema_name: string }[]) {
    const out: { schema_name: string; table_name: string; table_type?: string }[] = [];
    for (const { schema_name: schema } of schemas) {
      const rows = await this.rowsOf(this.dialect.tablesSql(schema));
      out.push(...rows.map((r) => {
        const [name, kind] = Object.values(r);
        return { schema_name: schema, table_name: String(name).trim(), table_type: kind == null ? undefined : String(kind).trim() };
      }));
    }
    return out;
  }

  public override async getColumnsForSpecificTables(tables: { schema_name: string; table_name: string }[]) {
    const out: any[] = [];
    for (const { schema_name: schema, table_name: table } of tables) {
      const rows = await this.rowsOf(this.dialect.columnsSql(schema, table));
      out.push(...rows.map((r) => {
        const [name, type] = Object.values(r);
        return {
          schema_name: schema, table_name: table, column_name: String(name).trim(), data_type: String(type ?? '').trim().toLowerCase(), attributes: [],
        };
      }));
    }
    return out;
  }

  /** Every user table's columns, in one statement: schema, table, column and type, in order. */
  public override async tablesSchema() {
    const rows = await this.rowsOf(this.dialect.catalogSql());
    const structure: Record<string, Record<string, { name: string; type: string; attributes: string[] }[]>> = {};
    for (const r of rows) {
      const [schema, table, column, type] = Object.values(r).map((v) => String(v ?? '').trim());
      ((structure[schema] ??= {})[table] ??= []).push({ name: column, type: type.toLowerCase(), attributes: [] });
    }
    return structure;
  }

  public override toGenericType(columnType: string): string {
    return this.dialect.genericType(columnType.toLowerCase().replace(/\(.*$/, '').trim()) ?? super.toGenericType(columnType);
  }

  public override async release() {
    await this.pool.close();
    this.cleanup();
  }
}
