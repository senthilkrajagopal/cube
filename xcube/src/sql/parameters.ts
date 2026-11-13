/**
 * Bound parameters on the SQL runner (wechart's F42). A statement names each
 * parameter `{{name}}` in its code; xcube finds them with the dialect's own
 * lexer (`placeholdersOf`), so that what its check reads is what runs, and
 * writes in their place placeholders of its own (`$1`, `?`, `@p1`, `:p1`, `{p1:String}`),
 * typed, each between spaces. The values go to the driver as binds, never into
 * the statement's text, and are never logged.
 */
import {
  ParameterError, placeholdersOf, redactSql, type SqlDialect,
} from './classify';

export type ParameterType = 'text' | 'number' | 'date' | 'boolean';

/**
 * A parameter as the client gives it: a number as a decimal string, a date as
 * `YYYY-MM-DD`. Where the run takes lists (an export's statement), a value may
 * be a list of its type, bound as one value per item where `{{name}}` is all a
 * parenthesis holds: `IN ({{name}})`.
 */
export interface SqlParameter {
  type: ParameterType;
  value: string | boolean | (string | boolean)[];
}

/**
 * The most values a statement may bind, all its parameters' together, on each
 * dialect that binds (`total`), and the most one list may hold (`list`): the
 * database's own limit where it has one, else xcube's.
 * - PostgreSQL and Redshift: a Bind message counts its values in 16 bits;
 *   32,767 is the signed ceiling every client keeps to.
 * - MySQL: 65,535 placeholders in a prepared statement.
 * - Snowflake: 16,384 expressions in a list.
 * - BigQuery: 10,000 query parameters in a query.
 * - SQL Server: 2,100 parameters in a request, two of them sp_executesql's own.
 * - Oracle: 1,000 expressions in a list (ORA-01795); 65,535 binds.
 * - ClickHouse: its query parameters go in the request's URL, which the server
 *   caps (`http_max_uri_size`, 1 MiB by default): 10,000, short values.
 * - DuckDB and wechart's engine: no limit of theirs; xcube's own, 65,535.
 */
export const MAX_BOUND: Partial<Record<SqlDialect, { total: number; list: number }>> = {
  postgres: { total: 32767, list: 32767 },
  redshift: { total: 32767, list: 32767 },
  mysql: { total: 65535, list: 65535 },
  snowflake: { total: 16384, list: 16384 },
  bigquery: { total: 10000, list: 10000 },
  mssql: { total: 2098, list: 2098 },
  oracle: { total: 65535, list: 1000 },
  clickhouse: { total: 10000, list: 10000 },
  duckdb: { total: 65535, list: 65535 },
};

/** One value bound, by the placeholder xcube wrote: a position (`?`, `$n`), or a name (`p1`). */
export interface SqlBind {
  /** The placeholder's name without its sigil (`p1`), or its 1-based position. */
  id: string;
  type: ParameterType;
  /** Text, a number's decimal string, a date's `YYYY-MM-DD`, or a boolean. */
  value: string | boolean;
}

/**
 * Where binding isn't proven: their drivers take no binds (Dremio's job API,
 * Cube Store's, Trino's), or a value isn't yet shown to be taken as one
 * literal (Athena's execution parameters).
 */
export const UNBOUND_DIALECTS = new Set<SqlDialect>(['dremio', 'trino', 'athena', 'cubestore']);

/** A dialect's name as a refusal says it. */
export const DIALECT_NAMES: Record<SqlDialect, string> = {
  postgres: 'PostgreSQL',
  redshift: 'Redshift',
  mysql: 'MySQL',
  snowflake: 'Snowflake',
  bigquery: 'BigQuery',
  mssql: 'SQL Server',
  oracle: 'Oracle',
  dremio: 'Dremio',
  duckdb: 'DuckDB',
  clickhouse: 'ClickHouse',
  trino: 'Trino',
  athena: 'Athena',
  cubestore: 'Cube Store',
};

/** A number's decimal string: at most 38 digits, at most 30 after the point (every dialect's exact decimal holds it). */
const DECIMAL = /^-?(\d+)(?:\.(\d+))?$/;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ClickHouse's Date32 range: a day outside it is taken as its nearest end, not refused. */
const CLICKHOUSE_DAYS = { first: '1900-01-01', last: '2299-12-31' };

/** The value, checked against its type: the reason it isn't one, or nothing. */
function invalid(name: string, parameter: { type: ParameterType; value: string | boolean }): string | null {
  const { type, value } = parameter;
  switch (type) {
    case 'text':
      return typeof value === 'string' ? null : `"${name}" is Text: its value is a string`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `"${name}" is Boolean: its value is true or false`;
    case 'number': {
      const m = typeof value === 'string' ? DECIMAL.exec(value) : null;
      if (!m) {
        return `"${name}" is a Number: its value is a decimal string, such as "-12.5"`;
      }
      const scale = m[2]?.length ?? 0;
      return m[1].length + scale > 38 || scale > 30 ? `"${name}" is a Number of at most 38 digits, at most 30 of them after the point` : null;
    }
    case 'date': {
      const m = typeof value === 'string' ? DATE.exec(value) : null;
      const at = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
      const real = at && Number(m![1]) >= 1 && at.getUTCFullYear() === Number(m![1]) && at.getUTCMonth() === Number(m![2]) - 1
        && at.getUTCDate() === Number(m![3]);
      return real ? null : `"${name}" is a Date: its value is a day, written YYYY-MM-DD`;
    }
    default:
      return `"${name}" has no type xcube binds: text, number, date or boolean`;
  }
}

/** A number's digits after the point, for the decimal type its placeholder is cast to. */
const scaleOf = (value: string | boolean) => (typeof value === 'string' ? (DECIMAL.exec(value)?.[2]?.length ?? 0) : 0);

/**
 * Oracle's TO_NUMBER format for a decimal string, with `.` as its decimal
 * mark whatever the session's NLS settings: a 9 per digit, `D` for the point.
 */
function oracleNumberFormat(value: string): string {
  const m = DECIMAL.exec(value)!;
  return `${'9'.repeat(Math.max(1, m[1].length))}${m[2] ? `D${'9'.repeat(m[2].length)}` : ''}`;
}

/** A dialect's placeholder for the value of `{{name}}`, typed where the dialect takes the type from the SQL. */
function placeholder(dialect: SqlDialect, slot: string, parameter: { type: ParameterType; value: string | boolean }): string {
  const { type, value } = parameter;
  const scale = scaleOf(value);
  if (dialect === 'postgres' || dialect === 'redshift') {
    return `${slot}::${{ text: 'text', number: 'numeric', date: 'date', boolean: 'boolean' }[type]}`;
  }
  if (dialect === 'clickhouse') {
    // A query parameter is typed where it is written.
    return `{${slot}:${{ text: 'String', number: `Decimal(38, ${scale})`, date: 'Date32', boolean: 'Bool' }[type]}}`;
  }
  if (type === 'text' || dialect === 'bigquery') {
    // BigQuery's are typed by its query parameters' `types`.
    return slot;
  }
  switch (dialect) {
    case 'mysql':
      if (type === 'number') {
        return `CAST(${slot} AS DECIMAL(65, ${scale}))`;
      }
      return type === 'date' ? `CAST(${slot} AS DATE)` : slot;
    case 'snowflake':
      if (type === 'number') {
        return `${slot}::NUMBER(38, ${scale})`;
      }
      return type === 'date' ? `${slot}::DATE` : `${slot}::BOOLEAN`;
    case 'mssql':
      if (type === 'number') {
        return `CAST(${slot} AS DECIMAL(38, ${scale}))`;
      }
      return type === 'date' ? `CAST(${slot} AS DATE)` : slot;
    case 'duckdb':
      // Its NUMERIC is DECIMAL(18, 3): the value's own scale, in the widest decimal.
      if (type === 'number') {
        return `${slot}::DECIMAL(38, ${scale})`;
      }
      return type === 'date' ? `${slot}::DATE` : `${slot}::BOOLEAN`;
    case 'oracle':
      if (type === 'number') {
        return `TO_NUMBER(${slot}, '${oracleNumberFormat(String(value))}', 'NLS_NUMERIC_CHARACTERS=''.,''')`;
      }
      return type === 'date' ? `TO_DATE(${slot}, 'YYYY-MM-DD')` : slot;
    default:
      return slot;
  }
}

/** Whether a dialect's placeholders are positional, one value per place (`?`), rather than named or numbered for reuse. */
const POSITIONAL = new Set<SqlDialect>(['mysql', 'snowflake']);

/** Whether only blanks stand between `at` and the nearest `(` before it, and the nearest `)` after `end`. */
function inParentheses(sql: string, start: number, end: number): boolean {
  return /\(\s*$/.test(sql.slice(Math.max(0, start - 256), start)) && /^\s*\)/.test(sql.slice(end, end + 256));
}

/**
 * A statement with its `{{name}}` parameters bound: the SQL to check and run,
 * with xcube's placeholders in their places, and the values to bind. Throws
 * `ParameterError` when a parameter has no value, a value is used nowhere, a
 * value isn't of its type, a `{{…}}` is malformed, or the statement writes a
 * placeholder of the database's own; `SqlRefusal` when it can't be read.
 *
 * With `lists`, a value may be a list: one placeholder per item, comma
 * separated, where `{{name}}` is all a parenthesis holds. An empty list, one
 * elsewhere, and more values than the dialect binds (`MAX_BOUND`) are refused.
 */
export function bindParameters(
  sql: string,
  dialect: SqlDialect,
  parameters: Record<string, SqlParameter>,
  options: { lists?: boolean } = {},
): { sql: string; binds: SqlBind[] } {
  const found = placeholdersOf(sql, dialect);
  const redacted = () => redactSql(sql, dialect);
  const missing = [...new Set(found.map((p) => p.name).filter((name) => !Object.prototype.hasOwnProperty.call(parameters, name)))];
  if (missing.length) {
    throw new ParameterError('missing_value', `${missing.map((n) => `{{${n}}}`).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no value`, redacted());
  }
  const used = new Set(found.map((p) => p.name));
  const unused = Object.keys(parameters).filter((name) => !used.has(name));
  if (unused.length) {
    throw new ParameterError(
      'unused_value',
      `${unused.map((n) => `"${n}"`).join(', ')} ${unused.length === 1 ? 'is' : 'are'} given a value but used nowhere in the statement's code`,
      redacted(),
    );
  }
  const limits = MAX_BOUND[dialect];
  for (const name of used) {
    const { type, value } = parameters[name];
    if (Array.isArray(value)) {
      if (!options.lists) {
        throw new ParameterError('invalid_value', `"${name}" is a list: this run binds one value per parameter`, redacted());
      }
      if (!value.length) {
        throw new ParameterError('empty_list', `"${name}" is an empty list: IN () matches nothing, and no database takes it`, redacted());
      }
      if (limits && value.length > limits.list) {
        throw new ParameterError(
          'too_many_values',
          `"${name}" has ${value.length} values: ${DIALECT_NAMES[dialect]} takes at most ${limits.list} in a list`,
          redacted(),
        );
      }
      const outside = found.find((p) => p.name === name && !inParentheses(sql, p.start, p.end));
      if (outside) {
        throw new ParameterError('list_outside_parentheses', `"${name}" is a list: it binds only where {{${name}}} is all a parenthesis holds, as in IN ({{${name}}})`, redacted());
      }
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      const problem = invalid(name, { type, value: item });
      if (problem) {
        throw new ParameterError('invalid_value', Array.isArray(value) ? `${problem} (each item of the list)` : problem, redacted());
      }
      if (dialect === 'clickhouse' && type === 'date' && (item < CLICKHOUSE_DAYS.first || item > CLICKHOUSE_DAYS.last)) {
        throw new ParameterError(
          'invalid_value',
          `"${name}" is a Date ClickHouse can't hold: its days run from ${CLICKHOUSE_DAYS.first} to ${CLICKHOUSE_DAYS.last}`,
          redacted(),
        );
      }
    }
  }

  const binds: SqlBind[] = [];
  // Each named or numbered placeholder, written once per parameter and reused where it recurs.
  const written = new Map<string, string>();
  let slots = 0;
  /** One value's placeholder: a new one on a positional dialect, else the next number or name. */
  const bind = (value: string | boolean, type: ParameterType): string => {
    if (POSITIONAL.has(dialect)) {
      binds.push({ id: String(binds.length + 1), type, value });
      return placeholder(dialect, '?', { type, value });
    }
    slots += 1;
    const n = slots;
    const slot = { postgres: `$${n}`, redshift: `$${n}`, duckdb: `$${n}`, bigquery: `@p${n}`, mssql: `@p${n}`, oracle: `:p${n}`, clickhouse: `p${n}` }[dialect as string]!;
    binds.push({ id: dialect === 'postgres' || dialect === 'redshift' || dialect === 'duckdb' ? String(n) : `p${n}`, type, value });
    return placeholder(dialect, slot, { type, value });
  };
  const placeholdersFor = (name: string): string => {
    let text = POSITIONAL.has(dialect) ? undefined : written.get(name);
    if (text === undefined) {
      const { type, value } = parameters[name];
      // A list's items, comma separated, each a placeholder of its own.
      text = (Array.isArray(value) ? value : [value]).map((item) => bind(item, type)).join(' , ');
      written.set(name, text);
    }
    return text;
  };
  let out = '';
  let at = 0;
  for (const p of found) {
    // Spaces around it: `x{{a}}` never becomes `x$1`, nor `{{a}}0` `$10`.
    out += `${sql.slice(at, p.start)} ${placeholdersFor(p.name)} `;
    at = p.end;
  }
  if (limits && binds.length > limits.total) {
    throw new ParameterError(
      'too_many_values',
      `The statement binds ${binds.length} values: ${DIALECT_NAMES[dialect]} takes at most ${limits.total} in a statement`,
      redacted(),
    );
  }
  return { sql: out + sql.slice(at), binds };
}
