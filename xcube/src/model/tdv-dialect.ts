/**
 * The SQL dialect xcube compiles TIBCO Data Virtualization data sources
 * with: Cube has none of its own. On `BaseQuery`, for both planners, using
 * only functions TDV runs itself (none it only pushes to a source):
 * - `TOP n` for a limit; with an offset, `OFFSET n ROWS FETCH NEXT m ROWS
 *   ONLY` after the ORDER BY (TDV takes it on the outermost SELECT);
 * - `TRUNC(…, fmt)` for a week (`IW`, from Monday) and a quarter,
 *   `DATE_TRUNC` for the rest, each cast to a TIMESTAMP;
 * - `TZCONVERTOR(…, 'UTC', zone)` for a time zone, an IANA name only;
 * - `TIMESTAMPADD(unit, n, …)`, a unit at a time;
 * - no ILIKE: LOWER on both sides of LIKE, `\` its escape;
 * - Cube's ISO timestamps read with a space for `T` and no `Z`;
 * - no approximate count distinct (TDV's only pushes to a source).
 */
import moment from 'moment-timezone';
import { splitSqlInterval } from '@cubejs-backend/shared';
import { BaseFilter } from '@cubejs-backend/schema-compiler/dist/src/adapter/BaseFilter';
import { BaseQuery } from '@cubejs-backend/schema-compiler/dist/src/adapter/BaseQuery';
import { UserError } from '@cubejs-backend/schema-compiler/dist/src/compiler/UserError';

const TRUNCATED: Record<string, (d: string) => string> = {
  second: (d) => `CAST(DATE_TRUNC('SECOND', ${d}) AS TIMESTAMP)`,
  minute: (d) => `CAST(DATE_TRUNC('MINUTE', ${d}) AS TIMESTAMP)`,
  hour: (d) => `CAST(DATE_TRUNC('HOUR', ${d}) AS TIMESTAMP)`,
  day: (d) => `CAST(DATE_TRUNC('DAY', ${d}) AS TIMESTAMP)`,
  week: (d) => `CAST(TRUNC(${d}, 'IW') AS TIMESTAMP)`,
  month: (d) => `CAST(DATE_TRUNC('MONTH', ${d}) AS TIMESTAMP)`,
  quarter: (d) => `CAST(TRUNC(${d}, 'Q') AS TIMESTAMP)`,
  year: (d) => `CAST(DATE_TRUNC('YEAR', ${d}) AS TIMESTAMP)`,
};

/** TIMESTAMPADD's unit, and how many of it, for each of Cube's units. */
const UNITS: Record<string, [number, string]> = {
  year: [1, 'YEAR'],
  quarter: [3, 'MONTH'],
  month: [1, 'MONTH'],
  week: [7, 'DAY'],
  day: [1, 'DAY'],
  hour: [1, 'HOUR'],
  minute: [1, 'MINUTE'],
  second: [1, 'SECOND'],
};

/** Cube's ISO timestamp string (`2026-01-01T00:00:00.000Z`) as TDV reads one, cast. */
const timestampOf = (value: string) => `CAST(REPLACE(REPLACE(${value}, 'T', ' '), 'Z', '') AS TIMESTAMP)`;

class TdvFilter extends BaseFilter {
  public override likeIgnoreCase(column: string, not: boolean, param: unknown, type: string) {
    const p = (!type || type === 'contains' || type === 'ends') ? '\'%\' || ' : '';
    const s = (!type || type === 'contains' || type === 'starts') ? ' || \'%\'' : '';
    return `LOWER(${column})${not ? ' NOT' : ''} LIKE LOWER(${p}${this.allocateParam(param)}${s}) ESCAPE '\\'`;
  }
}

export class XcubeTdvQuery extends BaseQuery {
  public override newFilter(filter: any): BaseFilter {
    return new TdvFilter(this, filter);
  }

  public override convertTz(field: string) {
    const zone = this.timezone;
    if (!zone || zone === 'UTC' || zone === 'Etc/UTC') {
      return field;
    }
    if (!moment.tz.zone(zone) || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(zone)) {
      throw new UserError(`TDV converts to an IANA time zone, such as America/Los_Angeles, not ${JSON.stringify(zone)}`);
    }
    return `TZCONVERTOR(${field}, 'UTC', '${zone}')`;
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
      throw new UserError(`TDV has no ${granularity} granularity here: second, minute, hour, day, week, month, quarter or year`);
    }
    return truncate(dimension);
  }

  public override subtractInterval(date: string, interval: string) {
    return this.applyInterval(-1, date, interval);
  }

  public override addInterval(date: string, interval: string) {
    return this.applyInterval(1, date, interval);
  }

  protected applyInterval(sign: 1 | -1, date: string, interval: string): string {
    return splitSqlInterval(interval).reduce((acc, part) => {
      const [n, unit] = this.parseInterval(part);
      const found = UNITS[String(unit).toLowerCase().replace(/s$/, '')];
      if (!found) {
        throw new UserError(`TDV has no interval of ${unit} here`);
      }
      return `TIMESTAMPADD(${found[1]}, ${sign * Number(n) * found[0]}, ${acc})`;
    }, date);
  }

  /** A limit as TOP where there is no offset; with one, OFFSET … FETCH NEXT (`groupByDimensionLimit`). */
  public override topLimit() {
    return this.rowLimit === null || this.offset ? '' : ` TOP ${this.parsedRowLimit() ?? 10000} `;
  }

  public override groupByDimensionLimit() {
    if (!this.offset) {
      return '';
    }
    const limit = this.rowLimit === null ? '' : ` FETCH NEXT ${this.parsedRowLimit() ?? 10000} ROWS ONLY`;
    return ` OFFSET ${parseInt(this.offset, 10)} ROWS${limit}`;
  }

  public override castToString(sql: string) {
    return `CAST(${sql} AS VARCHAR(4000))`;
  }

  public override defaultRefreshKeyRenewalThreshold() {
    return 120;
  }

  public override seriesSql(timeDimension: any) {
    const values = timeDimension.timeSeries().map(
      ([from, to]: [string, string]) => `SELECT '${from.replace('T', ' ')}' AS f, '${to.replace('T', ' ')}' AS t`,
    ).join(' UNION ALL ');
    return `SELECT CAST(dates.f AS TIMESTAMP) AS "date_from", CAST(dates.t AS TIMESTAMP) AS "date_to" FROM (${values}) AS dates`;
  }

  public override sqlTemplates() {
    const templates = super.sqlTemplates();
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
      + '{% if order_by %}\nORDER BY {{ order_by | map(attribute=\'expr\') | join(\', \') }}{% endif %}'
      + '{% if offset is not none %}\nOFFSET {{ offset }} ROWS{% if limit is not none %}\nFETCH NEXT {{ limit }} ROWS ONLY{% endif %}{% endif %}';
    templates.statements.union = '{% if limit is not none %}SELECT TOP {{ limit }} * FROM (\n{% endif %}'
      + '{% for query in queries %}(\n'
      + '{{ query | indent(2, true) }}\n'
      + ')'
      + '{% if not loop.last %}\nUNION {% if not distinct %}ALL {% endif %}{% endif %}'
      + '{% endfor %}'
      + '{% if limit is not none %}\n) AS union_result{% endif %}';
    templates.statements.time_series_select = 'SELECT CAST(dates.f AS TIMESTAMP) AS "date_from",\n'
      + 'CAST(dates.t AS TIMESTAMP) AS "date_to"\n'
      + 'FROM (\n'
      + '{% for time_item in seria %}'
      + 'SELECT \'{{ time_item[0] | replace("T", " ") }}\' AS f, \'{{ time_item[1] | replace("T", " ") }}\' AS t'
      + '{% if not loop.last %} UNION ALL\n{% endif %}'
      + '{% endfor %}'
      + ') AS dates';
    templates.expressions.timestamp_literal = 'CAST(\'{{ value | replace("T", " ") | replace("Z", "") }}\' AS TIMESTAMP)';
    templates.tesseract.time_param_cast = timestampOf('{{ expr }}');
    templates.expressions.like = '{{ expr }} {% if negated %}NOT {% endif %}LIKE {{ pattern }}{% if default_escape %} ESCAPE \'\\\'{% endif %}';
    delete templates.expressions.ilike;
    templates.tesseract.ilike = 'LOWER({{ expr }}) {% if negated %}NOT {% endif %}LIKE LOWER({{ pattern }}) ESCAPE \'\\\'';
    delete templates.expressions.add_interval;
    delete templates.expressions.sub_interval;
    delete templates.functions.DATEDIFF;
    templates.types.string = 'VARCHAR(4000)';
    delete templates.types.interval;
    return templates;
  }
}
