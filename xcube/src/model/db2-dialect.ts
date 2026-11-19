/**
 * The SQL dialect xcube compiles Db2 data sources with: Cube has none of its
 * own. On `BaseQuery`, for both planners (Tesseract's templates, and the
 * legacy planner's methods), what Db2's SQL (LUW 11.1 and later) differs in:
 * - `OFFSET n ROWS FETCH FIRST m ROWS ONLY`, never LIMIT;
 * - GROUP BY its expressions: Db2 groups by no ordinal;
 * - `TRUNC_TIMESTAMP(…, 'MM')` for each granularity, a week from its Monday
 *   (`IW`);
 * - `FROM_UTC_TIMESTAMP` for a time zone: it answers its input unchanged for
 *   a zone it doesn't know, so a zone that isn't one is refused here;
 * - labeled durations (`ts + 3 MONTHS`), a unit at a time;
 * - a timestamp's string with a space for Cube's ISO `T` and no `Z`;
 * - no ILIKE: LOWER on both sides of LIKE, `\` its escape;
 * - no approximate count distinct: Cube refuses one, as for any dialect
 *   without it;
 * - its own names for the types and functions Cube's SQL API pushes down.
 */
import moment from 'moment-timezone';
import { splitSqlInterval } from '@cubejs-backend/shared';
import { BaseFilter } from '@cubejs-backend/schema-compiler/dist/src/adapter/BaseFilter';
import { BaseQuery } from '@cubejs-backend/schema-compiler/dist/src/adapter/BaseQuery';
import { UserError } from '@cubejs-backend/schema-compiler/dist/src/compiler/UserError';

/** Each granularity's TRUNC_TIMESTAMP format: a week starts on Monday (ISO). */
const TRUNCATED: Record<string, string> = {
  second: 'SS',
  minute: 'MI',
  hour: 'HH',
  day: 'DD',
  week: 'IW',
  month: 'MM',
  quarter: 'Q',
  year: 'YYYY',
};

/** Db2's labeled durations, by Cube's interval unit; a quarter is three months, a week seven days. */
const DURATIONS: Record<string, [number, string]> = {
  year: [1, 'YEARS'],
  quarter: [3, 'MONTHS'],
  month: [1, 'MONTHS'],
  week: [7, 'DAYS'],
  day: [1, 'DAYS'],
  hour: [1, 'HOURS'],
  minute: [1, 'MINUTES'],
  second: [1, 'SECONDS'],
};

/** Cube's ISO timestamp string (`2026-01-01T00:00:00.000Z`) as Db2 reads one, cast. */
const timestampOf = (value: string) => `CAST(REPLACE(REPLACE(${value}, 'T', ' '), 'Z', '') AS TIMESTAMP)`;

/** The legacy planner's `contains`, `startsWith` and `endsWith`: LIKE on both sides lowered, with Db2's escape given. */
class Db2Filter extends BaseFilter {
  public override likeIgnoreCase(column: string, not: boolean, param: unknown, type: string) {
    const p = (!type || type === 'contains' || type === 'ends') ? '\'%\' || ' : '';
    const s = (!type || type === 'contains' || type === 'starts') ? ' || \'%\'' : '';
    return `LOWER(${column})${not ? ' NOT' : ''} LIKE LOWER(${p}${this.allocateParam(param)}${s}) ESCAPE '\\'`;
  }
}

export class XcubeDb2Query extends BaseQuery {
  public override newFilter(filter: any): BaseFilter {
    return new Db2Filter(this, filter);
  }

  /** A time zone Db2 converts to: an IANA name; any other is refused, as Db2 would answer UTC's value for it unchanged. */
  public override convertTz(field: string) {
    const zone = this.timezone;
    if (!zone || zone === 'UTC' || zone === 'Etc/UTC') {
      return field;
    }
    if (!moment.tz.zone(zone) || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(zone)) {
      throw new UserError(`Db2 converts to an IANA time zone, such as America/Los_Angeles, not ${JSON.stringify(zone)}`);
    }
    return `FROM_UTC_TIMESTAMP(${field}, '${zone}')`;
  }

  public override timeStampCast(value: string) {
    return timestampOf(value);
  }

  public override dateTimeCast(value: string) {
    return timestampOf(value);
  }

  public override timeGroupedColumn(granularity: string, dimension: string) {
    const format = TRUNCATED[granularity];
    if (!format) {
      throw new UserError(`Db2 has no ${granularity} granularity here: second, minute, hour, day, week, month, quarter or year`);
    }
    return `TRUNC_TIMESTAMP(CAST(${dimension} AS TIMESTAMP), '${format}')`;
  }

  public override subtractInterval(date: string, interval: string) {
    return this.applyInterval('-', date, interval);
  }

  public override addInterval(date: string, interval: string) {
    return this.applyInterval('+', date, interval);
  }

  /** A labeled duration per unit, coarsest first. */
  protected applyInterval(operator: '+' | '-', date: string, interval: string): string {
    return splitSqlInterval(interval).reduce((acc, part) => {
      const [n, unit] = this.parseInterval(part);
      const duration = DURATIONS[String(unit).toLowerCase().replace(/s$/, '')];
      if (!duration) {
        throw new UserError(`Db2 has no interval of ${unit} here`);
      }
      return `(${acc} ${operator} ${Number(n) * duration[0]} ${duration[1]})`;
    }, date);
  }

  /** Db2 groups by no ordinal: by the dimensions' expressions. */
  public override groupByClause() {
    const dimensions = this.forSelect().filter((item: any) => !!item.dimension && item.selectColumns && item.selectColumns());
    return dimensions.length ? ` GROUP BY ${dimensions.map((item: any) => item.dimensionSql()).join(', ')}` : '';
  }

  /** `OFFSET n ROWS FETCH FIRST m ROWS ONLY`, as Oracle's: Db2 has no LIMIT without its MySQL compatibility. */
  public override groupByDimensionLimit() {
    const rowLimit = this.parsedRowLimit() ?? 10000;
    const limit = this.rowLimit === null ? '' : ` FETCH FIRST ${rowLimit} ROWS ONLY`;
    const offset = this.offset ? ` OFFSET ${parseInt(this.offset, 10)} ROWS` : '';
    return `${offset}${limit}`;
  }

  public override castToString(sql: string) {
    return `CAST(${sql} AS VARCHAR(32672))`;
  }

  public override unixTimestampSql() {
    return '((DAYS(CURRENT TIMESTAMP - CURRENT TIMEZONE) - DAYS(\'1970-01-01\')) * 86400 + MIDNIGHT_SECONDS(CURRENT TIMESTAMP - CURRENT TIMEZONE))';
  }

  public override nowTimestampSql() {
    return '(CURRENT TIMESTAMP - CURRENT TIMEZONE)';
  }

  public override defaultRefreshKeyRenewalThreshold() {
    return 120;
  }

  public override seriesSql(timeDimension: any) {
    const values = timeDimension.timeSeries().map(
      ([from, to]: [string, string]) => `('${from.replace('T', ' ')}', '${to.replace('T', ' ')}')`,
    ).join(', ');
    return `SELECT CAST(dates.f AS TIMESTAMP) AS "date_from", CAST(dates.t AS TIMESTAMP) AS "date_to" FROM (VALUES ${values}) AS dates (f, t)`;
  }

  public override sqlTemplates() {
    const templates = super.sqlTemplates();
    templates.statements.group_by_exprs = '{{ group_by | map(attribute=\'expr\') | join(\', \') }}';
    templates.statements.select = '{% if ctes %} WITH \n'
      + '{{ ctes | join(\',\n\') }}\n'
      + '{% endif %}'
      + 'SELECT {% if distinct %}DISTINCT {% endif %}'
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
      + '{% if order_by %}\nORDER BY {{ order_by | map(attribute=\'expr\') | join(\', \') }}{% endif %}'
      + '{% if offset is not none %}\nOFFSET {{ offset }} ROWS{% endif %}'
      + '{% if limit is not none %}\nFETCH FIRST {{ limit }} ROWS ONLY{% endif %}';
    templates.statements.union = '{% for query in queries %}(\n'
      + '{{ query | indent(2, true) }}\n'
      + ')'
      + '{% if not loop.last %}\nUNION {% if not distinct %}ALL {% endif %}{% endif %}'
      + '{% endfor %}'
      + '{% if limit is not none %}\nFETCH FIRST {{ limit }} ROWS ONLY{% endif %}';
    templates.statements.time_series_select = 'SELECT CAST(dates.f AS TIMESTAMP) AS "date_from",\n'
      + 'CAST(dates.t AS TIMESTAMP) AS "date_to"\n'
      + 'FROM (VALUES '
      + '{% for time_item in seria %}'
      + '(\'{{ time_item[0] | replace("T", " ") }}\', \'{{ time_item[1] | replace("T", " ") }}\')'
      + '{% if not loop.last %}, {% endif %}'
      + '{% endfor %}'
      + ') AS dates (f, t)';
    templates.expressions.timestamp_literal = 'CAST(\'{{ value | replace("T", " ") | replace("Z", "") }}\' AS TIMESTAMP)';
    templates.tesseract.time_param_cast = timestampOf('{{ expr }}');
    templates.expressions.like = '{{ expr }} {% if negated %}NOT {% endif %}LIKE {{ pattern }}{% if default_escape %} ESCAPE \'\\\'{% endif %}';
    delete templates.expressions.ilike;
    templates.tesseract.ilike = 'LOWER({{ expr }}) {% if negated %}NOT {% endif %}LIKE LOWER({{ pattern }}) ESCAPE \'\\\'';
    // Labeled durations take a number and a unit: the SQL API's intervals aren't written so.
    delete templates.expressions.add_interval;
    delete templates.expressions.sub_interval;
    templates.functions.STRING_AGG = 'LISTAGG({% if distinct %}DISTINCT {% endif %}{{ args_concat }})';
    templates.functions.STDDEV_POP = 'STDDEV({{ args_concat }})';
    templates.functions.VAR_POP = 'VARIANCE({{ args_concat }})';
    templates.functions.VAR_SAMP = 'VARIANCE_SAMP({{ args_concat }})';
    templates.functions.COVAR_POP = 'COVARIANCE({{ args_concat }})';
    templates.functions.COVAR_SAMP = 'COVARIANCE_SAMP({{ args_concat }})';
    templates.functions.BTRIM = 'TRIM({{ args_concat }})';
    templates.functions.SUBSTR = 'SUBSTR({{ args_concat }})';
    templates.functions.CHARACTERLENGTH = 'LENGTH({{ args[0] }}, CODEUNITS32)';
    templates.functions.STRPOS = 'LOCATE({{ args[1] }}, {{ args[0] }})';
    templates.functions.UTCTIMESTAMP = '(CURRENT TIMESTAMP - CURRENT TIMEZONE)';
    delete templates.functions.DATEDIFF;
    delete templates.functions.LOG;
    templates.types.string = 'VARCHAR(32672)';
    templates.types.tinyint = 'SMALLINT';
    templates.types.binary = 'BLOB';
    delete templates.types.interval;
    return templates;
  }
}
