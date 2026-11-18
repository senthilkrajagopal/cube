/**
 * The SQL dialect xcube compiles Impala data sources with: Cube has none of
 * its own. On `BaseQuery`, for both planners (Tesseract's templates, and the
 * legacy planner's methods), what Impala's SQL differs in:
 * - names in backticks: a double quote opens a string, and a doubled
 *   backtick is no backtick (a backslash escapes one);
 * - `DATE_TRUNC` for each granularity but the quarter, which is `TRUNC(…, 'Q')`;
 * - `FROM_UTC_TIMESTAMP` for a time zone, and `INTERVAL n unit` with one unit;
 * - `CONCAT`, not `||` (Impala's OR);
 * - `NDV` for an approximate count distinct;
 * - LIKE with a pattern the row is bound to: Impala matches a constant
 *   pattern of the form `%…%` as a substring, its backslash escape included,
 *   so `name LIKE '%\%%'` finds no `50%`; a pattern that depends on the row
 *   is matched rightly. Impala has no ESCAPE clause: a backslash escapes.
 */
import { splitSqlInterval } from '@cubejs-backend/shared';
import { BaseFilter } from '@cubejs-backend/schema-compiler/dist/src/adapter/BaseFilter';
import { BaseQuery } from '@cubejs-backend/schema-compiler/dist/src/adapter/BaseQuery';

/** A timestamp truncated to each granularity, as a TIMESTAMP; a week starts on Monday. */
const TRUNCATED: Record<string, (d: string) => string> = {
  second: (d) => `DATE_TRUNC('second', ${d})`,
  minute: (d) => `DATE_TRUNC('minute', ${d})`,
  hour: (d) => `DATE_TRUNC('hour', ${d})`,
  day: (d) => `DATE_TRUNC('day', ${d})`,
  week: (d) => `DATE_TRUNC('week', ${d})`,
  month: (d) => `DATE_TRUNC('month', ${d})`,
  // DATE_TRUNC has no quarter (Impala 4.5).
  quarter: (d) => `TRUNC(${d}, 'Q')`,
  year: (d) => `DATE_TRUNC('year', ${d})`,
};

/** An empty string that depends on the row: a LIKE pattern with it added is matched rightly (see above). */
const rowBound = (expr: string) => `SUBSTR(CAST(${expr} AS STRING), 1, 0)`;

/** The legacy planner's `contains`, `startsWith` and `endsWith`: ILIKE, the pattern by CONCAT and bound to the row. */
class ImpalaFilter extends BaseFilter {
  public override likeIgnoreCase(column: string, not: boolean, param: unknown, type: string) {
    const p = (!type || type === 'contains' || type === 'ends') ? '\'%\'' : '\'\'';
    const s = (!type || type === 'contains' || type === 'starts') ? '\'%\'' : '\'\'';
    return `${column}${not ? ' NOT' : ''} ILIKE CONCAT(${p}, ${this.allocateParam(param)}, ${s}, ${rowBound(column)})`;
  }
}

export class XcubeImpalaQuery extends BaseQuery {
  public override newFilter(filter: any): BaseFilter {
    return new ImpalaFilter(this, filter);
  }

  public override escapeColumnName(name: string) {
    return `\`${name}\``;
  }

  public override convertTz(field: string) {
    return `FROM_UTC_TIMESTAMP(${field}, '${this.timezone}')`;
  }

  public override timeStampCast(value: string) {
    return `CAST(${value} AS TIMESTAMP)`;
  }

  public override dateTimeCast(value: string) {
    return `CAST(${value} AS TIMESTAMP)`;
  }

  public override timeGroupedColumn(granularity: string, dimension: string) {
    const truncate = TRUNCATED[granularity];
    if (!truncate) {
      throw new Error(`Impala has no ${granularity} granularity here: second, minute, hour, day, week, month, quarter or year`);
    }
    return truncate(dimension);
  }

  public override subtractInterval(date: string, interval: string) {
    return this.applyInterval('-', date, interval);
  }

  public override addInterval(date: string, interval: string) {
    return this.applyInterval('+', date, interval);
  }

  /** One unit at a time, coarsest first: an INTERVAL carries one; a quarter is three months (Impala has none). */
  protected applyInterval(operator: '+' | '-', date: string, interval: string): string {
    return splitSqlInterval(interval).reduce((acc, part) => {
      const [n, unit] = this.parseInterval(part);
      const quarter = /^quarters?$/i.test(unit);
      return `(${acc} ${operator} INTERVAL ${quarter ? Number(n) * 3 : Number(n)} ${quarter ? 'MONTH' : unit.toUpperCase()})`;
    }, date);
  }

  public override castToString(sql: string) {
    return `CAST(${sql} AS STRING)`;
  }

  public override concatStringsSql(strings: string[]) {
    return `CONCAT(${strings.join(', ')})`;
  }

  public override countDistinctApprox(sql: string) {
    return `NDV(${sql})`;
  }

  public override unixTimestampSql() {
    return 'UNIX_TIMESTAMP()';
  }

  public override defaultRefreshKeyRenewalThreshold() {
    return 120;
  }

  public override seriesSql(timeDimension: any) {
    const values = timeDimension.timeSeries().map(
      ([from, to]: [string, string]) => `SELECT '${from.replace('T', ' ')}' AS f, '${to.replace('T', ' ')}' AS t`,
    ).join(' UNION ALL ');
    return `SELECT CAST(dates.f AS TIMESTAMP) AS \`date_from\`, CAST(dates.t AS TIMESTAMP) AS \`date_to\` FROM (${values}) AS dates`;
  }

  public override sqlTemplates() {
    const templates = super.sqlTemplates();
    templates.quotes.identifiers = '`';
    templates.quotes.escape = '\\`';
    templates.expressions.concat_strings = 'CONCAT({{ strings | join(\', \') }})';
    templates.expressions.int_division = '({{ left }} DIV {{ right }})';
    templates.expressions.add_interval = '{{ date }} + INTERVAL {{ interval }}';
    templates.expressions.sub_interval = '{{ date }} - INTERVAL {{ interval }}';
    templates.expressions.like = `{{ expr }} {% if negated %}NOT {% endif %}LIKE CONCAT({{ pattern }}, ${rowBound('{{ expr }}')})`;
    templates.expressions.ilike = `{{ expr }} {% if negated %}NOT {% endif %}ILIKE CONCAT({{ pattern }}, ${rowBound('{{ expr }}')})`;
    templates.tesseract.ilike = `{{ expr }} {% if negated %}NOT {% endif %}ILIKE CONCAT({{ pattern }}, ${rowBound('{{ expr }}')})`;
    delete templates.expressions.like_escape;
    templates.filters.like_pattern = 'CONCAT({% if start_wild %}\'%\'{% else %}\'\'{% endif %}, {{ value }}, {% if end_wild %}\'%\'{% else %}\'\'{% endif %})';
    templates.statements.time_series_select = 'SELECT CAST(dates.f AS TIMESTAMP) AS `date_from`, CAST(dates.t AS TIMESTAMP) AS `date_to`\n'
      + 'FROM (\n'
      + '{% for time_item in seria %}'
      + '  SELECT \'{{ time_item[0] | replace("T", " ") }}\' AS f, \'{{ time_item[1] | replace("T", " ") }}\' AS t\n'
      + '{% if not loop.last %}  UNION ALL\n{% endif %}'
      + '{% endfor %}'
      + ') AS dates';
    templates.types.integer = 'INT';
    delete templates.types.time;
    delete templates.functions.WIDTH_BUCKET;
    return templates;
  }
}
