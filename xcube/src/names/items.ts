import yaml from 'js-yaml';

import { JINJA_SYNTAX } from '../model/snapshot';

/** A folder id: `f` then letters and digits, as the client encodes its own ids. The root is `froot`. */
export const FOLDER_ID = /^f[a-z0-9]{1,40}$/;

export const ROOT = 'froot';

/**
 * A short name: lower-case words joined by single underscores. It never
 * holds `__`, so a short name can't be taken for a prefixed full name, and
 * never starts with `_`, which Cube keeps for its own names.
 */
export const SHORT_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export const MAX_SHORT_NAME = 40;

const PYTHON_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
  'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
  'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

export interface Folder {
  id: string;
  parentId: string | null;
}

export type ItemKind = 'cube' | 'view';

/** An item as the client wrote it. */
export interface AuthoredItem {
  folderId: string;
  name: string;
  kind: ItemKind;
  yaml: string;
}

/** An item as published: its full name, what it was bound to, and the YAML Cube compiles. */
export interface PublishedItem extends AuthoredItem {
  fullName: string;
  /** Each short name the item refers to, and the full name it was bound to at publish. */
  bindings: Record<string, string>;
  resolvedYaml: string;
}

/** A problem with an item, or with the changeset as a whole when `name` is null. */
export interface ItemError {
  folderId: string | null;
  name: string | null;
  line?: number;
  column?: number;
  kind: 'yaml' | 'item' | 'reference' | 'alias' | 'compile' | 'folder';
  message: string;
}

export function itemKey(folderId: string, name: string): string {
  return `${folderId}/${name}`;
}

export function fullNameOf(folderId: string, name: string): string {
  return folderId === ROOT ? name : `${folderId}__${name}`;
}

export function checkShortName(name: string): string | null {
  if (typeof name !== 'string' || name.length > MAX_SHORT_NAME || !SHORT_NAME.test(name)) {
    return `"${String(name).slice(0, 64)}" is not a valid name: lower-case letters, digits and single underscores, `
      + `starting with a letter, at most ${MAX_SHORT_NAME} characters`;
  }
  if (PYTHON_KEYWORDS.has(name)) {
    return `"${name}" is a reserved word and can't be a name`;
  }
  return null;
}

/** The folder tree, and each folder's chain from itself to the root. */
export class FolderTree {
  protected readonly parents = new Map<string, string | null>();

  public constructor(folders: Folder[]) {
    for (const folder of folders) {
      this.parents.set(folder.id, folder.parentId);
    }
  }

  public has(id: string): boolean {
    return this.parents.has(id);
  }

  public get folders(): Folder[] {
    return [...this.parents].map(([id, parentId]) => ({ id, parentId }));
  }

  /** The folder, then each ancestor up to the root. */
  public chain(id: string): string[] {
    const chain: string[] = [];
    let current: string | null | undefined = id;
    while (current) {
      chain.push(current);
      current = this.parents.get(current);
    }
    return chain;
  }

  /**
   * The problems with a tree: ids, a root that is `froot` and has no
   * parent, parents that exist, and no cycles.
   */
  public static check(folders: Folder[]): string[] {
    const problems: string[] = [];
    const ids = new Set<string>();
    for (const { id, parentId } of folders) {
      if (typeof id !== 'string' || !FOLDER_ID.test(id)) {
        problems.push(`Invalid folder id ${JSON.stringify(id)}: f followed by 1 to 40 lower-case letters and digits`);
      } else if (ids.has(id)) {
        problems.push(`Folder ${id} is listed twice`);
      }
      ids.add(id);
      if (id === ROOT && parentId !== null) {
        problems.push(`The root folder ${ROOT} has no parent`);
      }
      if (id !== ROOT && (parentId === null || parentId === undefined)) {
        problems.push(`Folder ${id} has no parent; only ${ROOT} is a root`);
      }
    }
    if (!ids.has(ROOT)) {
      problems.push(`The tree has no root folder ${ROOT}`);
    }
    const parents = new Map(folders.map((f) => [f.id, f.parentId]));
    for (const { id, parentId } of folders) {
      if (parentId && !parents.has(parentId)) {
        problems.push(`Folder ${id} has an unknown parent ${parentId}`);
      }
      const seen = new Set<string>();
      let current: string | null | undefined = id;
      while (current && parents.has(current)) {
        if (seen.has(current)) {
          problems.push(`Folder ${id} is in a cycle`);
          break;
        }
        seen.add(current);
        current = parents.get(current);
      }
    }
    return [...new Set(problems)];
  }
}

/** One cube or view, parsed. */
export interface ItemDefinition {
  folderId: string;
  name: string;
  kind: ItemKind;
  fullName: string;
  /** The cube's or view's own definition object, as parsed. */
  doc: Record<string, any>;
  /** Names of its measures, dimensions, segments, pre-aggregations and hierarchies (not inherited ones). */
  members: Set<string>;
  /** The short name it extends, if any. */
  extendsName?: string;
}

function namesIn(list: unknown): string[] {
  return Array.isArray(list) ? list.map((m: any) => m?.name).filter((n) => typeof n === 'string') : [];
}

/**
 * Parses an item: YAML holding exactly one cube (`cubes: [...]`) or one view
 * (`views: [...]`), named as the item is.
 */
export function parseItem(item: AuthoredItem): { def?: ItemDefinition; errors: ItemError[] } {
  const at = { folderId: item.folderId, name: item.name };
  const fail = (message: string, kind: ItemError['kind'] = 'item', extra: Partial<ItemError> = {}) => (
    { errors: [{ ...at, kind, message, ...extra }] }
  );

  const nameProblem = checkShortName(item.name);
  if (nameProblem) {
    return fail(nameProblem);
  }
  if (item.kind !== 'cube' && item.kind !== 'view') {
    return fail('kind is cube or view');
  }
  if (typeof item.yaml !== 'string') {
    return fail('yaml is the item\'s YAML text');
  }
  if (JINJA_SYNTAX.test(item.yaml)) {
    return fail('only plain YAML models are taken (no Jinja)');
  }

  let parsed: any;
  try {
    parsed = yaml.load(item.yaml);
  } catch (e: any) {
    return fail(e.reason || e.message, 'yaml', e.mark ? { line: e.mark.line + 1, column: e.mark.column + 1 } : {});
  }

  const listKey = item.kind === 'cube' ? 'cubes' : 'views';
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(`The YAML must hold ${listKey}: with one ${item.kind}`);
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== listKey || !Array.isArray(parsed[listKey]) || parsed[listKey].length !== 1) {
    return fail(`The YAML must hold only ${listKey}: with exactly one ${item.kind}`);
  }
  const doc = parsed[listKey][0];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return fail(`The ${item.kind} must be a mapping`);
  }
  if (doc.name !== item.name) {
    return fail(`The ${item.kind} is named "${doc.name}", but the item is "${item.name}"`);
  }

  const members = new Set<string>([
    ...namesIn(doc.measures),
    ...namesIn(doc.dimensions),
    ...namesIn(doc.segments),
    ...namesIn(doc.pre_aggregations ?? doc.preAggregations),
    ...namesIn(doc.hierarchies),
  ]);
  const extendsName = typeof doc.extends === 'string' ? doc.extends.trim() : undefined;

  return {
    def: {
      folderId: item.folderId,
      name: item.name,
      kind: item.kind,
      fullName: fullNameOf(item.folderId, item.name),
      doc,
      members,
      extendsName,
    },
    errors: [],
  };
}
