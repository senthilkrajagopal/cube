import inflection from 'inflection';
import {
  transpiledFields,
  transpiledFieldsPatterns,
} from '@cubejs-backend/schema-compiler/dist/src/compiler/transpilers/CubePropContextTranspiler';

import { applyReplacements, chainsIn, chainsInFString, type Chain, type Replacement } from './expr';
import { FolderTree, itemKey, type ItemDefinition, type ItemError } from './items';

/** Names every model can use that are never cubes: Cube's own symbols and the security context. */
const SYMBOLS = new Set([
  'CUBE', 'TABLE', 'FILTER_PARAMS', 'FILTER_GROUP', 'SQL_UTILS', 'SECURITY_CONTEXT', 'security_context',
  'securityContext', 'COMPILE_CONTEXT',
]);

/** What a short name means from a folder: the nearest item of that name, from the folder up to the root. */
export class Scope {
  protected readonly byKey = new Map<string, ItemDefinition>();

  protected readonly byFullName = new Map<string, ItemDefinition>();

  public constructor(
    protected readonly tree: FolderTree,
    defs: ItemDefinition[],
    /** Bindings items were published with; an item keeps its own until it is published again. */
    protected readonly bindingsOf: (def: ItemDefinition) => Record<string, string> | undefined = () => undefined,
    /**
     * An overlay's items by short name, which its own items' names resolve
     * to first, before their folder path (a workspace, AC-281).
     */
    protected readonly overlay?: Map<string, ItemDefinition>,
  ) {
    for (const def of defs) {
      this.byKey.set(itemKey(def.folderId, def.name), def);
      this.byFullName.set(def.fullName, def);
    }
  }

  /** The overlay item a name means to `from`, when `from` is in the overlay. */
  protected inOverlay(from: ItemDefinition | undefined, name: string): ItemDefinition | undefined {
    return from && this.overlay?.get(from.name) === from ? this.overlay.get(name) : undefined;
  }

  public resolve(folderId: string, name: string, from?: ItemDefinition): ItemDefinition | undefined {
    const first = this.inOverlay(from, name);
    if (first) {
      return first;
    }
    for (const folder of this.tree.chain(folderId)) {
      const def = this.byKey.get(itemKey(folder, name));
      if (def) {
        return def;
      }
    }
    return undefined;
  }

  public byFull(fullName: string): ItemDefinition | undefined {
    return this.byFullName.get(fullName);
  }

  /** The item of that name in exactly that folder. */
  public at(folderId: string, name: string): ItemDefinition | undefined {
    return this.byKey.get(itemKey(folderId, name));
  }

  public chainOf(folderId: string): string[] {
    return this.tree.chain(folderId);
  }

  /** The item a definition extends: through its own binding when it has one, else resolved now. */
  public parentOf(def: ItemDefinition): ItemDefinition | undefined {
    if (!def.extendsName) {
      return undefined;
    }
    const bound = this.bindingsOf(def)?.[def.extendsName];
    if (bound && this.byFullName.get(bound)) {
      return this.byFullName.get(bound);
    }
    const first = def.extendsName === def.name ? undefined : this.inOverlay(def, def.extendsName);
    if (first) {
      return first;
    }
    // An item never extends itself: its own name means an ancestor's namesake.
    const chain = this.tree.chain(def.folderId);
    for (const folder of def.extendsName === def.name ? chain.slice(1) : chain) {
      const found = this.byKey.get(itemKey(folder, def.extendsName));
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /** Its members and every inherited one. */
  public membersOf(def: ItemDefinition): Set<string> {
    const members = new Set<string>();
    const seen = new Set<string>();
    for (let current: ItemDefinition | undefined = def; current && !seen.has(current.fullName);
      current = this.parentOf(current)) {
      seen.add(current.fullName);
      current.members.forEach((m) => members.add(m));
    }
    return members;
  }
}

type Mode =
  /** A Python expression: cube-first for the first name, member-first after it (CubeSymbols.ts:1428, 1500-1523). */
  | 'expr'
  /** A view's join path: every name is a cube. */
  | 'joinPath'
  /** A literal `member`, `<cube>.member` or `<self>.member`: only the first name is a cube or the item itself. */
  | 'literalPath';

function isTranspiled(path: string[]): boolean {
  const last = path[path.length - 1];
  if (!transpiledFields.has(last)) {
    return false;
  }
  const joined = path.join('.');
  return transpiledFieldsPatterns.some((p) => p.test(joined));
}

/** Lists Cube keys by their items' names (`YamlCompiler.yamlArrayToObj`), so paths read as Cube's do. */
const NAMED_LISTS = new Set(['measures', 'dimensions', 'segments', 'preAggregations', 'hierarchies', 'indexes']);

/** A key as Cube reads it: camelized before any field is matched (`utils.ts` `camelizeKey`). */
const camel = (key: string) => inflection.camelize(key, true);

/**
 * An item with every reference to another cube or view rewritten to the
 * full name it resolves to, nearest-first from the item's own folder, with
 * each binding recorded. Names that resolve to nothing are left for Cube's
 * compile to report, except where only a cube can stand (joins, `extends`,
 * join paths), which are errors here.
 */
export function rewriteReferences(def: ItemDefinition, scope: Scope): {
  doc: Record<string, any>;
  bindings: Record<string, string>;
  errors: ItemError[];
} {
  const bindings: Record<string, string> = {};
  const errors: ItemError[] = [];
  const at = { folderId: def.folderId, name: def.name };

  const bind = (name: string): ItemDefinition | undefined => {
    const target = scope.resolve(def.folderId, name, def);
    if (target) {
      bindings[name] = target.fullName;
    }
    return target;
  };

  /**
   * Where only another item can stand (`extends`, a join, a view's join
   * path), the item's own name means the nearest *other* item of that name:
   * an override extending, or a view over, its ancestor's namesake.
   */
  const bindOther = (name: string): ItemDefinition | undefined => {
    if (name !== def.name) {
      return bind(name);
    }
    const [, ...ancestors] = scope.chainOf(def.folderId);
    for (const folder of ancestors) {
      const target = scope.at(folder, name);
      if (target) {
        bindings[name] = target.fullName;
        return target;
      }
    }
    return undefined;
  };

  /** A full name written by hand escapes resolution and the reference checks. */
  const refuseFullName = (name: string) => {
    if (name.includes('__') && scope.byFull(name) && name !== def.fullName) {
      errors.push({ ...at, kind: 'reference', message: `"${name}" is a full name; refer to it by its short name` });
    }
  };

  const rewriteChain = (chain: Chain, mode: Mode): Replacement[] => {
    const out: Replacement[] = [];
    const replace = (i: number, target: ItemDefinition) => {
      if (chain[i].text !== target.fullName) {
        out.push({ start: chain[i].start, stop: chain[i].stop, text: target.fullName });
      }
    };

    if (mode === 'joinPath') {
      chain.forEach((segment, i) => {
        refuseFullName(segment.text);
        const target = i === 0 ? bindOther(segment.text) : bind(segment.text);
        if (target) {
          replace(i, target);
        } else {
          errors.push({ ...at, kind: 'reference', message: `The join path names "${segment.text}", which no folder on this item's path holds` });
        }
      });
      return out;
    }

    if (mode === 'literalPath') {
      if (chain.length < 2) {
        return out;
      }
      const first = chain[0].text;
      const target = first === def.name ? def : bind(first);
      if (target) {
        replace(0, target);
      }
      return out;
    }

    const first = chain[0].text;
    if (first === 'FILTER_PARAMS') {
      const target = chain[1] && bind(chain[1].text);
      if (target) {
        replace(1, target);
      }
      return out;
    }

    let current: ItemDefinition | undefined;
    if (first === 'CUBE' || first === 'TABLE') {
      current = def;
    } else if (SYMBOLS.has(first)) {
      return out;
    } else {
      current = bind(first);
      if (!current) {
        // A member of this item, a context name, or something Cube will report.
        refuseFullName(first);
        return out;
      }
      replace(0, current);
    }

    for (let i = 1; i < chain.length && current && current.kind === 'cube'; i++) {
      // `.sql` is the cube's SQL before it is anything else (CubeSymbols.ts:1500).
      if (chain[i].text === 'sql' || scope.membersOf(current).has(chain[i].text)) {
        break;
      }
      const next = bind(chain[i].text);
      if (!next) {
        break;
      }
      replace(i, next);
      current = next;
    }
    return out;
  };

  const rewriteString = (text: string, mode: Mode, fString: boolean): string => {
    const chains = fString ? chainsInFString(text) : chainsIn(text);
    return applyReplacements(text, chains.flatMap((chain) => rewriteChain(chain, mode)));
  };

  /** How a field is read, from its path with keys camelized as Cube's are. */
  const modeFor = (path: string[]): Mode | 'skip' | 'fstring' | 'joinName' => {
    const joined = path.join('.');
    const last = path[path.length - 1];
    if (/^joins\.\d+\.name$/.test(joined)) {
      return 'joinName';
    }
    if (/^accessPolicy\.\d+\.(memberLevel|memberMasking)\.(includes|excludes)(\.\d+)?$/.test(joined)) {
      return 'literalPath';
    }
    if (!isTranspiled(path)) {
      return 'skip';
    }
    if (/^defaultFilters\.\d+\.(member|unless)$/.test(joined)) {
      return 'literalPath';
    }
    if (last === 'values') {
      return 'skip';
    }
    if (/^(cubes\.\d+|folders\.\d+\.includes\.\d+)\.joinPath$/.test(joined)) {
      return 'joinPath';
    }
    if (last === 'sql' || last === 'sqlTable') {
      return 'fstring';
    }
    return 'expr';
  };

  const rewriteLeaf = (value: string, path: string[]): string => {
    const mode = modeFor(path);
    if (mode === 'skip') {
      return value;
    }
    if (mode === 'joinName') {
      refuseFullName(value);
      const target = bindOther(value);
      if (!target) {
        errors.push({ ...at, kind: 'reference', message: `The join to "${value}" names no cube in a folder on this item's path` });
        return value;
      }
      return target.fullName;
    }
    if (mode === 'fstring') {
      return rewriteString(value, 'expr', true);
    }
    return rewriteString(value, mode, false);
  };

  const walk = (node: any, path: string[]): any => {
    if (typeof node === 'string') {
      return rewriteLeaf(node, path);
    }
    if (Array.isArray(node)) {
      const named = NAMED_LISTS.has(path[path.length - 1]);
      return node.map((child, i) => {
        if (typeof child === 'string') {
          // Each element of a list field is read as the list is (`YamlCompiler.transpileYaml`).
          const mode = modeFor(path);
          if (mode === 'skip' || mode === 'fstring' || mode === 'joinName') {
            return walk(child, path.concat(String(i)));
          }
          return rewriteString(child, mode, false);
        }
        const key = named && child && typeof child.name === 'string' ? child.name : String(i);
        return walk(child, path.concat(key));
      });
    }
    if (node && typeof node === 'object' && !(node instanceof Date)) {
      const out: Record<string, any> = {};
      // Granularities are keyed by their own names, which Cube doesn't camelize.
      const keepKeys = path.length === 2 && path[1] === 'granularities';
      for (const [key, value] of Object.entries(node)) {
        out[key] = key === 'meta' ? value : walk(value, path.concat(keepKeys ? key : camel(key)));
      }
      return out;
    }
    return node;
  };

  const doc = walk(def.doc, []);

  if (def.extendsName) {
    refuseFullName(def.extendsName);
    const parent = bindOther(def.extendsName);
    if (parent) {
      doc.extends = parent.fullName;
    } else {
      errors.push({ ...at, kind: 'reference', message: `It extends "${def.extendsName}", which no folder on this item's path holds` });
    }
  }
  doc.name = def.fullName;
  return { doc, bindings, errors };
}
