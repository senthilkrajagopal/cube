import inflection from 'inflection';
import {
  transpiledFields,
  transpiledFieldsPatterns,
} from '@cubejs-backend/schema-compiler/dist/src/compiler/transpilers/CubePropContextTranspiler';

import { applyReplacements, chainsIn, chainsInFString, type Chain, type Replacement } from './expr';
import type { ItemDefinition, ItemError } from './items';

/** Names every model can use that are never cubes: Cube's own symbols and the security context. */
const SYMBOLS = new Set([
  'CUBE', 'TABLE', 'FILTER_PARAMS', 'FILTER_GROUP', 'SQL_UTILS', 'SECURITY_CONTEXT', 'security_context',
  'securityContext', 'COMPILE_CONTEXT',
]);

/**
 * What a name means: the one item of that name in the model (R71). Names are
 * matched exactly, as Cube matches them (`CubeSymbols.resolveSymbol`): they
 * compare in any case only for uniqueness, so `{amount}` stays a member when
 * the model has a cube `Amount`.
 */
export class Scope {
  protected readonly byName = new Map<string, ItemDefinition>();

  public constructor(defs: ItemDefinition[]) {
    for (const def of defs) {
      this.byName.set(def.name, def);
    }
  }

  public resolve(name: string): ItemDefinition | undefined {
    return this.byName.get(name);
  }

  /** The item a definition extends, if there is one (never itself). */
  public parentOf(def: ItemDefinition): ItemDefinition | undefined {
    const parent = def.extendsName ? this.resolve(def.extendsName) : undefined;
    return parent === def ? undefined : parent;
  }

  /** Its members and every inherited one. */
  public membersOf(def: ItemDefinition): Set<string> {
    const members = new Set<string>();
    const seen = new Set<string>();
    for (let current: ItemDefinition | undefined = def; current && !seen.has(current.name);
      current = this.parentOf(current)) {
      seen.add(current.name);
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
 * An item with each reference to another cube or view checked and recorded
 * as a binding (a name means the one item of that name). Names that resolve
 * to nothing are left for Cube's compile to report, except where only a cube
 * can stand (joins, `extends`, join paths), which are errors here.
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
    const target = scope.resolve(name);
    if (target) {
      bindings[name] = target.name;
    }
    return target;
  };

  const rewriteChain = (chain: Chain, mode: Mode): Replacement[] => {
    const out: Replacement[] = [];
    const replace = (i: number, target: ItemDefinition) => {
      if (chain[i].text !== target.name) {
        out.push({ start: chain[i].start, stop: chain[i].stop, text: target.name });
      }
    };

    if (mode === 'joinPath') {
      chain.forEach((segment, i) => {
        const target = bind(segment.text);
        if (target) {
          replace(i, target);
        } else {
          errors.push({ ...at, kind: 'reference', message: `The join path names "${segment.text}", which is no cube of the model` });
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
      const target = bind(value);
      if (!target) {
        errors.push({ ...at, kind: 'reference', message: `The join to "${value}" names no cube of the model` });
        return value;
      }
      return target.name;
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
    const parent = bind(def.extendsName);
    if (parent === def) {
      errors.push({ ...at, kind: 'reference', message: 'It extends itself' });
    } else if (parent) {
      doc.extends = parent.name;
    } else {
      errors.push({ ...at, kind: 'reference', message: `It extends "${def.extendsName}", which is no cube or view of the model` });
    }
  }
  return { doc, bindings, errors };
}
