/**
 * Bound parameters on the SQL runner (wechart's F42). A statement names each
 * parameter `{{name}}` in its code; xcube finds them with the dialect's own
 * lexer (`placeholdersOf`), so that what its check reads is what runs, and
 * writes in their place placeholders of its own (`$1`, `?`, `@p1`, `:p1`),
 * typed, each between spaces. The values go to the driver as binds, never into
 * the statement's text, and are never logged.
 */
import {
  ParameterError, placeholdersOf, redactSql, type SqlDialect,
} from './classify';

export type ParameterType = 'text' | 'number' | 'date' | 'boolean';

/** A parameter as the client gives it: a number as a decimal string, a date as `YYYY-MM-DD`. */
export interface SqlParameter {
  type: ParameterType;
  value: string | boolean;
}

/** One value bound, by the placeholder xcube wrote: a position (`?`, `$n`), or a name (`p1`). */
export interface SqlBind {
  /** The placeholder's name without its sigil (`p1`), or its 1-based position. */
  id: string;
  type: ParameterType;
  /** Text, a number's decimal string, a date's `YYYY-MM-DD`, or a boolean. */
  value: string | boolean;
}

/** Where binding isn't proven: their drivers take no binds (Dremio's job API, Cube Store's). */
export const UNBOUND_DIALECTS = new Set<SqlDialect>(['dremio', 'cubestore']);

/** A number's decimal string: at most 38 digits, at most 30 after the point (every dialect's exact decimal holds it). */
const DECIMAL = /^-?(\d+)(?:\.(\d+))?$/;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The value, checked against its type: the reason it isn't one, or nothing. */
function invalid(name: string, parameter: SqlParameter): string | null {
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
function placeholder(dialect: SqlDialect, slot: string, parameter: SqlParameter): string {
  const { type, value } = parameter;
  const scale = scaleOf(value);
  if (dialect === 'postgres' || dialect === 'redshift') {
    return `${slot}::${{ text: 'text', number: 'numeric', date: 'date', boolean: 'boolean' }[type]}`;
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

/**
 * A statement with its `{{name}}` parameters bound: the SQL to check and run,
 * with xcube's placeholders in their places, and the values to bind. Throws
 * `ParameterError` when a parameter has no value, a value is used nowhere, a
 * value isn't of its type, a `{{…}}` is malformed, or the statement writes a
 * placeholder of the database's own; `SqlRefusal` when it can't be read.
 */
export function bindParameters(sql: string, dialect: SqlDialect, parameters: Record<string, SqlParameter>): { sql: string; binds: SqlBind[] } {
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
  for (const name of used) {
    const problem = invalid(name, parameters[name]);
    if (problem) {
      throw new ParameterError('invalid_value', problem, redacted());
    }
  }

  const binds: SqlBind[] = [];
  const slots = new Map<string, string>();
  const slotOf = (name: string): string => {
    const parameter = parameters[name];
    if (POSITIONAL.has(dialect)) {
      binds.push({ id: String(binds.length + 1), ...parameter });
      return '?';
    }
    let slot = slots.get(name);
    if (!slot) {
      const n = slots.size + 1;
      slot = { postgres: `$${n}`, redshift: `$${n}`, bigquery: `@p${n}`, mssql: `@p${n}`, oracle: `:p${n}` }[dialect as string]!;
      binds.push({ id: dialect === 'postgres' || dialect === 'redshift' ? String(n) : `p${n}`, ...parameter });
      slots.set(name, slot);
    }
    return slot;
  };
  let out = '';
  let at = 0;
  for (const p of found) {
    // Spaces around it: `x{{a}}` never becomes `x$1`, nor `{{a}}0` `$10`.
    out += `${sql.slice(at, p.start)} ${placeholder(dialect, slotOf(p.name), parameters[p.name])} `;
    at = p.end;
  }
  return { sql: out + sql.slice(at), binds };
}
