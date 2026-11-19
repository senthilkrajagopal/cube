import { COMMONS, groupModules, moduleIndex, packSmall, type GraphNode } from '../../src/modules/graph';

const zoneOf = (folderId: string) => folderId.split('/')[0];
const node = (fullName: string, folderId: string, references: string[] = [], kind: 'cube' | 'view' = 'cube'): GraphNode => (
  { fullName, folderId, kind, references }
);
const small = { packMin: 1, packMax: 300 };

describe('groupModules', () => {
  test('connected items form one module; unrelated ones form their own', () => {
    const modules = groupModules([
      node('orders', 'a', ['customers']),
      node('customers', 'a'),
      node('returns', 'b'),
    ], zoneOf, [], small);
    expect(modules.map((m) => m.members)).toEqual(expect.arrayContaining([['customers', 'orders'], ['returns']]));
    expect(modules).toHaveLength(2);
  });

  test('a cube used from two zones is shared: copied with what it references, and in commons', () => {
    const modules = groupModules([
      node('dates', 'root', ['calendar']),
      node('calendar', 'root'),
      node('sales', 'a', ['dates']),
      node('marketing', 'b', ['dates']),
    ], zoneOf, [], small);
    const { owner, holders } = moduleIndex(modules);
    expect(owner.get('sales')).not.toBe(owner.get('marketing'));
    expect(owner.get('dates')).toBe(COMMONS);
    const salesModule = modules.find((m) => m.members.includes('sales'))!;
    expect(salesModule.copies).toEqual(['calendar', 'dates']);
    expect([...holders.get('dates')!].sort()).toEqual([COMMONS, owner.get('marketing'), owner.get('sales')].sort());
    // calendar is only used by the shared dates: it stays in its own group, and is copied with dates.
    expect(modules.find((m) => m.id === COMMONS)!.copies).toEqual(['calendar']);
  });

  test('a view joining two facts through a shared cube merges them', () => {
    const modules = groupModules([
      node('dates', 'root'),
      node('sales', 'a', ['dates']),
      node('marketing', 'b', ['dates']),
      node('both', 'a', ['sales', 'marketing'], 'view'),
    ], zoneOf, [], small);
    const { owner } = moduleIndex(modules);
    expect(owner.get('sales')).toBe(owner.get('marketing'));
    expect(owner.get('both')).toBe(owner.get('sales'));
  });

  test('the override: shared false keeps a cube grouped; shared true shares it', () => {
    const nodes = [node('dates', 'root'), node('sales', 'a', ['dates']), node('marketing', 'b', ['dates'])];
    const unshared = groupModules([{ ...nodes[0], shared: false }, nodes[1], nodes[2]], zoneOf, [], small);
    expect(unshared).toHaveLength(1);
    const forced = groupModules([
      { ...node('lookup', 'a'), shared: true },
      node('sales', 'a', ['lookup']),
    ], zoneOf, [], small);
    expect(moduleIndex(forced).owner.get('lookup')).toBe(COMMONS);
  });

  test('small components are packed, same zone first, up to packMax', () => {
    const nodes = ['a/1', 'a/2', 'b/1', 'b/2', 'b/3'].map((f, i) => node(`c${i}`, f));
    const modules = groupModules(nodes, zoneOf, [], { packMin: 5, packMax: 3 });
    expect(modules.map((m) => m.members)).toEqual(expect.arrayContaining([['c0', 'c1', 'c2'], ['c3', 'c4']]));
  });

  test('module ids are kept across changes by greatest overlap', () => {
    const first = groupModules([
      node('orders', 'a', ['customers']), node('customers', 'a'), node('returns', 'b'),
    ], zoneOf, [], small);
    const ordersId = moduleIndex(first).owner.get('orders')!;
    const returnsId = moduleIndex(first).owner.get('returns')!;

    // A new cube joins orders' group; returns is untouched; a new unrelated cube appears.
    const second = groupModules([
      node('orders', 'a', ['customers']), node('customers', 'a'), node('items', 'a', ['orders']),
      node('returns', 'b'), node('fresh', 'c'),
    ], zoneOf, first, small);
    const index = moduleIndex(second);
    expect(index.owner.get('items')).toBe(ordersId);
    expect(index.owner.get('returns')).toBe(returnsId);
    expect(index.owner.get('fresh')).not.toBe(ordersId);
    expect(new Set(second.map((m) => m.id)).size).toBe(second.length);
  });

  test('a split keeps the id on the larger piece', () => {
    const first = groupModules([
      node('a1', 'a', ['a2']), node('a2', 'a', ['a3']), node('a3', 'a'), node('b1', 'a', ['a3']),
    ], zoneOf, [], small);
    const [{ id }] = first;
    const second = groupModules([
      node('a1', 'a', ['a2']), node('a2', 'a', ['a3']), node('a3', 'a'), node('b1', 'a'),
    ], zoneOf, first, small);
    const index = moduleIndex(second);
    expect(index.owner.get('a1')).toBe(id);
    expect(index.owner.get('b1')).not.toBe(id);
  });

  test('adding items leaves the packs they don\'t join as they were', () => {
    const options = { packMin: 50, packMax: 3 };
    const named = (names: string[]) => names.map((n) => node(n, 'a'));
    const first = groupModules(named(['c1', 'c3', 'c5', 'c7', 'c9', 'd1']), zoneOf, [], options);
    expect(first.map((m) => m.members)).toEqual(expect.arrayContaining([['c1', 'c3', 'c5'], ['c7', 'c9', 'd1']]));
    // New names sorting among the old: packed by order alone, every pack would shift.
    const second = groupModules(named(['c1', 'c2', 'c3', 'c4', 'c5', 'c7', 'c9', 'd1']), zoneOf, first, options);
    expect(second.filter((m) => first.some((f) => f.id === m.id && f.members.join() === m.members.join()))).toHaveLength(2);
    expect(second.map((m) => m.members)).toEqual(expect.arrayContaining([['c2', 'c4']]));
    // A pack with room takes new items of its zone before a new pack starts.
    const third = groupModules(named(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c9', 'd1']), zoneOf, second, options);
    expect(third).toHaveLength(3);
    expect(third.find((m) => m.members.includes('c6'))!.members).toEqual(['c2', 'c4', 'c6']);
  });

  test('packing keeps a pack under packMax, and packs a zone\'s new items with it first', () => {
    const zone = (members: string[]) => members[0][0];
    const previous = new Map([['a1', 'm1'], ['a2', 'm1'], ['a3', 'm1'], ['b1', 'm2']]);
    // m1 can keep two of its three under a packMax of 2; the third goes with the new ones.
    expect(packSmall([['a1'], ['a2'], ['a3'], ['b1'], ['b2'], ['a4']], zone, previous, 2))
      .toEqual([['a1', 'a2'], ['b1', 'b2'], ['a3', 'a4']]);
    // From nothing: as before, in order of zone and first member, each pack filled before the next starts.
    expect(packSmall([['b1'], ['a2'], ['a1'], ['b2', 'b3']], zone, new Map(), 3)).toEqual([['a1', 'a2', 'b1'], ['b2', 'b3']]);
  });
});
