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
 *
 * And it has zoneless time dimensions: one marked `meta: { wechart: { engine:
 * { zoneless: true } } }` holds a wall-clock value (a DATE, or a TIMESTAMP
 * with no zone), which keeps its day in a query with a `timezone`. Cube
 * takes a time dimension's value as UTC and converts it to the query's zone;
 * it has no per-member way not to. The marked member's SQL is read as the
 * instant at which the query's zone shows that value, so Cube's conversion
 * gives it back, and its date ranges, granularities and filters fall on its
 * own day, on both planners.
 */
import { CubejsServerCore } from '@cubejs-backend/server-core';

type DialectClass = new (...args: any[]) => any;

type DialectContext = { dataSource?: string; dbType?: string; [key: string]: unknown };

type DialectFactory = (context: DialectContext) => DialectClass | undefined | null;

let duckdbClass: DialectClass | undefined;

/** Whether a dimension's `meta` marks it zoneless (`meta.wechart.engine.zoneless`). */
export const isZoneless = (definition: any) => definition?.type === 'time' && definition?.meta?.wechart?.engine?.zoneless === true;

const zonelessSql = new WeakMap<object, WeakSet<object>>();

/**
 * The `sql` functions of a compiled model's zoneless dimensions: cubes' own,
 * never a view's, whose members read them through their cube.
 */
export function zonelessSqlOf(cubeEvaluator: any): WeakSet<object> {
  let found = zonelessSql.get(cubeEvaluator);
  if (!found) {
    found = new WeakSet();
    for (const cube of Object.values<any>(cubeEvaluator?.evaluatedCubes ?? {}).filter((c) => !c?.isView)) {
      for (const dimension of Object.values<any>(cube?.dimensions ?? {})) {
        if (isZoneless(dimension) && typeof dimension.sql === 'function') {
          found.add(dimension.sql);
        }
      }
    }
    zonelessSql.set(cubeEvaluator, found);
  }
  return found;
}

/** Cube's DuckDB dialect, with a time series derived from the data. */
export function xcubeDuckDBQuery(): DialectClass {
  if (!duckdbClass) {
    const Base = (CubejsServerCore.lookupDriverClass('duckdb') as any).dialectClass() as DialectClass;

    class XcubeDuckDBQuery extends Base {
      /**
       * A zoneless dimension's value, a wall-clock time (a DATE, or a
       * TIMESTAMP with no zone), as the instant at which the query's zone
       * reads it: Cube's conversion to that zone (`convertTz`) gives the value
       * back, and its date ranges and granularities fall on its own day.
       */
      public zonelessSql(sql: string): string {
        return `timezone('${this.timezone || 'UTC'}', CAST(${sql} AS TIMESTAMP))`;
      }

      /** The legacy planner's member SQL, a zoneless dimension's as an instant. */
      public autoPrefixAndEvaluateSql(cubeName: string, sql: any, isMemberExpr?: boolean) {
        const evaluated = super.autoPrefixAndEvaluateSql(cubeName, sql, isMemberExpr);
        return sql && zonelessSqlOf(this.cubeEvaluator).has(sql) ? this.zonelessSql(evaluated) : evaluated;
      }

      /** Tesseract's member SQL, compiled once for its query: a zoneless dimension's as an instant. */
      public compileMemberSql(sqlFn: any, securityContext: any, argNames: string[]) {
        const compiled = super.compileMemberSql(sqlFn, securityContext, argNames);
        if (sqlFn && zonelessSqlOf(this.cubeEvaluator).has(sqlFn) && typeof compiled.template === 'string') {
          return { ...compiled, template: this.zonelessSql(compiled.template) };
        }
        return compiled;
      }

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
