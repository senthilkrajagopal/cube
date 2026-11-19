/**
 * The SQL dialect xcube compiles Teradata data sources with: Cube has none
 * of its own. On `BaseQuery`, shaped after Cube's SQL Server dialect, for
 * Tesseract (the planner, R4) and the legacy planner as far as it goes:
 * - `TOP n` for a limit, Teradata has no LIMIT; an offset as `QUALIFY
 *   ROW_NUMBER() OVER (ORDER BY …)` between its rows (Tesseract; the legacy
 *   planner refuses an offset);
 * - ORDER BY expressions, never ordinals, so the same order serves QUALIFY;
 *   and only on a statement with a limit or an offset: Teradata refuses one
 *   in a subquery or a CTE, and Cube's outermost query has its row limit;
 * - each granularity as a TIMESTAMP(0): `TRUNC` (which answers a DATE) cast,
 *   a week from its Monday (`IW`); an hour and a minute from `TO_CHAR`;
 * - months by `ADD_MONTHS`, days and finer by intervals of up to four digits;
 * - no BOOLEAN: a predicate's true and false as `1=1` and `1=0`;
 * - no ILIKE: LOWER on both sides of LIKE, `\` its escape;
 * - Cube's ISO timestamps read with `OREPLACE`;
 * - **a time zone other than UTC is refused** with a time dimension:
 *   Teradata takes its own zone names, not IANA's, and until a server shows
 *   a conversion that holds across a daylight-saving change none is guessed.
 */
import { splitSqlInterval } from '@cubejs-backend/shared';
import { BaseFilter } from '@cubejs-backend/schema-compiler/dist/src/adapter/BaseFilter';
import { BaseQuery } from '@cubejs-backend/schema-compiler/dist/src/adapter/BaseQuery';
import { UserError } from '@cubejs-backend/schema-compiler/dist/src/compiler/UserError';

/** Each granularity as a TIMESTAMP(0). */
const TRUNCATED: Record<string, (d: string) => string> = {
  second: (d) => `CAST(${d} AS TIMESTAMP(0))`,
  minute: (d) => `CAST(TO_CHAR(${d}, 'YYYY-MM-DD HH24:MI') || ':00' AS TIMESTAMP(0))`,
  hour: (d) => `CAST(TO_CHAR(${d}, 'YYYY-MM-DD HH24') || ':00:00' AS TIMESTAMP(0))`,
  day: (d) => `CAST(TRUNC(${d}, 'DD') AS TIMESTAMP(0))`,
  week: (d) => `CAST(TRUNC(${d}, 'IW') AS TIMESTAMP(0))`,
  month: (d) => `CAST(TRUNC(${d}, 'MM') AS TIMESTAMP(0))`,
  quarter: (d) => `CAST(TRUNC(${d}, 'Q') AS TIMESTAMP(0))`,
  year: (d) => `CAST(TRUNC(${d}, 'YYYY') AS TIMESTAMP(0))`,
};

/** An interval of a unit finer than a month: its literal, up to 9,999 of it. */
const INTERVAL_UNITS: Record<string, [number, string]> = {
  week: [7, 'DAY'],
  day: [1, 'DAY'],
  hour: [1, 'HOUR'],
  minute: [1, 'MINUTE'],
  second: [1, 'SECOND'],
};

const MONTHS: Record<string, number> = { year: 12, quarter: 3, month: 1 };

/** Cube's ISO timestamp string (`2026-01-01T00:00:00.000Z`) as Teradata reads one, cast. */
const timestampOf = (value: string) => `CAST(OREPLACE(OREPLACE(${value}, 'T', ' '), 'Z', '') AS TIMESTAMP(3))`;

const isUtc = (zone: string | undefined) => !zone || zone === 'UTC' || zone === 'Etc/UTC' || zone === 'GMT';

class TeradataFilter extends BaseFilter {
  public override likeIgnoreCase(column: string, not: boolean, param: unknown, type: string) {
    const p = (!type || type === 'contains' || type === 'ends') ? '\'%\' || ' : '';
    const s = (!type || type === 'contains' || type === 'starts') ? ' || \'%\'' : '';
    return `LOWER(${column})${not ? ' NOT' : ''} LIKE LOWER(${p}${this.allocateParam(param)}${s}) ESCAPE '\\'`;
  }
}

export class XcubeTeradataQuery extends BaseQuery {
  public override newFilter(filter: any): BaseFilter {
    return new TeradataFilter(this, filter);
  }

  /** UTC only: a time zone Teradata would have to be told in its own names is refused, never guessed. */
  public override convertTz(field: string) {
    if (!isUtc(this.timezone)) {
      throw new UserError(`A Teradata data source is queried in UTC only for now, not ${JSON.stringify(this.timezone)}: `
        + 'Teradata names its time zones its own way, and a conversion across a daylight-saving change isn\'t yet shown on a server');
    }
    return field;
  }

  public override timeStampCast(value: string) {
    return timestampOf(value);
  }

  public override dateTimeCast(value: string) {
    return timestampOf(value);
  }

  public override timeGroupedColumn(granularity: string, dimension: string) {
    const truncate = TRUNCATED[granularity];
    if (!truncate) {
      throw new UserError(`Teradata has no ${granularity} granularity here: second, minute, hour, day, week, month, quarter or year`);
    }
    return truncate(dimension);
  }

  public override subtractInterval(date: string, interval: string) {
    return this.applyInterval(-1, date, interval);
  }

  public override addInterval(date: string, interval: string) {
    return this.applyInterval(1, date, interval);
  }

  /** ADD_MONTHS for years, quarters and months (an interval month fails on the 31st); an interval per finer unit. */
  protected applyInterval(sign: 1 | -1, date: string, interval: string): string {
    return splitSqlInterval(interval).reduce((acc, part) => {
      const [n, unit] = this.parseInterval(part);
      const key = String(unit).toLowerCase().replace(/s$/, '');
      if (MONTHS[key]) {
        return `ADD_MONTHS(${acc}, ${sign * Number(n) * MONTHS[key]})`;
      }
      const finer = INTERVAL_UNITS[key];
      const count = Number(n) * (finer?.[0] ?? 0);
      if (!finer || count > 9999) {
        throw new UserError(`Teradata has no interval of ${n} ${unit} here`);
      }
      return `(${acc} ${sign > 0 ? '+' : '-'} INTERVAL '${count}' ${finer[1]}(4))`;
    }, date);
  }

  /** A limit as TOP (Teradata has no LIMIT), when there is no offset. */
  public override topLimit() {
    if (this.rowLimit === null) {
      return '';
    }
    if (this.offset) {
      throw new UserError('An offset on a Teradata data source is planned by Tesseract only (CUBEJS_TESSERACT_SQL_PLANNER)');
    }
    return ` TOP ${this.parsedRowLimit() ?? 10000} `;
  }

  public override groupByDimensionLimit() {
    return '';
  }

  public override castToString(sql: string) {
    return `CAST(${sql} AS VARCHAR(10000))`;
  }

  public override unixTimestampSql() {
    const now = 'CURRENT_TIMESTAMP(0) AT \'GMT\'';
    return `(CAST(CAST(${now} AS DATE) - DATE '1970-01-01' AS BIGINT) * 86400 + EXTRACT(HOUR FROM ${now}) * 3600 `
      + `+ EXTRACT(MINUTE FROM ${now}) * 60 + EXTRACT(SECOND FROM ${now}))`;
  }

  public override nowTimestampSql() {
    return 'CURRENT_TIMESTAMP(3) AT \'GMT\'';
  }

  public override defaultRefreshKeyRenewalThreshold() {
    return 120;
  }

  public override seriesSql(timeDimension: any) {
    const values = timeDimension.timeSeries().map(
      ([from, to]: [string, string]) => `SELECT '${from.replace('T', ' ')}' AS f, '${to.replace('T', ' ')}' AS t`,
    ).join(' UNION ALL ');
    return `SELECT CAST(dates.f AS TIMESTAMP(3)) AS "date_from", CAST(dates.t AS TIMESTAMP(3)) AS "date_to" FROM (${values}) AS dates`;
  }

  public override sqlTemplates() {
    const templates = super.sqlTemplates();
    const orderBy = '{{ order_by | map(attribute=\'expr\') | join(\', \') }}';
    templates.statements.select = '{% if ctes %} WITH \n'
      + '{{ ctes | join(\',\n\') }}\n'
      + '{% endif %}'
      + 'SELECT {% if distinct %}DISTINCT {% endif %}{% if limit is not none and offset is none %}TOP {{ limit }} {% endif %}'
      + '{{ select_concat | map(attribute=\'aliased\') | join(\', \') }} {% if from %}\n'
      + 'FROM (\n'
      + '{{ from | indent(2, true) }}\n'
      + ') AS {{ from_alias }}{% elif from_prepared %}\n'
      + 'FROM {{ from_prepared }}'
      + '{% endif %}'
      + '{% for join in joins %}\n{{ join }}{% endfor %}'
      + '{% if filter %}\nWHERE {{ filter }}{% endif %}'
      + '{% if group_by %}\nGROUP BY {{ group_by }}{% endif %}'
      + '{% if having %}\nHAVING {{ having }}{% endif %}'
      + `{% if offset is not none %}\nQUALIFY ROW_NUMBER() OVER (ORDER BY {% if order_by %}${orderBy}{% else %}1{% endif %}) > {{ offset }}`
      + `{% if limit is not none %} AND ROW_NUMBER() OVER (ORDER BY {% if order_by %}${orderBy}{% else %}1{% endif %}) <= {{ offset }} + {{ limit }}{% endif %}{% endif %}`
      // Teradata refuses an ORDER BY in a subquery or a CTE: one only where a limit or offset makes it
      // the statement Cube reads (Cube's own outermost query always has its row limit).
      + `{% if order_by and (limit is not none or offset is not none) %}\nORDER BY ${orderBy}{% endif %}`;
    // An order by its expression, never its ordinal: QUALIFY's window reads the same order.
    templates.expressions.order_by = '{{ expr }} {% if asc %}ASC{% else %}DESC{% endif %}{% if nulls_first %} NULLS FIRST{% endif %}';
    templates.statements.union = '{% if limit is not none %}SELECT TOP {{ limit }} * FROM (\n{% endif %}'
      + '{% for query in queries %}(\n'
      + '{{ query | indent(2, true) }}\n'
      + ')'
      + '{% if not loop.last %}\nUNION {% if not distinct %}ALL {% endif %}{% endif %}'
      + '{% endfor %}'
      + '{% if limit is not none %}\n) AS union_result{% endif %}';
    // No VALUES table constructor: the series as SELECTs without a table.
    templates.statements.time_series_select = 'SELECT CAST(dates.f AS TIMESTAMP(3)) AS "date_from",\n'
      + 'CAST(dates.t AS TIMESTAMP(3)) AS "date_to"\n'
      + 'FROM (\n'
      + '{% for time_item in seria %}'
      + 'SELECT \'{{ time_item[0] | replace("T", " ") }}\' AS f, \'{{ time_item[1] | replace("T", " ") }}\' AS t'
      + '{% if not loop.last %} UNION ALL\n{% endif %}'
      + '{% endfor %}'
      + ') AS dates';
    templates.expressions.timestamp_literal = 'CAST(\'{{ value | replace("T", " ") | replace("Z", "") }}\' AS TIMESTAMP(3))';
    templates.tesseract.time_param_cast = timestampOf('{{ expr }}');
    templates.expressions.true = '(1=1)';
    templates.expressions.false = '(1=0)';
    templates.expressions.like = '{{ expr }} {% if negated %}NOT {% endif %}LIKE {{ pattern }}{% if default_escape %} ESCAPE \'\\\'{% endif %}';
    delete templates.expressions.ilike;
    templates.tesseract.ilike = 'LOWER({{ expr }}) {% if negated %}NOT {% endif %}LIKE LOWER({{ pattern }}) ESCAPE \'\\\'';
    delete templates.expressions.add_interval;
    delete templates.expressions.sub_interval;
    templates.functions.SUBSTR = 'SUBSTR({{ args_concat }})';
    templates.functions.BTRIM = 'TRIM({{ args_concat }})';
    templates.functions.CHARACTERLENGTH = 'CHARACTER_LENGTH({{ args[0] }})';
    templates.functions.STRPOS = 'POSITION({{ args[1] }} IN {{ args[0] }})';
    templates.functions.REPLACE = 'OREPLACE({{ args_concat }})';
    templates.functions.UTCTIMESTAMP = 'CURRENT_TIMESTAMP(3) AT \'GMT\'';
    templates.functions.STRING_AGG = 'LISTAGG({{ args_concat }})';
    delete templates.functions.DATEDIFF;
    delete templates.functions.CONCAT;
    templates.types.string = 'VARCHAR(10000)';
    templates.types.boolean = 'BYTEINT';
    templates.types.tinyint = 'BYTEINT';
    templates.types.double = 'FLOAT';
    templates.types.binary = 'VARBYTE(64000)';
    delete templates.types.interval;
    return templates;
  }
}
