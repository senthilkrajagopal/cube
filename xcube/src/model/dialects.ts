/**
 * The SQL dialects xcube compiles with, where they differ from Cube's own
 * (`dialectFactory`).
 *
 * DuckDB's has a time series derived from the data: a rolling window or a
 * time shift with no date range is answered over the periods between the
 * data's first and last, as Cube does on Postgres, instead of Tesseract's
 * "Date range is required for time series". Cube's DuckDB dialect has neither
 * of the templates Tesseract builds one with. Only Tesseract plans this; the
 * legacy planner still needs a date range.
 */
import { CubejsServerCore } from '@cubejs-backend/server-core';

type DialectClass = new (...args: any[]) => any;

type DialectContext = { dataSource?: string; dbType?: string; [key: string]: unknown };

type DialectFactory = (context: DialectContext) => DialectClass | undefined | null;

let duckdbClass: DialectClass | undefined;

/** Cube's DuckDB dialect, with a time series derived from the data. */
export function xcubeDuckDBQuery(): DialectClass {
  if (!duckdbClass) {
    const Base = (CubejsServerCore.lookupDriverClass('duckdb') as any).dialectClass() as DialectClass;

    class XcubeDuckDBQuery extends Base {
      /**
       * Every series is a list of timestamps, unnested: DuckDB's
       * `generate_series` takes timestamps and an interval, as Postgres's does.
       * Each period ends a millisecond before the next starts, as Cube's
       * series do. The bounds are cast to TIMESTAMP, never TIMESTAMPTZ, so the
       * session's time zone never moves them.
       */
      public sqlTemplates() {
        const templates = super.sqlTemplates();
        templates.statements.generated_time_series_select = 'SELECT d AS "date_from",\n' +
          'd + {{ granularity }}::interval - interval \'1 millisecond\' AS "date_to"\n' +
          'FROM (SELECT unnest(generate_series({{ start }}::timestamp, {{ end }}::timestamp, {{ granularity }}::interval)) AS d) AS series';
        templates.statements.generated_time_series_with_cte_range_source = 'SELECT d AS "date_from",\n' +
          'd + {{ granularity }}::interval - interval \'1 millisecond\' AS "date_to"\n' +
          'FROM (SELECT unnest(generate_series({{ range_source }}.{{ min_name }}::timestamp, ' +
          '{{ range_source }}.{{ max_name }}::timestamp, {{ granularity }}::interval)) AS d FROM {{ range_source }}) AS series';
        return templates;
      }
    }
    duckdbClass = XcubeDuckDBQuery;
  }
  return duckdbClass;
}

/**
 * Cube's `dialectFactory`, with xcube's dialects: cube.js's own where it names
 * one, else xcube's for DuckDB, else the driver's, as Cube's default picks it.
 */
export function dialectFactory(given?: DialectFactory): DialectFactory {
  return (context) => {
    const chosen = given?.(context);
    if (chosen) {
      return chosen;
    }
    if (context.dbType === 'duckdb') {
      return xcubeDuckDBQuery();
    }
    const driverClass = CubejsServerCore.lookupDriverClass(context.dbType as any) as any;
    return driverClass?.dialectClass ? driverClass.dialectClass() : undefined;
  };
}
