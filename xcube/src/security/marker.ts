import yaml from 'js-yaml';

import type { SnapshotFile } from '../model/snapshot';

/**
 * The reserved group of the policy xcube adds to every cube and view it
 * publishes. It matches nobody (`contextToGroups` never yields it), so a
 * cube with no policy of its own is closed to Cube itself; the folder gate
 * below opens it to those its folder admits.
 */
export const GATE_GROUP = 'xcube.folder-gate';

function policyGroups(policy: any): string[] {
  const out: string[] = [];
  for (const key of ['group', 'groups']) {
    const value = policy?.[key];
    if (typeof value === 'string') {
      out.push(value);
    } else if (Array.isArray(value)) {
      out.push(...value.filter((g) => typeof g === 'string'));
    }
  }
  return out;
}

function policyListsOf(doc: Record<string, any>): string[] {
  return ['access_policy', 'accessPolicy'].filter((key) => doc[key] !== undefined);
}

/** Whether an authored cube or view names the reserved group in a policy of its own. */
export function namesGateGroup(doc: Record<string, any>): boolean {
  return policyListsOf(doc).some((key) => Array.isArray(doc[key]) && doc[key].some((p: any) => policyGroups(p).includes(GATE_GROUP)));
}

/** The reserved policy. Publishing refuses an authored one naming the group, so the group alone tells it. */
export function isGate(policy: any): boolean {
  return policy?.group === GATE_GROUP;
}

export function folderOf(doc: any): string | undefined {
  const folderId = doc?.meta?.xcube?.folderId;
  return typeof folderId === 'string' ? folderId : undefined;
}

const folderMaps = new WeakMap<SnapshotFile[], Map<string, string>>();

/** Each cube's and view's folder, by its name, as xcube published it (`meta.xcube`), for a revision's files. */
export function foldersOfFiles(files: SnapshotFile[]): Map<string, string> {
  let found = folderMaps.get(files);
  if (!found) {
    found = new Map();
    for (const file of files.filter((f) => /\.ya?ml$/i.test(f.path) && f.content.includes('xcube'))) {
      try {
        const doc: any = yaml.load(file.content);
        for (const item of [...(doc?.cubes ?? []), ...(doc?.views ?? [])]) {
          const folderId = folderOf(item);
          if (typeof item?.name === 'string' && folderId !== undefined) {
            found.set(item.name, folderId);
          }
        }
      } catch {
        // Not xcube's: Cube's own rules.
      }
    }
    folderMaps.set(files, found);
  }
  return found;
}

/**
 * A published item's file as Cube compiles it: each cube and view xcube
 * published (it carries `meta.xcube`) gets the reserved policy, appended to
 * the policy list it has, under the key its author used (both, when both
 * are set: Cube keeps one, CubeSymbols.ts:500). Files xcube didn't publish
 * are left as they are.
 */
export function withGate(file: SnapshotFile): SnapshotFile {
  if (!/\.ya?ml$/i.test(file.path) || !file.content.includes('xcube')) {
    return file;
  }
  let doc: any;
  try {
    doc = yaml.load(file.content);
  } catch {
    return file;
  }
  let changed = false;
  for (const listKey of ['cubes', 'views']) {
    for (const entry of Array.isArray(doc?.[listKey]) ? doc[listKey] : []) {
      const published = entry && typeof entry === 'object' && folderOf(entry) !== undefined;
      const keys = published ? policyListsOf(entry) : [];
      for (const key of !published || keys.length ? keys : ['access_policy']) {
        const list = entry[key] ?? [];
        if (Array.isArray(list)) {
          entry[key] = [...list, { group: GATE_GROUP }];
          changed = true;
        }
      }
    }
  }
  if (!changed) {
    return file;
  }
  return { path: file.path, content: yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' }) };
}
