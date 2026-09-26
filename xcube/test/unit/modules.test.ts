import { COMMONS, groupModules, moduleIndex, type GraphNode } from '../../src/modules/graph';

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
});
