/**
 * Row-sets (`POST /v1/row-set`): a query's rows before Cube aggregates them,
 * as SQL for the query's data source to run, so that wechart's engine can
 * compute over them what Cube can't (its Spotfire stages), with Cube still
 * the only one to evaluate access policies.
 *
 * A row-set is the query's join, ungrouped: one row per joined row, with no
 * ORDER BY and no LIMIT. Its columns are the query's dimensions and time
 * dimensions, the primary keys of every cube it joins (`keys`), and each
 * measure's inputs: the raw value each leaf measure aggregates (a sum's
 * column, a count's primary key, a filtered measure's value where its
 * filter holds). Each requested measure comes with its aggregate over them
 * (`measures`). It is answered twice when access policies filter its rows:
 * `policyRowSet` with the policies alone, `rowSet` with the query's own
 * filters too, over the same columns.
 *
 * Cube's ungrouped queries render a count or a count_distinct as `1` where
 * a value is (`CASE WHEN … IS NOT NULL THEN 1 END`), which no aggregate can
 * read a distinct count from; so a row-set is built with Cube's legacy
 * planner in a subclass of the data source's own dialect that renders each
 * measure's value itself (`rowSetDialect`).
 */
import { UserError } from '@cubejs-backend/schema-compiler';

/** A request Cube can't answer as a row-set: 400, with the reason. */
export class RowSetError extends Error {
  public constructor(message: string, public readonly code = 'invalid_row_set', public readonly refusals?: { member: string; reason: string }[]) {
    super(message);
    this.name = 'RowSetError';
  }
}

/** What a row-set's query can't hold: its rows have no order or page, and the planner makes them ungrouped. */
const REFUSED_FIELDS: Record<string, string> = {
  limit: 'a row-set has every row: no limit',
  offset: 'a row-set has every row: no offset',
  order: 'a row-set\'s rows have no order',
  total: 'a row-set has no total',
  ungrouped: 'a row-set is always ungrouped',
  calculations: 'quick calculations are computed by Cube, not over a row-set',
  responseFormat: 'a row-set is SQL, not rows',
};

/** The query of a row-set request, checked. */
export function rowSetQuery(input: unknown): Record<string, any> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RowSetError('query must be one query object');
  }
  const query = input as Record<string, any>;
  const refused = Object.keys(REFUSED_FIELDS).filter((key) => query[key] !== undefined);
  if (refused.length) {
    throw new RowSetError(refused.map((key) => `${key}: ${REFUSED_FIELDS[key]}`).join('; '));
  }
  for (const td of query.timeDimensions ?? []) {
    if (td && typeof td === 'object' && td.compareDateRange !== undefined) {
      throw new RowSetError('compareDateRange: a row-set has one date range');
    }
  }
  return query;
}

/** What a measure must not be, for an aggregate over a row-set's columns to be Cube's: its reason, or null. */
export function unsupportedMeasure(definition: any): string | null {
  if (!definition) {
    return null;
  }
  if (definition.multiStage) {
    return 'a multi-stage measure is computed over Cube\'s own stages, not over rows';
  }
  if (definition.rollingWindow) {
    return 'a rolling window is computed over a time series, not over rows';
  }
  switch (definition.type) {
    case 'runningTotal':
      return 'a running total is computed over a time series, not over rows';
    case 'countDistinctApprox':
      return 'count_distinct_approx\'s sketches aren\'t taken from rows';
    case 'rank':
      return 'a rank is a window over Cube\'s own result';
    default:
      return null;
  }
}

/**
 * Measure types whose own SQL is the aggregate: one of them that reads no
 * other measure (a leaf) has no value per row to put in a row-set, only
 * its aggregate, which an ungrouped select can't hold.
 */
const SELF_AGGREGATING = ['number', 'numberAgg', 'string', 'time', 'boolean'];

/** Why a leaf measure can't be taken apart into rows: its reason, or null. */
export function selfAggregating(definition: any): string | null {
  if (!definition || !SELF_AGGREGATING.includes(definition.type)) {
    return null;
  }
  return `a measure of type ${definition.type} that reads no other measure aggregates in its own SQL, which has no value per row`;
}

const dialects = new WeakMap<object, any>();

/**
 * The data source's dialect, rendering each measure of an ungrouped query as
 * the value it aggregates (a count's primary key or its own `sql`, a
 * filtered measure's value where the filter holds), never Cube's `1`.
 */
export function rowSetDialect(Base: any): any {
  let RowSet = dialects.get(Base);
  if (!RowSet) {
    RowSet = class extends Base {
      public renderSqlMeasure(name: string, evaluateSql: string, symbol: any, cubeName: string, parentMeasure: string | undefined, orderBySql: any) {
        if (this.ungrouped && this.options.xcubeRowSet && !this.safeEvaluateSymbolContext().renderedReference) {
          return evaluateSql === '*' ? '1' : evaluateSql;
        }
        return super.renderSqlMeasure(name, evaluateSql, symbol, cubeName, parentMeasure, orderBySql);
      }
    };
    dialects.set(Base, RowSet);
  }
  return RowSet;
}

/** A member as the query names it: a view's own where a view of the query exposes the cube's member, else the cube's. */
export function viewMemberFor(evaluator: any, views: string[], type: 'measures' | 'dimensions', cubeMember: string): string {
  for (const view of views) {
    const members = evaluator.evaluatedCubes?.[view]?.[type] ?? {};
    for (const [name, definition] of Object.entries<any>(members)) {
      if (definition?.aliasMember === cubeMember) {
        return `${view}.${name}`;
      }
    }
  }
  return cubeMember;
}

/** The definition a member's path names, through the views that alias it. */
export function definitionOf(evaluator: any, type: 'measures' | 'dimensions', path: string): any {
  let definition: any;
  let at = path;
  for (let i = 0; i < 8; i++) {
    definition = type === 'measures' ? evaluator.measureByPath(at) : evaluator.dimensionByPath(at);
    if (!definition?.aliasMember) {
      return definition;
    }
    at = definition.aliasMember;
  }
  return definition;
}

/** Each cube a legacy query joins, the root first. */
export function joinedCubes(query: any): string[] {
  const { join } = query;
  if (!join) {
    return [];
  }
  return [...new Set<string>([join.root, ...join.joins.map((j: any) => j.originalTo)])];
}

/** The primary keys of each cube a query joins, as member paths: refused for a cube that has none. */
export function keysOf(query: any, cubes: string[]): Record<string, string[]> {
  const keys: Record<string, string[]> = {};
  for (const cube of cubes) {
    try {
      keys[cube] = query.primaryKeyNames(cube);
    } catch (e) {
      if (e instanceof UserError) {
        throw new RowSetError(`Cube ${cube} has no primary key: a row-set holds the keys of every cube it joins`, 'no_primary_key');
      }
      throw e;
    }
  }
  return keys;
}

/** A measure of the query, as an aggregate over its row-set's columns. */
export interface RowSetMeasure {
  /** The aggregate over the row-set's columns: Cube's, where none of its leaves is `multiplied`. */
  sql: string;
  /** The measure over its leaves' aggregates, each as a column named by its leaf's alias. */
  overLeaves: string;
  /** Whether a leaf's rows repeat in the row-set (a join fans them out), so its aggregate must count each key once. */
  multiplied: boolean;
  /** The aliases of the keys a multiplied leaf's rows are told apart by. */
  key?: string[];
  leaves: {
    member: string;
    alias: string;
    /** Its aggregate over its row-set column. */
    sql: string;
    multiplied: boolean;
    key?: string[];
  }[];
}

/**
 * The measures of a grouped legacy query (the query as Cube answers it,
 * policies on), each as an aggregate over the row-set's columns: `aliasOf`
 * names each leaf's column, `keyAliases` each cube's key columns.
 */
export function measuresOver(
  grouped: any,
  measures: string[],
  leavesOf: Record<string, string[]>,
  aliasOf: (leaf: string) => string,
  keyAliases: Record<string, string[]>,
): Record<string, RowSetMeasure> {
  const quoted = (alias: string) => grouped.escapeColumnName(alias);
  const result: Record<string, RowSetMeasure> = {};
  for (const measure of measures) {
    const leaves = leavesOf[measure].map((leaf) => {
      const cube = leaf.split('.')[0];
      const definition = definitionOf(grouped.cubeEvaluator, 'measures', leaf);
      // Repeated rows change a sum, an avg or a count of values, never a min, a max or a
      // distinct count; a count of rows reads its cube's key, distinct where rows repeat.
      const multiplied = Boolean(grouped.multipliedJoinRowResult(cube))
        && !['countDistinct', 'min', 'max'].includes(definition?.type)
        && !(definition?.type === 'count' && !definition?.sql);
      const sql = grouped.evaluateSymbolSqlWithContext(
        () => grouped.newMeasure(leaf).measureSql(),
        { ungroupedAliases: { [leaf]: quoted(aliasOf(leaf)) } },
      );
      return { member: leaf, alias: aliasOf(leaf), sql, multiplied, ...(multiplied ? { key: keyAliases[cube] } : {}) };
    });
    const sql = grouped.evaluateSymbolSqlWithContext(
      () => grouped.newMeasure(measure).measureSql(),
      { ungroupedAliases: Object.fromEntries(leaves.map((l) => [l.member, quoted(l.alias)])) },
    );
    const overLeaves = grouped.evaluateSymbolSqlWithContext(
      () => grouped.newMeasure(measure).measureSql(),
      { renderedReference: Object.fromEntries(leaves.map((l) => [l.member, quoted(l.alias)])) },
    );
    const multiplied = leaves.some((l) => l.multiplied);
    const key = [...new Set(leaves.flatMap((l) => l.key ?? []))];
    result[measure] = { sql, overLeaves, multiplied, ...(multiplied ? { key } : {}), leaves };
  }
  return result;
}
