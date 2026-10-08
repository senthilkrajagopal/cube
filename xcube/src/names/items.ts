import yaml from 'js-yaml';

import { JINJA_SYNTAX } from '../model/snapshot';
import { GATE_GROUP, namesGateGroup } from '../security/marker';
import { COMPANION_MARK, isCompanion } from '../calcs/companions';

/** A folder id: `f` then letters and digits, as the client encodes its own ids. The root is `froot`. */
export const FOLDER_ID = /^f[a-z0-9]{1,40}$/;

export const ROOT = 'froot';

/**
 * An item's or a data source's name, one per model (R71): a letter, then
 * letters, digits and single underscores. Cube names a member's SQL column
 * `<cube>__<member>` (`BaseQuery.aliasName`), and allows `__` and a leading
 * `_` in member names; a name holding `__`, or ending in `_`, could make two
 * members' columns one.
 */
export const NAME = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;

export const MAX_NAME = 40;

/**
 * Names a cube or view may not take, compared in any case: Python's keywords,
 * as Cube's YAML compiler reads `{…}` as Python (`Python3Lexer.g4`), and the
 * names Cube resolves before any cube's (`CubeSymbols.ts` `CONTEXT_SYMBOLS`,
 * `CURRENT_CUBE_CONSTANTS`, `USER_CONTEXT`; `COMPILE_CONTEXT`).
 */
const RESERVED = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
  'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
  'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'none', 'true', 'false',
  'cube', 'table', 'security_context', 'securitycontext', 'filter_params', 'filter_group', 'sql_utils',
  'user_context', 'compile_context',
]);

/** A name as names compare: in any case (R71). */
export function nameKey(name: string): string {
  return name.toLowerCase();
}

export interface Folder {
  id: string;
  parentId: string | null;
  /** The groups whose tokens may read what it holds; absent: as stored (none, for a new folder). */
  allowedGroups?: string[];
}

export type ItemKind = 'cube' | 'view';

/** An item as the client wrote it. */
export interface AuthoredItem {
  folderId: string;
  name: string;
  kind: ItemKind;
  yaml: string;
}

/** An item as published: what it refers to, and the YAML Cube compiles. */
export interface PublishedItem extends AuthoredItem {
  /** Its name as Cube serves it: the name itself, since names are one per model (R71). */
  fullName: string;
  /** Each name the item refers to, as written, and the item it means, by its own name. */
  bindings: Record<string, string>;
  resolvedYaml: string;
}

/** A problem with an item, or with the changeset as a whole when `name` is null. */
export interface ItemError {
  folderId: string | null;
  name: string | null;
  line?: number;
  column?: number;
  kind: 'yaml' | 'item' | 'reference' | 'alias' | 'compile' | 'folder' | 'name_in_use' | 'data_source_range' | 'reference_range';
  message: string;
}

/** An item's identity: its name, in any case. Its folder is where it is, not what it is. */
export function itemKey(name: string): string {
  return nameKey(name);
}

function checkGrammar(name: unknown, what: string): string | null {
  if (typeof name !== 'string' || name.length > MAX_NAME || !NAME.test(name)) {
    return `"${String(name).slice(0, 64)}" is not a valid ${what}: a letter, then letters, digits and single underscores, `
      + `not ending in one, at most ${MAX_NAME} characters`;
  }
  return null;
}

export function checkName(name: string): string | null {
  const problem = checkGrammar(name, 'name');
  if (problem) {
    return problem;
  }
  if (RESERVED.has(nameKey(name))) {
    return `"${name}" is a reserved word and can't be a name`;
  }
  return null;
}

/** A data source's name: the same grammar; no reserved words, as no `{…}` names one. */
export function checkDataSourceName(name: string): string | null {
  return checkGrammar(name, 'data source name');
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
  /** The name it extends, as written, if any. */
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

  const nameProblem = checkName(item.name);
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
  if (namesGateGroup(doc)) {
    return fail(`Access policies may not name the group ${GATE_GROUP}: xcube keeps it for the folder gate`);
  }
  const marked = [
    ...namesIn(doc.measures), ...namesIn(doc.dimensions), ...namesIn(doc.segments),
    ...(Array.isArray(doc.cubes) ? doc.cubes : []).flatMap((c: any) => (Array.isArray(c?.includes) ? c.includes : [])
      .map((i: any) => (typeof i === 'string' ? i : i?.alias ?? i?.name))),
  ].filter((name) => typeof name === 'string' && isCompanion(name));
  if (marked.length) {
    return fail(`Member names may not hold "${COMPANION_MARK}": xcube keeps it for quick calculations (${marked.join(', ')})`);
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
      fullName: item.name,
      doc,
      members,
      extendsName,
    },
    errors: [],
  };
}
