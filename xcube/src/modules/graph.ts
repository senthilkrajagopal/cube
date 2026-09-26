import crypto from 'crypto';

/** A published cube or view, as the module graph sees it. */
export interface GraphNode {
  fullName: string;
  folderId: string;
  kind: 'cube' | 'view';
  /** Full names of the items it is bound to, itself excluded. */
  references: string[];
  /** `true` or `false` overrides whether a cube is shared. */
  shared?: boolean;
}

/** One module: the items it owns, plus copies of the shared cubes they use. */
export interface Module {
  id: string;
  /** Items owned by this module (each item is owned by exactly one module). */
  members: string[];
  /** Shared cubes (and what they reference) this module compiles a copy of. */
  copies: string[];
}

export interface ModuleOptions {
  /** Components smaller than this are packed together. */
  packMin: number;
  /** A packed module holds at most this many items. */
  packMax: number;
}

export const DEFAULT_MODULE_OPTIONS: ModuleOptions = { packMin: 50, packMax: 300 };

export const COMMONS = 'commons';

class UnionFind {
  protected readonly parent = new Map<string, string>();

  public find(x: string): string {
    let root = x;
    while (this.parent.has(root) && this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression.
    let current = x;
    while (this.parent.has(current) && this.parent.get(current) !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }
    if (!this.parent.has(root)) {
      this.parent.set(root, root);
    }
    return root;
  }

  public union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      // Deterministic: the smaller name is the root.
      if (ra < rb) {
        this.parent.set(rb, ra);
      } else {
        this.parent.set(ra, rb);
      }
    }
  }
}

function newModuleId(members: string[]): string {
  const digest = crypto.createHash('sha256').update([...members].sort().join('\n'), 'utf8').digest('hex');
  return `m${digest.slice(0, 10)}`;
}

/**
 * Groups items into modules that compile independently.
 *
 * - A cube used by items of two or more zones (the first folder under the
 *   root on their paths) is **shared**: it joins no group, and every module
 *   that uses it compiles a copy of it and of everything it references. The
 *   shared cubes also form the commons module.
 * - Everything else is grouped by connected components (union-find) over
 *   references, so every module is reference-closed and every valid query
 *   fits in one.
 * - Small components are packed together, same zone first.
 * - Module ids are kept from `previous` by greatest overlap, so a module that
 *   changes keeps its id; new ones are named after their members.
 */
export function groupModules(
  nodes: GraphNode[],
  zoneOf: (folderId: string) => string,
  previous: { id: string; members: string[] }[] = [],
  options: ModuleOptions = DEFAULT_MODULE_OPTIONS,
): Module[] {
  const byName = new Map(nodes.map((n) => [n.fullName, n]));
  const references = (n: GraphNode) => n.references.filter((r) => r !== n.fullName && byName.has(r));

  // Which zones use each item.
  const usedByZones = new Map<string, Set<string>>();
  for (const node of nodes) {
    for (const target of references(node)) {
      const zones = usedByZones.get(target) ?? new Set<string>();
      zones.add(zoneOf(node.folderId));
      usedByZones.set(target, zones);
    }
  }
  const shared = new Set(nodes.filter((n) => {
    if (n.kind !== 'cube') {
      return false;
    }
    if (n.shared !== undefined) {
      return n.shared;
    }
    return (usedByZones.get(n.fullName)?.size ?? 0) >= 2;
  }).map((n) => n.fullName));

  // What a shared cube carries into every module that copies it.
  const closure = (start: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const name = stack.pop()!;
      if (!seen.has(name)) {
        seen.add(name);
        stack.push(...references(byName.get(name)!));
      }
    }
    return seen;
  };

  const uf = new UnionFind();
  const owned = nodes.filter((n) => !shared.has(n.fullName));
  for (const node of owned) {
    uf.find(node.fullName);
    for (const target of references(node)) {
      if (!shared.has(target)) {
        uf.union(node.fullName, target);
      }
    }
  }

  const components = new Map<string, string[]>();
  for (const node of owned) {
    const root = uf.find(node.fullName);
    components.set(root, [...(components.get(root) ?? []), node.fullName]);
  }

  // Pack small components, same zone first, into modules of at most packMax items.
  const large: string[][] = [];
  const small: string[][] = [];
  for (const members of components.values()) {
    (members.length < options.packMin ? small : large).push(members.sort());
  }
  const zoneOfGroup = (members: string[]) => zoneOf(byName.get(members[0])!.folderId);
  const orderOf = (members: string[]) => `${zoneOfGroup(members)}\u0000${members[0]}`;
  small.sort((a, b) => (orderOf(a) < orderOf(b) ? -1 : 1));
  const packed: string[][] = [];
  let pack: string[] = [];
  for (const members of small) {
    if (pack.length && pack.length + members.length > options.packMax) {
      packed.push(pack);
      pack = [];
    }
    pack = pack.concat(members);
  }
  if (pack.length) {
    packed.push(pack);
  }
  const groups = [...large, ...packed].map((members) => members.sort());

  // Stable ids: the new group that overlaps a previous module most keeps its id.
  const previousOf = new Map<string, string>();
  previous.forEach((module) => module.id !== COMMONS && module.members.forEach((m) => previousOf.set(m, module.id)));
  const overlaps: { group: number; id: string; count: number }[] = [];
  groups.forEach((members, group) => {
    const counts = new Map<string, number>();
    members.forEach((m) => {
      const id = previousOf.get(m);
      if (id) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    });
    counts.forEach((count, id) => overlaps.push({ group, id, count }));
  });
  overlaps.sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1) || a.group - b.group);
  const idOfGroup = new Map<number, string>();
  const taken = new Set<string>();
  for (const { group, id } of overlaps) {
    if (!idOfGroup.has(group) && !taken.has(id)) {
      idOfGroup.set(group, id);
      taken.add(id);
    }
  }

  const modules: Module[] = groups.map((members, group) => {
    const copies = new Set<string>();
    for (const member of members) {
      for (const target of references(byName.get(member)!)) {
        if (shared.has(target)) {
          closure(target).forEach((c) => copies.add(c));
        }
      }
    }
    members.forEach((m) => copies.delete(m));
    let id = idOfGroup.get(group) ?? newModuleId(members);
    while (taken.has(id) && idOfGroup.get(group) !== id) {
      id = newModuleId([...members, id]);
    }
    taken.add(id);
    return { id, members, copies: [...copies].sort() };
  });

  if (shared.size) {
    const commonsMembers = [...shared].sort();
    const copies = new Set<string>();
    commonsMembers.forEach((s) => closure(s).forEach((c) => copies.add(c)));
    commonsMembers.forEach((m) => copies.delete(m));
    modules.push({ id: COMMONS, members: commonsMembers, copies: [...copies].sort() });
  }

  return modules.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** For routing: the module owning each item, and every module holding it (owned or copied). */
export function moduleIndex(modules: Module[]) {
  const owner = new Map<string, string>();
  const holders = new Map<string, Set<string>>();
  for (const module of modules) {
    for (const name of [...module.members, ...module.copies]) {
      const set = holders.get(name) ?? new Set<string>();
      set.add(module.id);
      holders.set(name, set);
    }
    module.members.forEach((m) => owner.set(m, module.id));
  }
  return { owner, holders };
}
