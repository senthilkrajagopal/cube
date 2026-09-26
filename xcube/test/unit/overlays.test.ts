import yaml from 'js-yaml';

import type { PublishedItem } from '../../src/names/items';
import { reachedBy, withoutRollups } from '../../src/overlays/rollups';
import { boundDataSource, markedDataSources, overlayOfAppId, withDataSourceMark } from '../../src/overlays/connections';

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

describe('overlay data sources', () => {
  const cube = (resolvedYaml: string): PublishedItem => ({ ...item('fa__orders'), resolvedYaml });

  test('the data source a published cube is bound to: its own, the root\'s default, or its parent\'s', () => {
    expect(boundDataSource(cube('cubes:\n  - name: fa__orders\n    data_source: fa__warehouse\n    sql_table: t\n'))).toBe('fa__warehouse');
    expect(boundDataSource(cube('cubes:\n  - data_source: "default"\n    name: fa__orders\n'))).toBe('default');
    expect(boundDataSource(cube('cubes:\n  - name: fa__orders\n    sql_table: t\n'))).toBe('default');
    expect(boundDataSource(cube('cubes:\n  - name: fa__orders\n    extends: fa__base\n'))).toBeNull();
    // A rollup's own keys are not the cube's.
    expect(boundDataSource(cube('cubes:\n  - name: fa__orders\n    pre_aggregations:\n      - name: main\n        data_source: x\n'))).toBe('default');
  });

  test('a mark gives a file its own content, and names the dialect it compiles in', () => {
    const file = { path: 'fa__orders.yml', content: 'cubes:\n  - name: fa__orders\n' };
    const marked = withDataSourceMark(file, 'fa__warehouse', 'snowflake');
    expect(marked.content).not.toBe(file.content);
    expect(marked.content.endsWith(file.content)).toBe(true);
    const files = [marked, withDataSourceMark({ path: 'b.yml', content: '' }, 'default', 'postgres'), file];
    expect(markedDataSources(files)).toEqual(new Map([['fa__warehouse', 'snowflake'], ['default', 'postgres']]));
    expect(markedDataSources([file]).size).toBe(0);
  });

  test('the overlay an app id serves', () => {
    expect(overlayOfAppId('xcube:dev:o:ws-1:42:t3@xcube:dev:7:abc')).toEqual({ model: 'dev', id: 'ws-1', version: 42 });
    expect(overlayOfAppId('xcube:dev:7:abc')).toBeUndefined();
    expect(overlayOfAppId('m:abc@1')).toBeUndefined();
  });
});
