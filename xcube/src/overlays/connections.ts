import type { SnapshotFile } from '../model/snapshot';
import type { PublishedItem } from '../names/items';

/**
 * The data source a published cube is bound to: its `data_source` as
 * resolved, `default` when it names none, or `null` when it extends another,
 * whose it inherits. From xcube's own dump, so one key per line.
 */
export function boundDataSource(item: PublishedItem): string | null {
  const bound = /^(?: {4}| {2}- )(?:data_source|dataSource): *"?([^"\n]+?)"? *$/m.exec(item.resolvedYaml)?.[1];
  if (bound !== undefined) {
    return bound;
  }
  return /^(?: {4}| {2}- )extends:/m.test(item.resolvedYaml) ? null : 'default';
}

/**
 * The most orchestrators kept for previews of overlays that bring data
 * sources: past that, the least recently used goes. Cube's own cache is
 * this much larger (`XcubeServerCore`), so previews never push a model's out.
 */
export const MAX_OVERLAY_ORCHESTRATORS = 20;

const MARKER = /^# xcube: overlay data source (\S+) \((\S+)\)$/gm;

/**
 * A cube's file, marked as bound to a data source an overlay brings. The mark
 * gives the module a content of its own, so it compiles apart from the
 * published one, and names the data source's driver type, the dialect Cube
 * compiles it with (`markedDataSources`).
 */
export function withDataSourceMark(file: SnapshotFile, dataSource: string, cubeType: string): SnapshotFile {
  return { ...file, content: `# xcube: overlay data source ${dataSource} (${cubeType})\n${file.content}` };
}

const marks = new WeakMap<SnapshotFile[], Map<string, string>>();

/** The data sources a compiled model's files are marked as bound to, with each one's driver type. */
export function markedDataSources(files: SnapshotFile[]): Map<string, string> {
  let found = marks.get(files);
  if (!found) {
    found = new Map();
    for (const file of files) {
      for (const [, dataSource, cubeType] of file.content.matchAll(MARKER)) {
        found.set(dataSource, cubeType);
      }
    }
    marks.set(files, found);
  }
  return found;
}

/** The overlay an app id serves (`xcube:<model>:o:<id>:<version>:…`), if it serves one. */
export function overlayOfAppId(appId: string): { model: string; id: string; version: number } | undefined {
  const match = /^xcube:(.+?):o:([A-Za-z0-9_-]{1,64}):(\d+):/.exec(appId);
  return match ? { model: match[1], id: match[2], version: Number(match[3]) } : undefined;
}
