import yaml from 'js-yaml';

import type { PublishedItem } from '../../src/names/items';
import { reachedBy, withoutRollups } from '../../src/overlays/rollups';

const item = (fullName: string, bindings: Record<string, string> = {}): PublishedItem => ({
  folderId: 'froot', name: fullName, kind: 'cube', yaml: '', fullName, bindings, resolvedYaml: '',
});

describe('overlay rollups', () => {
  test('what an overlay\'s changes reach: the changed items, and every item bound to one, however indirectly', () => {
    const items = [
      item('a'),
      item('b', { a: 'a' }),
      item('c', { b: 'b', c: 'c' }),
      item('d', { e: 'e' }),
      item('e'),
    ];
    expect([...reachedBy(items, new Set(['a']))].sort()).toEqual(['a', 'b', 'c']);
    expect([...reachedBy(items, new Set(['e']))].sort()).toEqual(['d', 'e']);
    expect([...reachedBy(items, new Set())]).toEqual([]);
  });

  test('an item without its pre-aggregations; one without any is left as it is', () => {
    const file = {
      path: 'a.yml',
      content: yaml.dump({ cubes: [{ name: 'a', sql_table: 't', pre_aggregations: [{ name: 'main' }], measures: [{ name: 'count', type: 'count' }] }] }),
    };
    const stripped = yaml.load(withoutRollups(file).content) as any;
    expect(stripped.cubes[0]).toEqual({ name: 'a', sql_table: 't', measures: [{ name: 'count', type: 'count' }] });
    const plain = { path: 'v.yml', content: yaml.dump({ views: [{ name: 'v', cubes: [] }] }) };
    expect(withoutRollups(plain)).toBe(plain);
  });
});
