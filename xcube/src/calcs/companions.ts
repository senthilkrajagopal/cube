import crypto from 'crypto';
import yaml from 'js-yaml';

import type { SnapshotFile } from '../model/snapshot';

/**
 * Quick calculations: multi-stage companion measures of a measure, which
 * xcube adds to a cube when it serves the model, never to what is published.
 * A query asks for one by its calculation (`calculations`); the companion's
 * name is the measure's, marked, with the calculation.
 */
export const CALC_KINDS = ['pct_of_total', 'previous_period', 'difference', 'pct_difference', 'running_total', 'moving_average', 'rank'] as const;

export type CalcKind = (typeof CALC_KINDS)[number];

/** The time granularities a period calculation takes: a time shift and a window are a fixed interval of one. */
export const CALC_GRANULARITIES = ['hour', 'day', 'week', 'month', 'quarter', 'year'];

export const MOVING_AVERAGE_PERIODS = [3, 6, 12];

/** Marks a companion's name; no authored member may carry it. */
export const COMPANION_MARK = '__xc_';

/** A companion a model is served with: for a calculation of a measure of a cube (`''` and `0` where it takes none). */
export interface CalcSpec {
  cube: string;
  measure: string;
  kind: CalcKind;
  granularity: string;
  periods: number;
}

/** The calculations that need the query's time dimension at a granularity. */
export const PERIOD_KINDS = new Set<CalcKind>(['previous_period', 'difference', 'pct_difference', 'running_total', 'moving_average']);

const ANY = ['count', 'sum', 'avg', 'min', 'max', 'count_distinct', 'count_distinct_approx', 'number'];
const COUNTS = ['count', 'sum', 'count_distinct', 'count_distinct_approx'];

/**
 * The measure types each calculation is correct for, as Tesseract computes
 * it: a share of an average or a ratio isn't one, and a running total or a
 * moving average of one mixes its periods' values.
 */
export const CALC_TYPES: Record<CalcKind, readonly string[]> = {
  pct_of_total: COUNTS,
  previous_period: ANY,
  difference: ANY,
  pct_difference: ANY,
  running_total: COUNTS,
  moving_average: COUNTS,
  rank: ANY,
};

export function companionName(spec: Pick<CalcSpec, 'measure' | 'kind' | 'granularity' | 'periods'>): string {
  const { measure, granularity: g, periods: n } = spec;
  const suffix = {
    pct_of_total: 'pct_of_total',
    previous_period: `prev_${g}`,
    difference: `diff_${g}`,
    pct_difference: `pdiff_${g}`,
    running_total: 'running_total',
    moving_average: `ma${n}_${g}`,
    rank: 'rank',
  }[spec.kind];
  return `${measure}${COMPANION_MARK}${suffix}`;
}

/** A spec's identity, the same on every instance. */
export function specKey(spec: CalcSpec): string {
  return [spec.cube, spec.measure, spec.kind, spec.granularity, spec.periods].join('\u0000');
}

/** A set of specs' version: what a served revision's key names. */
export function calcVersion(specs: CalcSpec[]): string | undefined {
  if (!specs.length) {
    return undefined;
  }
  const keys = specs.map(specKey).sort();
  return crypto.createHash('sha256').update(keys.join('\n'), 'utf8').digest('hex').slice(0, 12);
}

function label(spec: CalcSpec): string {
  const g = spec.granularity;
  return {
    pct_of_total: '% of total',
    previous_period: `previous ${g}`,
    difference: `difference from previous ${g}`,
    pct_difference: `% difference from previous ${g}`,
    running_total: 'running total',
    moving_average: `${spec.periods}-${g} moving average`,
    rank: 'rank',
  }[spec.kind];
}

function titleOf(base: any): string {
  if (typeof base.title === 'string') {
    return base.title;
  }
  return String(base.name).split('_').filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** The companion members a spec adds to its cube: the one asked for, and any it is built on. */
export function companionsOf(spec: CalcSpec, base: any): Record<string, any>[] {
  const m = spec.measure;
  const name = companionName(spec);
  const own = {
    name,
    title: `${titleOf(base)} (${label(spec)})`,
    meta: {
      xcube: {
        calculation: {
          measure: m,
          kind: spec.kind,
          ...(spec.granularity ? { granularity: spec.granularity } : {}),
          ...(spec.periods ? { periods: spec.periods } : {}),
        },
      },
    },
  };
  const prev = companionName({ ...spec, kind: 'previous_period' });
  const previous = {
    name: prev,
    title: `${titleOf(base)} (previous ${spec.granularity})`,
    multi_stage: true,
    sql: `{${m}}`,
    type: 'number',
    time_shift: [{ interval: `1 ${spec.granularity}`, type: 'prior' }],
  };
  switch (spec.kind) {
    case 'pct_of_total': {
      const total = `${m}${COMPANION_MARK}total`;
      return [
        { name: total, multi_stage: true, sql: `{${m}}`, type: 'sum', grain: { keep_only: [] } },
        { ...own, multi_stage: true, sql: `1.0 * {${m}} / NULLIF({${total}}, 0)`, type: 'number', format: 'percent' },
      ];
    }
    case 'previous_period':
      return [{ ...previous, ...own }];
    case 'difference':
      return [previous, { ...own, multi_stage: true, sql: `{${m}} - {${prev}}`, type: 'number' }];
    case 'pct_difference':
      return [previous, { ...own, multi_stage: true, sql: `1.0 * ({${m}} - {${prev}}) / NULLIF({${prev}}, 0)`, type: 'number', format: 'percent' }];
    case 'running_total':
      // A distinct count so far is counted over the rows so far (a sum of the periods' would count
      // one twice); a count or a sum adds up its periods', so that a rollup can serve it.
      return base.type === 'count_distinct' || base.type === 'count_distinct_approx'
        ? [{
          ...own,
          type: base.type,
          ...(base.sql !== undefined ? { sql: base.sql } : {}),
          ...(base.filters !== undefined ? { filters: base.filters } : {}),
          rolling_window: { trailing: 'unbounded' },
        }]
        : [{ ...own, multi_stage: true, sql: `{${m}}`, type: 'sum', rolling_window: { trailing: 'unbounded' } }];
    case 'moving_average':
      return [{ ...own, multi_stage: true, sql: `{${m}}`, type: 'avg', rolling_window: { trailing: `${spec.periods} ${spec.granularity}` } }];
    case 'rank':
      return [{ ...own, multi_stage: true, type: 'rank', order_by: [{ sql: `{${m}}`, dir: 'desc' }], grain: { keep_only: [] } }];
    default:
      return [];
  }
}

/** Each YAML file's document, where it holds cubes or views. */
function documents(files: SnapshotFile[]): { file: SnapshotFile; doc: any }[] {
  return files.map((file) => {
    if (!/\.ya?ml$/.test(file.path)) {
      return { file, doc: undefined };
    }
    try {
      const doc = yaml.load(file.content) as any;
      return { file, doc: doc && typeof doc === 'object' && (Array.isArray(doc.cubes) || Array.isArray(doc.views)) ? doc : undefined };
    } catch {
      return { file, doc: undefined };
    }
  });
}

/** A cube's measure, its own or inherited through `extends`, as authored. */
export function measureOf(cubes: Map<string, any>, cube: string, measure: string): any | undefined {
  const seen = new Set<string>();
  for (let at = cubes.get(cube); at && !seen.has(at.name);) {
    seen.add(at.name);
    const found = (Array.isArray(at.measures) ? at.measures : []).find((m: any) => m && m.name === measure);
    if (found) {
      return found;
    }
    at = typeof at.extends === 'string' ? cubes.get(at.extends.trim()) : undefined;
  }
  return undefined;
}

/** The cubes and views of files, by name. */
export function modelOf(files: SnapshotFile[]): { cubes: Map<string, any>; views: Map<string, any> } {
  const cubes = new Map<string, any>();
  const views = new Map<string, any>();
  documents(files).forEach(({ doc }) => {
    (doc?.cubes ?? []).forEach((c: any) => c && typeof c.name === 'string' && cubes.set(c.name, c));
    (doc?.views ?? []).forEach((v: any) => v && typeof v.name === 'string' && views.set(v.name, v));
  });
  return { cubes, views };
}

/** Why a measure can't take a calculation, if it can't: its type, or its being a calculation already. */
export function refusalOf(kind: CalcKind, base: any): string | undefined {
  if (base.multi_stage || base.multiStage || base.rolling_window || base.rollingWindow) {
    return 'it is a multi-stage or rolling measure itself';
  }
  const type = String(base.type ?? 'number');
  const article = /^[aeiou]/.test(type) ? 'an' : 'a';
  return CALC_TYPES[kind].includes(type) ? undefined : `${article} ${type} measure has no correct ${kind.replace(/_/g, ' ')}`;
}

/** Adds companions to the names in an explicit member list that holds their measure. */
function withCompanionNames(list: unknown, added: Map<string, string[]>): unknown {
  if (!Array.isArray(list)) {
    return list;
  }
  const extra = list.flatMap((entry) => (typeof entry === 'string' ? added.get(entry) ?? [] : []));
  return extra.length ? [...list, ...extra.filter((name) => !list.includes(name))] : list;
}

/**
 * A revision's files with the companions of `specs` added: to each cube, and
 * to each list naming its measure explicitly (its access policies' member
 * lists; a view's includes and excludes). Returns, by path, the salt of each
 * file changed, for its module's app id.
 */
export function withCompanions(files: SnapshotFile[], specs: CalcSpec[]): { files: SnapshotFile[]; salts: Map<string, string> } {
  const salts = new Map<string, string>();
  if (!specs.length) {
    return { files, salts };
  }
  const parsed = documents(files);
  const { cubes } = modelOf(files);
  // Each cube's companions, and each measure's companion names.
  const byCube = new Map<string, { members: Record<string, any>[]; names: Map<string, string[]> }>();
  for (const spec of specs) {
    const base = measureOf(cubes, spec.cube, spec.measure);
    if (base && !refusalOf(spec.kind, base) && (!PERIOD_KINDS.has(spec.kind) || CALC_GRANULARITIES.includes(spec.granularity))) {
      const entry = byCube.get(spec.cube) ?? { members: [] as Record<string, any>[], names: new Map<string, string[]>() };
      for (const member of companionsOf(spec, base)) {
        if (!entry.members.some((m) => m.name === member.name)) {
          entry.members.push(member);
          entry.names.set(spec.measure, [...(entry.names.get(spec.measure) ?? []), member.name]);
        }
      }
      byCube.set(spec.cube, entry);
    }
  }
  if (!byCube.size) {
    return { files, salts };
  }
  const served = parsed.map(({ file, doc }) => {
    if (!doc) {
      return file;
    }
    const added: string[] = [];
    for (const cube of doc.cubes ?? []) {
      const entry = cube && byCube.get(cube.name);
      if (entry) {
        const authored = new Set((Array.isArray(cube.measures) ? cube.measures : []).map((m: any) => m?.name));
        const fresh = entry.members.filter((m) => !authored.has(m.name));
        cube.measures = [...(Array.isArray(cube.measures) ? cube.measures : []), ...fresh];
        for (const policies of [cube.access_policy, cube.accessPolicy]) {
          (Array.isArray(policies) ? policies : []).forEach((policy: any) => {
            const level = policy?.member_level ?? policy?.memberLevel;
            if (level && typeof level === 'object') {
              level.includes = withCompanionNames(level.includes, entry.names);
              level.excludes = withCompanionNames(level.excludes, entry.names);
            }
          });
        }
        added.push(...fresh.map((m) => `${cube.name}.${m.name}`));
      }
    }
    for (const view of doc.views ?? []) {
      for (const include of Array.isArray(view?.cubes) ? view.cubes : []) {
        const path = String(include?.join_path ?? include?.joinPath ?? '');
        const entry = byCube.get(path.split('.').pop() ?? '');
        if (entry) {
          if (Array.isArray(include.includes)) {
            const extra = include.includes.flatMap((i: any) => {
              if (typeof i === 'string') {
                return entry.names.get(i) ?? [];
              }
              const names = entry.names.get(i?.name) ?? [];
              return names.map((name) => (i.alias ? { name, alias: `${i.alias}${name.slice(i.name.length)}` } : { name }));
            });
            include.includes = [...include.includes, ...extra];
            added.push(...extra.map((e: any) => `${view.name}.${typeof e === 'string' ? e : e.alias ?? e.name}`));
          }
          include.excludes = withCompanionNames(include.excludes, entry.names);
        }
      }
    }
    if (!added.length) {
      return file;
    }
    salts.set(file.path, crypto.createHash('sha256').update(added.sort().join('\n'), 'utf8').digest('hex').slice(0, 12));
    return { ...file, content: `${/^(?:#[^\n]*\n)*/.exec(file.content)?.[0] ?? ''}${yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' })}` };
  });
  return { files: served, salts };
}

/** Whether a member name is a companion's, hidden from every field list. */
export function isCompanion(name: string): boolean {
  return name.includes(COMPANION_MARK);
}
