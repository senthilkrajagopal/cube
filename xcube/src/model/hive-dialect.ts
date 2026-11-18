/**
 * The SQL dialect xcube compiles Hive and Spark data sources with: Cube's
 * `HiveQuery`, with what Tesseract (the planner) needs of it. Cube's own is
 * written for its legacy planner, and under Tesseract it compiles to SQL Hive
 * can't run: names in double quotes (strings, to Hive and Spark), ILIKE,
 * GROUP BY by column number (Hive groups by position only with
 * `hive.groupby.position.alias`), OFFSET without LIMIT, and no `quarter`.
 *
 * Every statement here runs on Hive 3.1 and 4.x and on Spark 3.4 and later
 * alike: no function only one of them has.
 */
import { HiveQuery } from '@cubejs-backend/schema-compiler/dist/src/adapter/HiveQuery';

/** A timestamp truncated to each granularity, as a TIMESTAMP (Cube's own returns a string). */
const TRUNCATED: Record<string, (d: string) => string> = {
  second: (d) => `CAST(DATE_FORMAT(${d}, 'yyyy-MM-dd HH:mm:ss') AS TIMESTAMP)`,
  minute: (d) => `CAST(DATE_FORMAT(${d}, 'yyyy-MM-dd HH:mm:00') AS TIMESTAMP)`,
  hour: (d) => `CAST(DATE_FORMAT(${d}, 'yyyy-MM-dd HH:00:00') AS TIMESTAMP)`,
  day: (d) => `CAST(TO_DATE(${d}) AS TIMESTAMP)`,
  // Monday's: 1900-01-01 was one. Counted in days, never through a zone.
  week: (d) => `CAST(DATE_SUB(TO_DATE(${d}), PMOD(DATEDIFF(TO_DATE(${d}), '1900-01-01'), 7)) AS TIMESTAMP)`,
  month: (d) => `CAST(DATE_FORMAT(${d}, 'yyyy-MM-01') AS TIMESTAMP)`,
  quarter: (d) => `CAST(CONCAT(CAST(YEAR(${d}) AS STRING), '-', LPAD(CAST((QUARTER(${d}) - 1) * 3 + 1 AS STRING), 2, '0'), '-01') AS TIMESTAMP)`,
  year: (d) => `CAST(DATE_FORMAT(${d}, 'yyyy-01-01') AS TIMESTAMP)`,
};

export class XcubeHiveQuery extends HiveQuery {
  public override timeGroupedColumn(granularity: string, dimension: string) {
    const truncate = TRUNCATED[granularity];
    if (!truncate) {
      throw new Error(`Hive has no ${granularity} granularity here: second, minute, hour, day, week, month, quarter or year`);
    }
    return truncate(dimension);
  }

  public override sqlTemplates() {
    const templates = super.sqlTemplates();
    templates.quotes.identifiers = '`';
    templates.quotes.escape = '``';
    // By expression: a position is a constant to Hive.
    templates.statements.group_by_exprs = '{{ group_by | map(attribute=\'expr\') | join(\', \') }}';
    // OFFSET only after a LIMIT; its own at most 2^31 - 1 less the offset: Hive answers no rows where the two add past it.
    const limits = '{% if limit is not none %}\nLIMIT {{ limit }}{% endif %}{% if offset is not none %}\nOFFSET {{ offset }}{% endif %}';
    if (!templates.statements.select.includes(limits)) {
      throw new Error('Cube\'s select template has changed: XcubeHiveQuery\'s LIMIT and OFFSET need writing again');
    }
    templates.statements.select = templates.statements.select.replace(
      limits,
      '{% if limit is not none %}\nLIMIT {{ limit }}{% elif offset is not none %}\nLIMIT {% if offset is number %}{{ 2147483647 - offset }}{% else %}1000000000{% endif %}{% endif %}'
        + '{% if offset is not none %}\nOFFSET {{ offset }}{% endif %}',
    );
    // No ILIKE on Hive, and no ESCAPE clause: a backslash escapes in LIKE on both.
    //
    // Hive 4's vectorized LIKE reads a backslash-escaped % or _ in a constant pattern wrongly, matching
    // nothing (`name LIKE '%\\%%'` finds no `50%`): Cube escapes a filter's value so. A pattern that
    // depends on the row isn't vectorized, and is read rightly: an empty `SUBSTR` of the value is added.
    const rowBound = (expr: string) => `SUBSTR(CAST(${expr} AS STRING), 1, 0)`;
    templates.expressions.like = `{{ expr }} {% if negated %}NOT {% endif %}LIKE CONCAT({{ pattern }}, ${rowBound('{{ expr }}')})`;
    templates.expressions.ilike = `LOWER({{ expr }}) {% if negated %}NOT {% endif %}LIKE CONCAT(LOWER({{ pattern }}), ${rowBound('{{ expr }}')})`;
    templates.tesseract.ilike = `LOWER({{ expr }}) {% if negated %}NOT {% endif %}LIKE CONCAT({{ pattern }}, ${rowBound('{{ expr }}')})`;
    delete templates.expressions.like_escape;
    templates.filters.like_pattern = 'CONCAT({% if start_wild %}\'%\'{% else %}\'\'{% endif %}, LOWER({{ value }}), {% if end_wild %}\'%\'{% else %}\'\'{% endif %})';
    templates.statements.time_series_select = 'SELECT CAST(dates.f AS TIMESTAMP) AS `date_from`, CAST(dates.t AS TIMESTAMP) AS `date_to`\n'
      + 'FROM (\n'
      + '{% for time_item in seria %}'
      + '  SELECT \'{{ time_item[0] | replace("T", " ") }}\' AS f, \'{{ time_item[1] | replace("T", " ") }}\' AS t\n'
      + '{% if not loop.last %}  UNION ALL\n{% endif %}'
      + '{% endfor %}'
      + ') AS dates';
    templates.expressions.timestamp_literal = 'CAST(\'{{ value | replace("T", " ") | replace("Z", "") }}\' AS TIMESTAMP)';
    templates.types.integer = 'INT';
    return templates;
  }
}
