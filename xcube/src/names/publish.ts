import crypto from 'crypto';
import camelCase from 'camelcase';
import inflection from 'inflection';
import yaml from 'js-yaml';

import type { SnapshotFile } from '../model/snapshot';
import {
  FolderTree,
  fullNameOf,
  itemKey,
  parseItem,
  ROOT,
  type AuthoredItem,
  type ItemDefinition,
  type ItemError,
  type PublishedItem,
} from './items';
import { rewriteReferences, Scope } from './rewrite';

/** The longest `<cubeAlias>_<preAggregation>` whose rollup table name, with Cube's version suffix, fits Postgres's 63. */
export const MAX_TABLE_STEM = 25;

/** The longest cube alias written as is; longer full names get a hash alias. */
export const MAX_PLAIN_ALIAS = 20;

export const MAX_IDENTIFIER = 63;

/** The longest granularity suffix Cube appends to a time dimension's alias (`_quarter`). */
const GRANULARITY_SUFFIX = 8;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(text: string, length: number): string {
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
  let out = '';
  for (let i = 0; out.length < length; i++) {
    out += BASE32[digest[i] % 32];
  }
  return out;
}

/** Cube's default title for a name, by Cube's own steps (`CubeToMetaTransformer.ts:181-185`). */
export function titleOf(name: string): string {
  return inflection.titleize(inflection.underscore(camelCase(name, { pascalCase: true })))
    .replace(/\bId(s?)\b/g, (_m, plural) => `ID${plural}`);
}

/** The alias xcube gives a prefixed cube or view without one: short names stay, long ones become a stable hash. */
export function aliasOf(fullName: string, dataSource?: string): string {
  if (dataSource === undefined) {
    return fullName.length <= MAX_PLAIN_ALIAS ? fullName : `x${base32(fullName, 7)}`;
  }
  const plain = `${fullName}_${base32(dataSource, 4)}`;
  return plain.length <= MAX_PLAIN_ALIAS ? plain : `x${base32(`${fullName}@${dataSource}`, 7)}`;
}

export interface PublishInput {
  tree: FolderTree;
  /** The current revision's items. */
  current: PublishedItem[];
  upserts: AuthoredItem[];
  deletes: { folderId: string; name: string }[];
  /** A snapshot: `upserts` are every item, and all are resolved afresh. */
  replaceAll?: boolean;
  /** Deleting an item that isn't there is no error (checking whether a retry is already in). */
  lenientDeletes?: boolean;
  /**
   * The upserts are an overlay's (a workspace's or a proposal's): their names
   * resolve among themselves first, then along their folder's path, and no
   * two may share a short name.
   */
  overlay?: boolean;
  /**
   * The model's data sources (connections), by folder and short name: when
   * given, a cube's `data_source` is bound to one nearest-first from its
   * folder, and a cube naming none to the nearest `default`.
   */
  dataSources?: { folderId: string; name: string }[];
}

export interface PublishResult {
  items: PublishedItem[];
  /** Items resolved in this publish. */
  changed: string[];
  errors: ItemError[];
}

function listKeyOf(kind: 'cube' | 'view') {
  return kind === 'cube' ? 'cubes' : 'views';
}

export function dump(kind: 'cube' | 'view', doc: Record<string, any>): string {
  return yaml.dump({ [listKeyOf(kind)]: [doc] }, { lineWidth: -1, noRefs: true, quotingType: '"' });
}

function preAggregationsOf(doc: Record<string, any>): any[] {
  const list = doc.pre_aggregations ?? doc.preAggregations;
  return Array.isArray(list) ? list.filter((pa) => pa && typeof pa.name === 'string') : [];
}

type Entry = { def: ItemDefinition; doc: Record<string, any>; resolved: boolean };

/**
 * The data source a cube's alias names: its own as bound (or written), else
 * the one it inherits through `extends`, unless that is Cube's default. Cube
 * keys cached results by their SQL and names rollup tables by the alias,
 * neither by data source: a cube on another data source must be another SQL
 * alias, or it would be answered from what the old one gave.
 */
function aliasedDataSource(entry: Entry, byFullName: Map<string, Entry>): string | undefined {
  const seen = new Set<string>();
  for (let at: Entry | undefined = entry; at && !seen.has(at.def.fullName);) {
    seen.add(at.def.fullName);
    const named = at.doc.data_source ?? at.doc.dataSource;
    if (typeof named === 'string') {
      return named !== 'default' ? named : undefined;
    }
    at = typeof at.doc.extends === 'string' ? byFullName.get(at.doc.extends.trim()) : undefined;
  }
  return undefined;
}

/**
 * A cube's alias naming `salt` (its data source, or, as served, its
 * connection's identity), or its full name alone without one. A rollup table
 * is named `<alias>_<pre-aggregation>`: when that would be too long, the
 * short hash alias.
 */
export function saltedAlias(fullName: string, doc: Record<string, any>, salt: string | undefined): string {
  const alias = aliasOf(fullName, salt);
  const tooLong = preAggregationsOf(doc).some((pa) => `${alias}_${pa.sql_alias ?? pa.sqlAlias ?? pa.name}`.length > MAX_TABLE_STEM);
  return tooLong ? `x${base32(salt === undefined ? fullName : `${fullName}@${salt}`, 7)}` : alias;
}

/**
 * The SQL alias xcube gives an item whose author wrote none:
 * - a prefixed view's is its full name, or a short hash when that is long;
 * - a prefixed cube's names it too, and the data source it is on unless that is
 *   Cube's default; so does a root cube's on a data source of its own,
 *   inherited ones included;
 * - a cube that extends another has one of its own, or Cube would give it its
 *   parent's (`CubeSymbols` sets the parent as its prototype);
 * - any other root item has none, and is its name.
 */
function generatedAlias(entry: Entry, byFullName: Map<string, Entry>): string | undefined {
  const { def, doc } = entry;
  if (def.kind === 'view') {
    return def.folderId === ROOT ? undefined : aliasOf(def.fullName);
  }
  const dataSource = aliasedDataSource(entry, byFullName);
  if (def.folderId === ROOT && dataSource === undefined) {
    return typeof doc.extends === 'string' ? def.fullName : undefined;
  }
  return saltedAlias(def.fullName, doc, dataSource);
}

/**
 * Each item's SQL alias, once every item of the publish is resolved. A kept
 * cube whose alias that changes (its parent published onto another data
 * source) is re-dumped with the new alias, and nothing else: its bindings
 * stay as published. Returns the keys of those.
 */
function assignAliases(entries: Entry[]): Set<string> {
  const byFullName = new Map(entries.map((entry) => [entry.def.fullName, entry]));
  const realiased = new Set<string>();
  entries
    .filter(({ def }) => def.doc.sql_alias === undefined && def.doc.sqlAlias === undefined)
    .forEach((entry) => {
      const { def, doc } = entry;
      const alias = generatedAlias(entry, byFullName);
      if (alias !== (doc.sql_alias ?? doc.sqlAlias)) {
        delete doc.sqlAlias;
        if (alias === undefined) {
          delete doc.sql_alias;
        } else {
          doc.sql_alias = alias;
        }
        if (!entry.resolved) {
          realiased.add(itemKey(def.folderId, def.name));
          entry.resolved = true;
        }
      }
    });
  return realiased;
}

/**
 * What xcube adds to a resolved item: its title when prefixed (its alias
 * comes once every item is resolved, `assignAliases`), aliases for the
 * cubes of a view that prefix or split by them, and where
 * it came from, in `meta.xcube`, for the client's pickers.
 */
function finish(def: ItemDefinition, doc: Record<string, any>) {
  const prefixed = def.folderId !== ROOT;
  if (prefixed && doc.title === undefined) {
    doc.title = titleOf(def.name);
  }
  if (def.kind === 'view' && Array.isArray(def.doc.cubes)) {
    // A view prefixes or splits by each cube's name; keep it the short one (CubeSymbols.ts:946, 1018).
    def.doc.cubes.forEach((authored: any, i: number) => {
      const entry = doc.cubes?.[i];
      const joinPath = authored?.join_path ?? authored?.joinPath;
      if (entry && (entry.prefix || entry.split) && entry.alias === undefined && typeof joinPath === 'string') {
        entry.alias = joinPath.split('.').pop()!.trim();
      }
    });
  }
  const meta = doc.meta && typeof doc.meta === 'object' && !Array.isArray(doc.meta) ? doc.meta : {};
  doc.meta = { ...meta, xcube: { folderId: def.folderId, shortName: def.name } };
}

/** The names a view's members get from its `cubes` entries (CubeSymbols.ts:946). */
function viewMemberNames(doc: Record<string, any>): string[] {
  const names: string[] = [];
  for (const entry of Array.isArray(doc.cubes) ? doc.cubes : []) {
    const joinPath = entry?.join_path ?? entry?.joinPath;
    const cube = typeof joinPath === 'string' ? joinPath.split('.').pop()! : '';
    for (const include of Array.isArray(entry?.includes) ? entry.includes : []) {
      const member = typeof include === 'string' ? include : (include?.alias ?? include?.name);
      if (typeof member === 'string' && member !== '*') {
        names.push(entry.prefix ? `${entry.alias ?? cube}_${member}` : member);
      }
    }
  }
  return names;
}

/**
 * The aliases Cube will build SQL and rollup tables from, checked across the
 * whole model: two cubes can't share one, and none may make a Postgres
 * identifier too long. Pre-aggregations of prefixed cubes whose table stem
 * would be too long get a short stable alias.
 */
function checkAliases(entries: Entry[]): ItemError[] {
  const errors: ItemError[] = [];
  const cubeAliases = new Map<string, string>();
  const tables = new Map<string, string>();

  for (const { def, doc, resolved } of entries) {
    const at = { folderId: def.folderId, name: def.name };
    const alias: string = doc.sql_alias ?? doc.sqlAlias ?? doc.name;
    const other = cubeAliases.get(alias);
    if (other) {
      errors.push({ ...at, kind: 'alias', message: `Its SQL alias "${alias}" is also ${other}'s` });
    }
    cubeAliases.set(alias, def.fullName);

    const prefixed = def.folderId !== ROOT;
    for (const pa of preAggregationsOf(doc)) {
      let paAlias: string = pa.sql_alias ?? pa.sqlAlias ?? pa.name;
      if (resolved && prefixed && `${alias}_${paAlias}`.length > MAX_TABLE_STEM) {
        // Cube names a pre-aggregation's indexes after its alias when it has one
        // (PreAggregations.ts:417, 450), so only one without indexes may get one.
        const hasIndexes = Array.isArray(pa.indexes) ? pa.indexes.length > 0 : Boolean(pa.indexes);
        if (pa.sql_alias === undefined && pa.sqlAlias === undefined && !hasIndexes) {
          paAlias = `p${base32(`${def.fullName}.${pa.name}`, 6)}`;
          pa.sql_alias = paAlias;
        }
        if (`${alias}_${paAlias}`.length > MAX_TABLE_STEM) {
          const room = MAX_TABLE_STEM - alias.length - 1;
          errors.push({
            ...at,
            kind: 'alias',
            message: `Pre-aggregation ${pa.name}'s rollup table name would be too long: shorten its name to at most ${room} characters`,
          });
        }
      }
      const table = `${alias}_${paAlias}`;
      const owner = tables.get(table);
      if (owner) {
        errors.push({ ...at, kind: 'alias', message: `Pre-aggregation ${pa.name} would share its table ${table} with ${owner}` });
      }
      tables.set(table, `${def.fullName}.${pa.name}`);
    }

    if (prefixed) {
      const timeDimensions = new Set<string>((Array.isArray(doc.dimensions) ? doc.dimensions : [])
        .filter((d: any) => d?.type === 'time').map((d: any) => d.name));
      const members = def.kind === 'view' ? [...def.members, ...viewMemberNames(doc)] : [...def.members];
      for (const member of members) {
        const length = `${alias}__${member}`.length + (timeDimensions.has(member) ? GRANULARITY_SUFFIX : 0);
        if (length > MAX_IDENTIFIER) {
          errors.push({ ...at, kind: 'alias', message: `Member ${member}'s SQL alias would be longer than ${MAX_IDENTIFIER} characters; shorten the name` });
        }
      }
    }
  }
  return errors;
}

/**
 * Applies a changeset (or a whole snapshot) to the current items: resolves
 * the items it changes, nearest-first from each item's folder, keeps every
 * other item as it was published (no rebinding), and refuses to remove an
 * item another still refers to.
 */
/**
 * Binds a cube's `data_source` to the full name of the data source it
 * names, nearest-first from the cube's folder toward the root (never a
 * descendant's or a sibling's, AC-273); a cube naming none gets the
 * nearest `default` (AC-310), unless it extends another, whose it inherits.
 */
function bindDataSource(
  def: ItemDefinition,
  doc: Record<string, any>,
  tree: FolderTree,
  dataSources: { folderId: string; name: string }[],
): ItemError | undefined {
  const at = { folderId: def.folderId, name: def.name };
  const byFolder = new Map<string, Set<string>>();
  dataSources.forEach(({ folderId, name }) => byFolder.set(folderId, (byFolder.get(folderId) ?? new Set()).add(name)));
  const nearest = (name: string) => {
    const folder = tree.chain(def.folderId).find((f) => byFolder.get(f)?.has(name));
    return folder === undefined ? undefined : fullNameOf(folder, name);
  };
  const key = ['data_source', 'dataSource'].find((k) => doc[k] !== undefined);
  if (key) {
    const named = doc[key];
    if (typeof named !== 'string' || !named) {
      return { ...at, kind: 'reference', message: 'data_source must name a data source' };
    }
    if (named.includes('__')) {
      return { ...at, kind: 'reference', message: `"${named}" is a full name; name the data source by its short name` };
    }
    const bound = nearest(named);
    if (!bound) {
      return { ...at, kind: 'reference', message: `It uses the data source "${named}", which no folder on this item's path holds` };
    }
    doc[key] = bound;
  } else if (!def.extendsName) {
    const bound = nearest('default');
    // The root's default is Cube's default: nothing to write.
    if (bound && bound !== 'default') {
      doc.data_source = bound;
    }
  }
  return undefined;
}

export function publish({
  tree, current, upserts, deletes, replaceAll, lenientDeletes, overlay, dataSources,
}: PublishInput): PublishResult {
  const errors: ItemError[] = [];

  // What is written must be in the tree; what is deleted need not be, as a snapshot drops a
  // folder and its items together (a delete of an item that isn't there is refused below).
  for (const item of upserts) {
    if (!tree.has(item.folderId)) {
      errors.push({ folderId: item.folderId, name: item.name, kind: 'folder', message: `Folder ${item.folderId} is not in the folder tree` });
    }
  }
  const upserted = new Map<string, AuthoredItem>();
  for (const item of upserts) {
    const key = itemKey(item.folderId, item.name);
    if (upserted.has(key)) {
      errors.push({ folderId: item.folderId, name: item.name, kind: 'item', message: 'The item is in the changeset twice' });
    }
    upserted.set(key, item);
  }
  if (overlay) {
    const byName = new Map<string, AuthoredItem>();
    for (const item of upserts) {
      const other = byName.get(item.name);
      if (other && other.folderId !== item.folderId) {
        errors.push({
          folderId: item.folderId,
          name: item.name,
          kind: 'item',
          message: `The overlay holds two items named "${item.name}" (in ${other.folderId} and ${item.folderId}); names in it resolve to its own items first, so they must differ`,
        });
      }
      byName.set(item.name, item);
    }
  }
  if (errors.length) {
    return { items: current, changed: [], errors };
  }

  const kept = new Map<string, PublishedItem>();
  if (!replaceAll) {
    current.forEach((item) => kept.set(itemKey(item.folderId, item.name), item));
    for (const { folderId, name } of deletes) {
      if (!kept.delete(itemKey(folderId, name)) && !lenientDeletes) {
        errors.push({ folderId, name, kind: 'item', message: 'There is no such item to delete' });
      }
    }
    upserted.forEach((_item, key) => kept.delete(key));
  }

  // Parse every item: the changed ones to resolve, the others for their members and names.
  const defs = new Map<string, ItemDefinition>();
  for (const item of [...kept.values(), ...upserted.values()]) {
    const { def, errors: parseErrors } = parseItem(item);
    errors.push(...parseErrors);
    if (def) {
      defs.set(itemKey(item.folderId, item.name), def);
    }
  }
  if (errors.length) {
    return { items: current, changed: [], errors };
  }

  const keptBindings = new Map([...kept].map(([key, item]) => [key, item.bindings]));
  const overlayNames = overlay
    ? new Map([...upserted.keys()].map((key) => [defs.get(key)!.name, defs.get(key)!]))
    : undefined;
  const scope = new Scope(tree, [...defs.values()], (def) => keptBindings.get(itemKey(def.folderId, def.name)), overlayNames);

  // Nothing kept may lose what it is bound to.
  const fullNames = new Set([...defs.values()].map((d) => d.fullName));
  const referrers = new Map<string, string[]>();
  for (const item of kept.values()) {
    for (const target of Object.values(item.bindings)) {
      if (!fullNames.has(target)) {
        referrers.set(target, [...(referrers.get(target) ?? []), `${item.folderId}/${item.name}`]);
      }
    }
  }
  for (const [target, by] of referrers) {
    const gone = current.find((item) => item.fullName === target);
    errors.push({
      folderId: gone?.folderId ?? null,
      name: gone?.name ?? null,
      kind: 'reference',
      message: `${gone ? `${gone.folderId}/${gone.name}` : target} can't be removed or renamed: ${by.sort().join(', ')} refer${by.length === 1 ? 's' : ''} to it`,
    });
  }

  const resolvedDocs = new Map<string, Record<string, any>>();
  const newBindings = new Map<string, Record<string, string>>();
  for (const [key] of upserted) {
    const def = defs.get(key)!;
    const { doc, bindings, errors: rewriteErrors } = rewriteReferences(def, scope);
    errors.push(...rewriteErrors);
    if (dataSources && def.kind === 'cube') {
      const dataSourceError = bindDataSource(def, doc, tree, dataSources);
      if (dataSourceError) {
        errors.push(dataSourceError);
      }
    }
    finish(def, doc);
    resolvedDocs.set(key, doc);
    newBindings.set(key, bindings);
  }

  const entries: Entry[] = [...defs].map(([key, def]) => ({
    def,
    doc: resolvedDocs.get(key) ?? (yaml.load(kept.get(key)!.resolvedYaml) as any)[listKeyOf(def.kind)][0],
    resolved: resolvedDocs.has(key),
  }));
  const realiased = assignAliases(entries);
  errors.push(...checkAliases(entries));
  if (errors.length) {
    return { items: current, changed: [], errors };
  }

  const items: PublishedItem[] = entries.map(({ def, doc, resolved }) => {
    const key = itemKey(def.folderId, def.name);
    if (!resolved) {
      return kept.get(key)!;
    }
    if (realiased.has(key)) {
      return { ...kept.get(key)!, resolvedYaml: dump(def.kind, doc) };
    }
    const authored = upserted.get(key)!;
    return {
      ...authored,
      fullName: def.fullName,
      bindings: newBindings.get(key)!,
      resolvedYaml: dump(def.kind, doc),
    };
  }).sort((a, b) => (a.fullName < b.fullName ? -1 : 1));

  return { items, changed: [...upserted.keys(), ...realiased], errors: [] };
}

/** The files Cube compiles: one per item, named by its full name. */
export function filesOf(items: PublishedItem[]): SnapshotFile[] {
  return items.map((item) => ({ path: `${item.fullName}.yml`, content: item.resolvedYaml }));
}

/**
 * The identity of an item set, as the client can compute it: the SHA-256 of
 * the items sorted by folder and name, as the JSON
 * `[{"folderId","name","kind","yaml"}, …]`.
 */
export function itemsHash(items: AuthoredItem[]): string {
  const sorted = [...items]
    .sort((a, b) => (itemKey(a.folderId, a.name) < itemKey(b.folderId, b.name) ? -1 : 1))
    .map(({ folderId, name, kind, yaml: text }) => ({ folderId, name, kind, yaml: text }));
  return crypto.createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
}
