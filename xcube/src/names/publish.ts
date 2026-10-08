import crypto from 'crypto';
import camelCase from 'camelcase';
import inflection from 'inflection';
import yaml from 'js-yaml';

import type { SnapshotFile } from '../model/snapshot';
import {
  FolderTree,
  itemKey,
  nameKey,
  parseItem,
  type AuthoredItem,
  type ItemDefinition,
  type ItemError,
  type PublishedItem,
} from './items';
import { rewriteReferences, Scope } from './rewrite';

/** The longest `<cubeAlias>_<preAggregation>` whose rollup table name, with Cube's version suffix, fits Postgres's 63. */
export const MAX_TABLE_STEM = 25;

/** The longest cube alias a data source's salt is added to as is; longer ones get a hash alias. */
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

/**
 * The alias of a name on a data source other than Cube's default: the name
 * with a short hash of the data source when that is short, else a stable
 * hash of both. Without a data source, the name.
 */
export function aliasOf(name: string, dataSource?: string): string {
  if (dataSource === undefined) {
    return name;
  }
  const plain = `${name}_${base32(dataSource, 4)}`;
  return plain.length <= MAX_PLAIN_ALIAS ? plain : `x${base32(`${name}@${dataSource}`, 7)}`;
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
   * The upserts are an overlay's (a workspace's or a proposal's): one with a
   * published item's name is that item's edit, wherever either is (R71 2.6),
   * and no two may share a name.
   */
  overlay?: boolean;
  /**
   * The model's data sources (connections), with their folders: when given,
   * the data source each cube uses, its own or its parent's through
   * `extends`, must be one of them, in its folder or an ancestor (R71 4).
   */
  dataSources?: { folderId: string; name: string }[];
}

export interface PublishResult {
  items: PublishedItem[];
  /** Items resolved in this publish, by `itemKey`. */
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
 * The data source a cube uses, with the cube it is named on: its own, else
 * the one it inherits through `extends`, however far up; `default` (Cube's,
 * the root's) when no cube of the chain names one.
 */
function usedDataSource(entry: Entry, byName: Map<string, Entry>): { name: string; from: Entry } {
  const seen = new Set<string>();
  for (let at: Entry | undefined = entry; at && !seen.has(at.def.name);) {
    seen.add(at.def.name);
    const named = at.doc.data_source ?? at.doc.dataSource;
    if (typeof named === 'string') {
      return { name: named, from: at };
    }
    at = typeof at.doc.extends === 'string' ? byName.get(at.doc.extends.trim()) : undefined;
  }
  return { name: 'default', from: entry };
}

/**
 * The data source a cube's alias names: the one it uses, unless that is
 * Cube's default. Cube keys cached results by their SQL and names rollup
 * tables by the alias, neither by data source: a cube on another data source
 * must be another SQL alias, or it would be answered from what the old one gave.
 */
function aliasedDataSource(entry: Entry, byName: Map<string, Entry>): string | undefined {
  const { name } = usedDataSource(entry, byName);
  return name !== 'default' ? name : undefined;
}

/** A name as Cube's planners make it a SQL identifier (`BaseQuery.aliasName`). */
const sqlName = (name: string) => inflection.underscore(name);

/** Its members' names, and for a view those its `cubes` entries give (CubeSymbols.ts:946). */
function memberNamesOf(def: ItemDefinition, doc: Record<string, any>): string[] {
  if (def.kind === 'cube') {
    return [...def.members];
  }
  const names = [...def.members];
  for (const entry of Array.isArray(doc.cubes) ? doc.cubes : []) {
    const joinPath = entry?.join_path ?? entry?.joinPath;
    const cube = typeof joinPath === 'string' ? joinPath.split('.').pop()!.trim() : '';
    for (const include of Array.isArray(entry?.includes) ? entry.includes : []) {
      const member = typeof include === 'string' ? include : (include?.alias ?? include?.name);
      if (typeof member === 'string' && member !== '*') {
        names.push(entry.prefix ? `${entry.alias ?? cube}_${member}` : member);
      }
    }
  }
  return names;
}

/** Whether a cube alias leaves some member's SQL alias, or rollup table stem, too long. */
function tooLong(alias: string, def: ItemDefinition, doc: Record<string, any>): boolean {
  const times = new Set<string>((Array.isArray(doc.dimensions) ? doc.dimensions : [])
    .filter((d: any) => d?.type === 'time').map((d: any) => d.name));
  return preAggregationsOf(doc).some((pa) => sqlName(`${alias}_${pa.sql_alias ?? pa.sqlAlias ?? pa.name}`).length > MAX_TABLE_STEM)
    || memberNamesOf(def, doc).some((m) => sqlName(`${alias}__${m}`).length + (times.has(m) ? GRANULARITY_SUFFIX : 0) > MAX_IDENTIFIER);
}

/**
 * The SQL alias xcube gives an item whose author wrote none, or none when its
 * name serves:
 * - a name with upper case has its lower-case form: Cube's planners snake-case
 *   a name into its alias (`OrderItems` and `order_items` would both be
 *   `order_items`, and `ORDERS` `o_r_d_e_r_s`);
 * - a cube on a data source other than Cube's default names it too, inherited
 *   ones included;
 * - a cube that extends another has one of its own, or Cube would give it its
 *   parent's (`CubeSymbols` sets the parent as its prototype);
 * - one that would make a rollup table stem or a member's alias too long is a
 *   short stable hash.
 */
function generatedAlias(entry: Entry, byName: Map<string, Entry>): string | undefined {
  const { def, doc } = entry;
  const lower = def.name.toLowerCase();
  const dataSource = def.kind === 'cube' ? aliasedDataSource(entry, byName) : undefined;
  let alias = aliasOf(lower, dataSource);
  if (tooLong(alias, def, doc)) {
    alias = `x${base32(dataSource === undefined ? def.name : `${def.name}@${dataSource}`, 7)}`;
  }
  const own = dataSource !== undefined || (def.kind === 'cube' && typeof doc.extends === 'string');
  return alias !== def.name || own ? alias : undefined;
}

/**
 * Each item's SQL alias, once every item of the publish is resolved. A kept
 * cube whose alias that changes (its parent published onto another data
 * source) is re-dumped with the new alias, and nothing else: its bindings
 * stay as published. Returns the keys of those.
 */
function assignAliases(entries: Entry[]): Set<string> {
  const byName = new Map(entries.map((entry) => [entry.def.name, entry]));
  const realiased = new Set<string>();
  entries
    .filter(({ def }) => def.doc.sql_alias === undefined && def.doc.sqlAlias === undefined)
    .forEach((entry) => {
      const { def, doc } = entry;
      const alias = generatedAlias(entry, byName);
      if (alias !== (doc.sql_alias ?? doc.sqlAlias)) {
        delete doc.sqlAlias;
        if (alias === undefined) {
          delete doc.sql_alias;
        } else {
          doc.sql_alias = alias;
        }
        if (!entry.resolved) {
          realiased.add(itemKey(def.name));
          entry.resolved = true;
        }
      }
    });
  return realiased;
}

/** What xcube adds to a resolved item: where it came from, in `meta.xcube`, for the folder gate and the client's pickers. */
function finish(def: ItemDefinition, doc: Record<string, any>) {
  const meta = doc.meta && typeof doc.meta === 'object' && !Array.isArray(doc.meta) ? doc.meta : {};
  doc.meta = { ...meta, xcube: { folderId: def.folderId, shortName: def.name } };
}

/**
 * The aliases Cube will build SQL and rollup tables from, checked across the
 * whole model: two cubes can't share one, and none may make a Postgres
 * identifier too long. A resolved cube's pre-aggregation whose table stem
 * would still be too long gets a short stable alias.
 */
function checkAliases(entries: Entry[]): ItemError[] {
  const errors: ItemError[] = [];
  const cubeAliases = new Map<string, string>();
  const tables = new Map<string, string>();

  for (const { def, doc, resolved } of entries) {
    const at = { folderId: def.folderId, name: def.name };
    const alias = sqlName(doc.sql_alias ?? doc.sqlAlias ?? doc.name);
    const other = cubeAliases.get(alias);
    if (other) {
      errors.push({ ...at, kind: 'alias', message: `Its SQL alias "${alias}" is also ${other}'s` });
    }
    cubeAliases.set(alias, def.name);

    for (const pa of preAggregationsOf(doc)) {
      let paAlias: string = pa.sql_alias ?? pa.sqlAlias ?? pa.name;
      if (resolved && sqlName(`${alias}_${paAlias}`).length > MAX_TABLE_STEM) {
        // Cube names a pre-aggregation's indexes after its alias when it has one
        // (PreAggregations.ts:417, 450), so only one without indexes may get one.
        const hasIndexes = Array.isArray(pa.indexes) ? pa.indexes.length > 0 : Boolean(pa.indexes);
        if (pa.sql_alias === undefined && pa.sqlAlias === undefined && !hasIndexes) {
          paAlias = `p${base32(`${def.name}.${pa.name}`, 6)}`;
          pa.sql_alias = paAlias;
        }
        if (sqlName(`${alias}_${paAlias}`).length > MAX_TABLE_STEM) {
          const room = MAX_TABLE_STEM - alias.length - 1;
          errors.push({
            ...at,
            kind: 'alias',
            message: `Pre-aggregation ${pa.name}'s rollup table name would be too long: shorten its name to at most ${room} characters`,
          });
        }
      }
      const table = sqlName(`${alias}_${paAlias}`);
      const owner = tables.get(table);
      if (owner) {
        errors.push({ ...at, kind: 'alias', message: `Pre-aggregation ${pa.name} would share its table ${table} with ${owner}` });
      }
      tables.set(table, `${def.name}.${pa.name}`);
    }

    if (resolved) {
      const times = new Set<string>((Array.isArray(doc.dimensions) ? doc.dimensions : [])
        .filter((d: any) => d?.type === 'time').map((d: any) => d.name));
      for (const member of memberNamesOf(def, doc)) {
        if (sqlName(`${alias}__${member}`).length + (times.has(member) ? GRANULARITY_SUFFIX : 0) > MAX_IDENTIFIER) {
          errors.push({ ...at, kind: 'alias', message: `Member ${member}'s SQL alias would be longer than ${MAX_IDENTIFIER} characters; shorten the name` });
        }
      }
    }
  }
  return errors;
}

/** The views Cube makes of a view's `split` entries: `<view>_<alias or cube>` (CubeSymbols.ts:943, 1018). */
function splitViewNames(def: ItemDefinition): string[] {
  if (def.kind !== 'view' || !Array.isArray(def.doc.cubes)) {
    return [];
  }
  return def.doc.cubes
    .filter((entry: any) => entry?.split)
    .map((entry: any) => {
      const joinPath = entry.join_path ?? entry.joinPath;
      return `${def.name}_${entry.alias ?? (typeof joinPath === 'string' ? joinPath.split('.').pop()!.trim() : '')}`;
    });
}

/** The refusal of a name another item holds: it names the caller's item, never where the other is (R71 2.3). */
function inUse(item: { folderId: string; name: string }, message = `The name "${item.name}" is already in use`): ItemError {
  return { folderId: item.folderId, name: item.name, kind: 'name_in_use', message };
}

/**
 * Names are one per model, in any case (R71 2.1): no resolved item, nor a
 * view Cube makes of one's `split`, may take a name a kept item, or another
 * resolved one, holds.
 */
function checkNames(defs: ItemDefinition[], resolved: Set<string>): ItemError[] {
  const errors: ItemError[] = [];
  const isResolved = (def: ItemDefinition) => resolved.has(itemKey(def.name));
  // Every item's name, and the split views of kept ones: a resolved view's split may take none of them.
  const taken = new Set(defs.map((def) => nameKey(def.name)));
  const keptSplits = new Set(defs.filter((def) => !isResolved(def)).flatMap((def) => splitViewNames(def).map(nameKey)));
  keptSplits.forEach((name) => taken.add(name));
  for (const def of defs.filter(isResolved)) {
    for (const name of splitViewNames(def)) {
      if (taken.has(nameKey(name))) {
        errors.push(inUse(def, `Its split view "${name}" would take a name already in use`));
      }
      taken.add(nameKey(name));
    }
    if (keptSplits.has(nameKey(def.name))) {
      errors.push(inUse(def));
    }
  }
  return errors;
}

/**
 * The cubes whose data source isn't in their folder or an ancestor of it
 * (R71 4.1), inherited ones included (4.4). A data source the model doesn't
 * hold is left to the binding's own refusal.
 */
function checkRanges(
  entries: Entry[],
  tree: FolderTree,
  dataSources: { folderId: string; name: string }[],
  checked: (entry: Entry) => boolean = () => true,
): ItemError[] {
  const folderOf = new Map(dataSources.map((d) => [d.name, d.folderId]));
  const byName = new Map(entries.map((entry) => [entry.def.name, entry]));
  const errors: ItemError[] = [];
  for (const entry of entries.filter((e) => e.def.kind === 'cube' && checked(e))) {
    const { name, from } = usedDataSource(entry, byName);
    const folder = folderOf.get(name);
    if (name !== 'default' && folder !== undefined && !tree.chain(entry.def.folderId).includes(folder)) {
      const through = from === entry ? '' : ` (through ${from.def.name}, which it extends)`;
      errors.push({
        folderId: entry.def.folderId,
        name: entry.def.name,
        kind: 'data_source_range',
        message: `It uses the data source "${name}"${through}, which isn't in its folder or one of its ancestors`,
      });
    }
  }
  return errors;
}

/**
 * The items referring to one outside their folder and its ancestors (R72):
 * a join, `extends`, a view's join path, `{cube.member}` or `FILTER_PARAMS`,
 * as their bindings record. A name only resolved up the path before names
 * were one per model; now it is checked. The refusal names the referrer and
 * what it refers to, never where that is.
 */
function checkReferences(
  entries: Entry[],
  tree: FolderTree,
  bindingsOf: (entry: Entry) => Record<string, string>,
  checked: (entry: Entry) => boolean = () => true,
): ItemError[] {
  const folderOf = new Map(entries.map((entry) => [entry.def.name, entry.def.folderId]));
  const errors: ItemError[] = [];
  for (const entry of entries.filter(checked)) {
    const path = tree.chain(entry.def.folderId);
    const outside = [...new Set(Object.values(bindingsOf(entry)))]
      .filter((target) => target !== entry.def.name && folderOf.has(target) && !path.includes(folderOf.get(target)!))
      .sort();
    if (outside.length) {
      errors.push({
        folderId: entry.def.folderId,
        name: entry.def.name,
        kind: 'reference_range',
        message: `It refers to ${outside.map((n) => `"${n}"`).join(', ')}, which ${outside.length === 1 ? 'isn\'t' : 'aren\'t'} in its folder or one of its ancestors`,
      });
    }
  }
  return errors;
}

/** Checks a cube's own `data_source`: a data source of the model, by its name (the root's `default` is always one). */
function checkDataSource(def: ItemDefinition, doc: Record<string, any>, dataSources: { folderId: string; name: string }[]): ItemError | undefined {
  const key = ['data_source', 'dataSource'].find((k) => doc[k] !== undefined);
  if (!key) {
    return undefined;
  }
  const at = { folderId: def.folderId, name: def.name };
  const named = doc[key];
  if (typeof named !== 'string' || !named) {
    return { ...at, kind: 'reference', message: 'data_source must name a data source' };
  }
  if (named !== 'default' && !dataSources.some((d) => d.name === named)) {
    return { ...at, kind: 'reference', message: `It uses the data source "${named}", which the model doesn't hold` };
  }
  return undefined;
}

/**
 * Applies a changeset (or a whole snapshot) to the current items: an item is
 * its name, wherever it is (R71). An upsert of a published item's name in
 * its folder is its edit; in another folder, a clash, unless the changeset
 * deletes the published one (a move, 2.7), or the upserts are an overlay's,
 * whose items stand in for published ones of their names (2.6). Every other
 * item is kept as published, and nothing kept may lose what it refers to.
 */
export function publish({
  tree, current, upserts, deletes, replaceAll, lenientDeletes, overlay, dataSources,
}: PublishInput): PublishResult {
  const errors: ItemError[] = [];
  const what = overlay ? 'overlay' : 'changeset';

  // What is written must be in the tree; what is deleted need not be, as a snapshot drops a
  // folder and its items together (a delete of an item that isn't there is refused below).
  for (const item of upserts) {
    if (!tree.has(item.folderId)) {
      errors.push({ folderId: item.folderId, name: item.name, kind: 'folder', message: `Folder ${item.folderId} is not in the folder tree` });
    }
  }
  const upserted = new Map<string, AuthoredItem>();
  for (const item of upserts) {
    const key = itemKey(String(item.name));
    const other = upserted.get(key);
    if (other && other.folderId === item.folderId && other.name === item.name) {
      errors.push({ folderId: item.folderId, name: item.name, kind: 'item', message: `The item is in the ${what} twice` });
    } else if (other) {
      errors.push(inUse(item, `The ${what} holds two items named "${item.name}" (in ${other.folderId} and ${item.folderId}); names are one per model`));
    }
    upserted.set(key, item);
  }
  if (errors.length) {
    return { items: current, changed: [], errors };
  }

  const kept = new Map<string, PublishedItem>();
  if (!replaceAll) {
    current.forEach((item) => kept.set(itemKey(item.name), item));
    for (const { folderId, name } of deletes) {
      const known = kept.get(itemKey(name));
      if (known && known.folderId === folderId && known.name === name) {
        kept.delete(itemKey(name));
      } else if (!lenientDeletes) {
        errors.push({ folderId, name, kind: 'item', message: 'There is no such item to delete' });
      }
    }
    for (const [key, item] of upserted) {
      const known = kept.get(key);
      if (known && !overlay && (known.folderId !== item.folderId || known.name !== item.name)) {
        // Its name is another item's, or a landed name in another case: names never change (R71 5.1).
        errors.push(known.folderId === item.folderId
          ? inUse(item, `The name "${item.name}" is in use as "${known.name}": a landed name can't change, not even its case`)
          : inUse(item));
      }
      kept.delete(key);
    }
  }
  if (errors.length) {
    return { items: current, changed: [], errors };
  }

  // Parse every item: the changed ones to resolve, the others for their members and names.
  const defs = new Map<string, ItemDefinition>();
  for (const item of [...kept.values(), ...upserted.values()]) {
    const { def, errors: parseErrors } = parseItem(item);
    errors.push(...parseErrors);
    if (def) {
      defs.set(itemKey(item.name), def);
    }
  }
  if (errors.length) {
    return { items: current, changed: [], errors };
  }
  errors.push(...checkNames([...defs.values()], new Set(upserted.keys())));

  const scope = new Scope([...defs.values()]);

  // Nothing kept may lose what it refers to.
  const names = new Set([...defs.values()].map((d) => d.name));
  const referrers = new Map<string, string[]>();
  for (const item of kept.values()) {
    for (const target of Object.values(item.bindings)) {
      if (!names.has(target)) {
        referrers.set(target, [...(referrers.get(target) ?? []), item.name]);
      }
    }
  }
  for (const [target, by] of referrers) {
    const gone = current.find((item) => item.name === target);
    errors.push({
      folderId: gone?.folderId ?? null,
      name: gone?.name ?? null,
      kind: 'reference',
      message: `${target} can't be removed: ${by.sort().join(', ')} refer${by.length === 1 ? 's' : ''} to it`,
    });
  }

  const resolvedDocs = new Map<string, Record<string, any>>();
  const newBindings = new Map<string, Record<string, string>>();
  for (const [key] of upserted) {
    const def = defs.get(key)!;
    const { doc, bindings, errors: rewriteErrors } = rewriteReferences(def, scope);
    errors.push(...rewriteErrors);
    if (dataSources && def.kind === 'cube') {
      const dataSourceError = checkDataSource(def, doc, dataSources);
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
  if (!errors.length) {
    // An overlay's own items are checked; published ones it stands in for are when it lands (R71 2.6).
    const checked = (entry: Entry) => !overlay || entry.resolved;
    const bindingsOf = (entry: Entry) => newBindings.get(itemKey(entry.def.name)) ?? kept.get(itemKey(entry.def.name))?.bindings ?? {};
    errors.push(...checkReferences(entries, tree, bindingsOf, checked));
    if (dataSources) {
      errors.push(...checkRanges(entries, tree, dataSources, checked));
    }
  }
  const realiased = assignAliases(entries);
  errors.push(...checkAliases(entries));
  if (errors.length) {
    return { items: current, changed: [], errors };
  }

  const items: PublishedItem[] = entries.map(({ def, doc, resolved }) => {
    const key = itemKey(def.name);
    if (!resolved) {
      return kept.get(key)!;
    }
    if (realiased.has(key)) {
      return { ...kept.get(key)!, resolvedYaml: dump(def.kind, doc) };
    }
    const authored = upserted.get(key)!;
    return {
      ...authored,
      fullName: def.name,
      bindings: newBindings.get(key)!,
      resolvedYaml: dump(def.kind, doc),
    };
  }).sort((a, b) => (a.name < b.name ? -1 : 1));

  return { items, changed: [...upserted.keys(), ...realiased], errors: [] };
}

/**
 * What of a published revision a folder push or a data source moved would
 * carry out of range: the cubes whose data source would be outside their
 * folder's (R71 4.1), and the items referring to one outside it (R72).
 */
export function outOfRange(
  items: PublishedItem[],
  tree: FolderTree,
  dataSources: { folderId: string; name: string }[],
): { cubes: string[]; items: string[] } {
  const bindings = new Map(items.map((item) => [item.name, item.bindings]));
  const entries: Entry[] = items.map((item) => ({
    def: { folderId: item.folderId, name: item.name, kind: item.kind, fullName: item.name, doc: {}, members: new Set<string>() },
    doc: (yaml.load(item.resolvedYaml) as any)[listKeyOf(item.kind)][0],
    resolved: false,
  }));
  return {
    cubes: checkRanges(entries, tree, dataSources).map((e) => e.name!).sort(),
    items: checkReferences(entries, tree, (entry) => bindings.get(entry.def.name) ?? {}).map((e) => e.name!).sort(),
  };
}

/** The files Cube compiles: one per item, named by its name. */
export function filesOf(items: PublishedItem[]): SnapshotFile[] {
  return items.map((item) => ({ path: `${item.name}.yml`, content: item.resolvedYaml }));
}

/**
 * The identity of an item set, as the client can compute it: the SHA-256 of
 * the items sorted by folder and name, as the JSON
 * `[{"folderId","name","kind","yaml"}, …]`.
 */
export function itemsHash(items: AuthoredItem[]): string {
  const sortKey = (i: AuthoredItem) => `${i.folderId}/${i.name}`;
  const sorted = [...items]
    .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))
    .map(({ folderId, name, kind, yaml: text }) => ({ folderId, name, kind, yaml: text }));
  return crypto.createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
}
