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
 */
import { RowCollector, cellOf, type SqlColumn, type SessionDialect } from './runner';

/** How long an export may run unless it says: 30 minutes. */
export const EXPORT_TIMEOUT_MS = 30 * 60 * 1000;

/** The longest an export may run: 6 hours. */
export const EXPORT_MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** What an export's answer may hold unsent before it is stopped as `client_too_slow`. */
export const EXPORT_MAX_BUFFERED = 256 * 1024 * 1024;

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
      return `\`${name}\``;
    case 'mssql':
      return `[${name}]`;
    case 'cubestore':
      throw new ExportError('Cube Store holds rollups, not tables to export', 'export_unsupported');
    default:
      return `"${name}"`;
  }
}

/** The statement an export runs: its columns (all, unless it names them) of one table. */
export function exportStatement(dialect: SessionDialect, request: { schema?: string; table: string; columns?: string[] }): string {
  const columns = request.columns?.length ? request.columns.map((c) => quoteName(dialect, c)).join(', ') : '*';
  const table = [request.schema, request.table].filter((n): n is string => n !== undefined && n !== null).map((n) => quoteName(dialect, n)).join('.');
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

  public constructor(protected readonly write: (line: string) => boolean) {
    super(EXPORT_ROWS, Number.POSITIVE_INFINITY);
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
    if (!this.write(JSON.stringify(row.map(cellOf)))) {
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
