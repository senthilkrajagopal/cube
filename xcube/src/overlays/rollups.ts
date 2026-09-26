import yaml from 'js-yaml';

import type { SnapshotFile } from '../model/snapshot';
import type { PublishedItem } from '../names/items';

/**
 * The items an overlay's changes can reach: those it adds or changes, and
 * every item bound to one of them, however indirectly (a join, `extends`, a
 * member's SQL, a view). Their compiled SQL may differ from what is
 * published, so their rollup tables may not be built.
 */
export function reachedBy(items: PublishedItem[], changed: Set<string>): Set<string> {
  const referrers = new Map<string, string[]>();
  for (const item of items) {
    for (const target of new Set(Object.values(item.bindings))) {
      if (target !== item.fullName) {
        referrers.set(target, [...(referrers.get(target) ?? []), item.fullName]);
      }
    }
  }
  const reached = new Set<string>();
  const queue = [...changed];
  while (queue.length) {
    const name = queue.pop()!;
    if (!reached.has(name)) {
      reached.add(name);
      queue.push(...(referrers.get(name) ?? []));
    }
  }
  return reached;
}

/** The item an item extends, from its resolved YAML (xcube's own dump, so one line). */
function parentOf(item: PublishedItem): string | undefined {
  if (!item.resolvedYaml.includes('extends:')) {
    return undefined;
  }
  const match = /^(?: {4}| {2}- )extends: *"?([^"\n]+?)"? *$/m.exec(item.resolvedYaml);
  return match ? match[1] : undefined;
}

/**
 * The items an overlay's preview compiles without pre-aggregations: those
 * its changes reach, and every item they extend, however far up (Cube merges
 * a parent's rollups into the child, `CubeSymbols.ts`), with what those
 * reach in turn.
 */
export function rollupsToStrip(items: PublishedItem[], changed: Set<string>): Set<string> {
  const parents = new Map(items.map((item) => [item.fullName, parentOf(item)]));
  let stripped = reachedBy(items, changed);
  for (;;) {
    const ancestors = new Set<string>();
    for (const name of stripped) {
      for (let parent = parents.get(name); parent && !stripped.has(parent) && !ancestors.has(parent); parent = parents.get(parent)) {
        ancestors.add(parent);
      }
    }
    if (!ancestors.size) {
      return stripped;
    }
    stripped = reachedBy(items, new Set([...stripped, ...ancestors]));
  }
}

/**
 * An item's file without its pre-aggregations. A preview's queries on it
 * then read the source, since no API instance builds a rollup and an
 * overlay's are never scheduled.
 */
export function withoutRollups(file: SnapshotFile): SnapshotFile {
  const doc: any = yaml.load(file.content);
  let changed = false;
  for (const listKey of ['cubes', 'views']) {
    for (const entry of Array.isArray(doc?.[listKey]) ? doc[listKey] : []) {
      for (const key of ['pre_aggregations', 'preAggregations']) {
        if (entry && entry[key] !== undefined) {
          delete entry[key];
          changed = true;
        }
      }
    }
  }
  return changed ? { path: file.path, content: yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' }) } : file;
}
