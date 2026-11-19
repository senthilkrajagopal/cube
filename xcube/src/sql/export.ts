/**
 * Exports (`POST …/connections/{name}/export`): a whole table of a model's
 * data source, streamed, for wechart's engine to load, through the
 * connection's own credentials, which stay in xcube.
 *
 * An export is a SQL run (`runs.ts`) of a statement xcube writes itself,
 * `SELECT <columns> FROM <schema>.<table>`, with the run's read-only layers,
 * time cap and cancel, and no row or byte cap: its rows are written as they
 * come (`ExportRows`), as NDJSON:
 *
 *   {"columns":[{"name":"id","type":"int4"},…]}
 *   [1,"east",…]
 *   …
 *   {"end":{"rows":123,"durationMs":456}}   or   {"error":{"code":"…","message":"…"}}
 *
 * Its cells are the SQL runner's (`cellOf`). The last line says whether every
 * row came: an answer without an `end` line is incomplete.
 *
 * Where a session reads a batch per round trip (PostgreSQL and Redshift's
 * cursor, BigQuery's pages, Oracle's fetches), an export's batches are sized
 * by bytes (`ExportRows.fetchRows`): about `XCUBE_EXPORT_FETCH_BYTES` of
 * NDJSON, at most `XCUBE_EXPORT_FETCH_ROWS` rows. Between batches the run
 * waits while the client is behind (`ready`), rather than buffering.
 */
import { RowCollector, cellOf, type SqlColumn, type SessionDialect } from './runner';

/** How long an export may run unless it says: 30 minutes. */
export const EXPORT_TIMEOUT_MS = 30 * 60 * 1000;

/** The longest an export may run: 6 hours. */
export const EXPORT_MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** What an export's answer may hold unsent before it is stopped as `client_too_slow`. */
export const EXPORT_MAX_BUFFERED = 256 * 1024 * 1024;

/** The most rows an export reads in one round trip, unless `XCUBE_EXPORT_FETCH_ROWS` says. */
export const EXPORT_FETCH_ROWS = 50000;

/** About what one round trip of an export holds, as NDJSON: 16 MiB, unless `XCUBE_EXPORT_FETCH_BYTES` says. */
export const EXPORT_FETCH_BYTES = 16 * 1024 * 1024;

/** An export's first read, before the size of its rows is known. */
export const EXPORT_FIRST_FETCH = 1000;

/** How long an export waits for a client that has stopped reading before it ends as `client_too_slow`. */
export const EXPORT_STALL_MS = 5 * 60 * 1000;

/** How an export reads its rows from the database. */
export interface ExportFetch {
  rows: number;
  bytes: number;
}

function whole(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, not ${JSON.stringify(raw)}`);
  }
  return value;
}

/** The settings, checked: a value that isn't one fails xcube as it starts (`settingsFromEnv`), not an export. */
export function exportFetchFromEnv(env: NodeJS.ProcessEnv = process.env): ExportFetch {
  return {
    rows: whole(env, 'XCUBE_EXPORT_FETCH_ROWS', EXPORT_FETCH_ROWS, 1, 1000000),
    // Well under what may wait unsent (`EXPORT_MAX_BUFFERED`): a batch is written whole.
    bytes: whole(env, 'XCUBE_EXPORT_FETCH_BYTES', EXPORT_FETCH_BYTES, 64 * 1024, 64 * 1024 * 1024),
  };
}

/** The cap an export's run is given: none that a table reaches. */
export const EXPORT_ROWS = Number.MAX_SAFE_INTEGER - 1;

/** A name an export can't quote: a quote of any kind, a bracket, a backslash. */
const UNQUOTABLE = /["'`[\]\\]/;

/** Whether a name holds a control character. */
const hasControl = (name: string) => [...name].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** An export request Cube's SQL can't be written for: 400. */
export class ExportError extends Error {
  public constructor(message: string, public readonly code = 'invalid_export') {
    super(message);
    this.name = 'ExportError';
  }
}

/** A name quoted for the database. */
export function quoteName(dialect: SessionDialect, name: string): string {
  if (typeof name !== 'string' || name === '' || name.length > 256 || UNQUOTABLE.test(name) || hasControl(name)) {
    throw new ExportError(`${JSON.stringify(String(name).slice(0, 64))} can't be a name to export: 1 to 256 characters, no quote, bracket, backslash or control character`);
  }
  switch (dialect) {
    case 'mysql':
    case 'clickhouse':
    case 'bigquery':
    case 'hive':
    case 'impala':
      return `\`${name}\``;
    case 'mssql':
      return `[${name}]`;
    case 'cubestore':
      throw new ExportError('Cube Store holds rollups, not tables to export', 'export_unsupported');
    default:
      return `"${name}"`;
  }
}

/**
 * The statement an export runs: its columns (all, unless it names them) of
 * one table. On TDV a table may be named in a published catalog as well,
 * `"catalog"."schema"."table"`; no other database takes a catalog here.
 */
export function exportStatement(dialect: SessionDialect, request: { catalog?: string; schema?: string; table: string; columns?: string[] }): string {
  if (request.catalog !== undefined && dialect !== 'tdv') {
    throw new ExportError('A catalog names a table on TDV only: name the table by its schema here');
  }
  const columns = request.columns?.length ? request.columns.map((c) => quoteName(dialect, c)).join(', ') : '*';
  const table = [request.catalog, request.schema, request.table].filter((n): n is string => n !== undefined && n !== null)
    .map((n) => quoteName(dialect, n)).join('.');
  return `SELECT ${columns} FROM ${table}`;
}

/**
 * An export's rows as a SQL run reads them: each written out as it comes,
 * none kept. A write the client can't keep up with stops the run (`slow`).
 */
export class ExportRows extends RowCollector {
  public count = 0;

  /** The client took too long to read what was sent: the run stopped reading. */
  public slow = false;

  protected wroteColumns = false;

  /** What the rows written so far came to. */
  protected written = 0;

  /**
   * `write` sends a line, `false` once more waits unsent than the client may
   * leave; `waitFor` resolves once the client has taken what was sent, or
   * says `false` when it has stopped reading.
   */
  public constructor(
    protected readonly write: (line: string) => boolean,
    protected readonly fetch: ExportFetch = exportFetchFromEnv(),
    protected readonly waitFor: () => Promise<boolean> = async () => true,
  ) {
    super(EXPORT_ROWS, Number.POSITIVE_INFINITY);
  }

  /** A batch of about `fetch.bytes` of the rows seen so far, at most `fetch.rows`. */
  public override fetchRows(_interactive: number): number {
    if (!this.count) {
      return Math.min(EXPORT_FIRST_FETCH, this.fetch.rows);
    }
    const perRow = Math.max(1, this.written / this.count);
    return Math.max(1, Math.min(this.fetch.rows, Math.floor(this.fetch.bytes / perRow)));
  }

  public override async ready(): Promise<boolean> {
    if (!this.slow && !(await this.waitFor())) {
      this.slow = true;
    }
    return !this.slow;
  }

  public override setColumns(columns: SqlColumn[]) {
    this.columns = columns;
    if (!this.wroteColumns) {
      this.wroteColumns = true;
      this.slow = !this.write(JSON.stringify({ columns }));
    }
  }

  public override add(row: unknown[]): boolean {
    if (this.slow) {
      return false;
    }
    if (!this.wroteColumns) {
      this.setColumns(this.columns);
    }
    this.count += 1;
    const line = JSON.stringify(row.map(cellOf));
    this.written += line.length + 1;
    if (!this.write(line)) {
      this.slow = true;
      return false;
    }
    return true;
  }

  /** The columns line, where no row and no columns came. */
  public finishColumns() {
    if (!this.wroteColumns) {
      this.setColumns(this.columns);
    }
  }
}
