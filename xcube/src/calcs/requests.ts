import type { SnapshotFile } from '../model/snapshot';
import {
  CALC_GRANULARITIES, CALC_KINDS, companionName, measureOf, modelOf, MOVING_AVERAGE_PERIODS, PERIOD_KINDS, refusalOf,
  type CalcKind, type CalcSpec,
} from './companions';

/** Why a calculation can't be computed for a query. */
export type CalcRefusalReason = 'kind' | 'not_in_query' | 'duplicate' | 'unknown_measure' | 'type' | 'granularity' | 'periods' | 'combination' | 'compile';

export interface CalcRefusal {
  measure: string | null;
  kind: string | null;
  reason: CalcRefusalReason;
  message: string;
}

/** A query's calculations that can't be computed, each with its reason: answered `400`. */
export class CalculationError extends Error {
  public constructor(public readonly refusals: CalcRefusal[]) {
    super(`Calculations can't be computed: ${refusals.map((r) => `${r.measure ?? '?'} ${r.kind ?? '?'}: ${r.message}`).join('; ')}`);
  }
}

/** A query's calculations, planned: the companions it needs, and the query asking for them in place of their measures. */
export interface CalcPlan {
  specs: CalcSpec[];
  query: any;
  /** Each calculation's column in the answer: the member standing for it. */
  columns: { measure: string; kind: CalcKind; member: string }[];
}

type Model = ReturnType<typeof modelOf>;

/** The cube measure a query's member is, directly or through a view: and the name the view gives it. */
export function baseOf(model: Model, member: string): { cube: string; measure: string; owner: string; shown: string } | undefined {
  const dot = member.indexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const owner = member.slice(0, dot);
  const name = member.slice(dot + 1);
  if (model.cubes.has(owner)) {
    return measureOf(model.cubes, owner, name) ? { cube: owner, measure: name, owner, shown: name } : undefined;
  }
  const view = model.views.get(owner);
  for (const entry of Array.isArray(view?.cubes) ? view.cubes : []) {
    const cube = String(entry?.join_path ?? entry?.joinPath ?? '').split('.').pop() ?? '';
    const prefix = entry?.prefix ? `${entry.alias ?? cube}_` : '';
    if (name.startsWith(prefix)) {
      const bare = name.slice(prefix.length);
      const excludes: unknown[] = Array.isArray(entry.excludes) ? entry.excludes : [];
      if (entry.includes === '*' && !excludes.includes(bare) && measureOf(model.cubes, cube, bare)) {
        return { cube, measure: bare, owner, shown: name };
      }
      for (const include of Array.isArray(entry.includes) ? entry.includes : []) {
        const source = typeof include === 'string' ? include : include?.name;
        const shownAs = typeof include === 'string' ? include : include?.alias ?? include?.name;
        if (shownAs === bare && typeof source === 'string' && measureOf(model.cubes, cube, source)) {
          return { cube, measure: source, owner, shown: name };
        }
      }
    }
  }
  return undefined;
}

/** A query's time dimensions at a granularity. */
function granularOf(query: any): any[] {
  return (Array.isArray(query?.timeDimensions) ? query.timeDimensions : []).filter((td: any) => td && typeof td.granularity === 'string');
}

/**
 * Plans a query's `calculations` over a revision's files as published: each
 * must name a measure of the query, once, of a type its calculation is
 * correct for, and a period calculation needs one time dimension at a
 * granularity. The planned query asks for the companions in place of the
 * measures (in `measures` and `order`); a running total also filters on its
 * range, so that it counts from the range's start.
 */
export function planCalculations(query: any, files: SnapshotFile[]): CalcPlan {
  const asked: any[] = query.calculations;
  const refusals: CalcRefusal[] = [];
  const refuse = (measure: unknown, kind: unknown, reason: CalcRefusalReason, message: string) => {
    refusals.push({ measure: typeof measure === 'string' ? measure : null, kind: typeof kind === 'string' ? kind : null, reason, message });
  };
  if (!Array.isArray(asked)) {
    throw new CalculationError([{ measure: null, kind: null, reason: 'kind', message: 'calculations is a list of { measure, kind }' }]);
  }
  const model = modelOf(files);
  const measures: unknown[] = Array.isArray(query.measures) ? query.measures : [];
  const granular = granularOf(query);
  const seen = new Set<string>();
  const specs: CalcSpec[] = [];
  const replaced = new Map<string, string>();
  const columns: CalcPlan['columns'] = [];
  let runningTotal = false;

  for (const calc of asked) {
    const { measure, kind } = calc ?? {};
    if (!CALC_KINDS.includes(kind)) {
      refuse(measure, kind, 'kind', `unknown calculation; one of ${CALC_KINDS.join(', ')}`);
    } else if (typeof measure !== 'string' || !measures.includes(measure)) {
      refuse(measure, kind, 'not_in_query', 'a calculation takes a measure of the query\'s measures');
    } else if (seen.has(measure)) {
      refuse(measure, kind, 'duplicate', 'one calculation per measure');
    } else {
      seen.add(measure);
      const base = baseOf(model, measure);
      const definition = base && measureOf(model.cubes, base.cube, base.measure);
      const typeRefusal = definition ? refusalOf(kind, definition) : undefined;
      const periods = kind === 'moving_average' ? calc.periods : 0;
      const granularity = PERIOD_KINDS.has(kind) && granular.length === 1 ? granular[0].granularity : '';
      if (!base || !definition) {
        refuse(measure, kind, 'unknown_measure', 'no such measure in the model');
      } else if (typeRefusal) {
        refuse(measure, kind, 'type', typeRefusal);
      } else if (PERIOD_KINDS.has(kind) && granular.length !== 1) {
        refuse(measure, kind, 'granularity', granular.length
          ? 'the query has more than one time dimension at a granularity'
          : 'the query needs a time dimension with a granularity');
      } else if (PERIOD_KINDS.has(kind) && !CALC_GRANULARITIES.includes(granularity)) {
        refuse(measure, kind, 'granularity', `the granularity is one of ${CALC_GRANULARITIES.join(', ')}`);
      } else if (kind === 'moving_average' && !MOVING_AVERAGE_PERIODS.includes(periods)) {
        refuse(measure, kind, 'periods', `a moving average takes periods ${MOVING_AVERAGE_PERIODS.join(', ')}`);
      } else {
        const spec: CalcSpec = { cube: base.cube, measure: base.measure, kind, granularity, periods };
        const companion = companionName(spec);
        const member = `${base.owner}.${base.shown}${companion.slice(base.measure.length)}`;
        specs.push(spec);
        replaced.set(measure, member);
        columns.push({ measure, kind, member });
        runningTotal = runningTotal || kind === 'running_total';
      }
    }
  }
  // A running total's range filter would also cut the other period calculations' earlier periods.
  const range = granular[0]?.dateRange;
  if (runningTotal && range !== undefined) {
    specs.filter((s) => s.kind !== 'running_total' && PERIOD_KINDS.has(s.kind)).forEach((s) => {
      const column = columns.find((c) => c.kind === s.kind);
      refuse(column?.measure, s.kind, 'combination', 'a running total over a range can\'t share its query with another period calculation: ask for it in a query of its own');
    });
  }
  if (refusals.length) {
    throw new CalculationError(refusals);
  }

  const { calculations: _calculations, ...rest } = query;
  const planned: any = { ...rest, measures: measures.map((m) => (typeof m === 'string' ? replaced.get(m) ?? m : m)) };
  if (Array.isArray(query.order)) {
    planned.order = query.order.map((o: any) => (Array.isArray(o) && replaced.has(o[0]) ? [replaced.get(o[0]), o[1]] : o));
  } else if (query.order && typeof query.order === 'object') {
    planned.order = Object.fromEntries(Object.entries(query.order).map(([member, dir]) => [replaced.get(member) ?? member, dir]));
  }
  // A running total counts from the range's start: the range also as a filter, which the window keeps.
  if (runningTotal && range !== undefined) {
    planned.filters = [
      ...(Array.isArray(query.filters) ? query.filters : []),
      { member: granular[0].dimension, operator: 'inDateRange', values: Array.isArray(range) ? range : [range] },
    ];
  }
  return { specs, query: planned, columns };
}
