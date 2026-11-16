/**
 * Cube's `extends`, matched as the cube's own key only (`src/model/exact-extends.js`):
 * a member whose name holds "extends" no longer fails the model, and a cube's
 * own `extends` still inherits. Compiled through Cube's transpiler worker pool.
 */
import { prepareCompiler } from '@cubejs-backend/schema-compiler';

// eslint-disable-next-line global-require
require('../../src/server');

async function compile(files: Record<string, string>) {
  const prepared = prepareCompiler({
    localPath: () => '/nowhere',
    dataSchemaFiles: async () => Object.entries(files).map(([fileName, content]) => ({ fileName, content })),
  }, { standalone: true, allowNodeRequire: false });
  try {
    await prepared.compiler.compile();
  } catch (e: any) {
    return { prepared, error: e.message as string };
  }
  return { prepared, error: undefined };
}

describe('`extends` is the cube\'s own key, not any name holding it', () => {
  test('members, a pre-aggregation and a nested key named with "extends" compile; YAML', async () => {
    const { error, prepared } = await compile({
      'cubes/a.yml': `cubes:
  - name: a
    sql_table: t
    dimensions:
      - { name: id, sql: id, type: number, primary_key: true }
      - { name: extends, sql: x, type: number }
      - { name: xextendsy, sql: x, type: number }
      - { name: extendsx, sql: x, type: string }
      - name: at
        sql: at
        type: time
        meta:
          extends_note: kept
    measures:
      - { name: xextends, type: count }
    pre_aggregations:
      - name: extends_daily
        measures: [xextends]
        time_dimension: at
        granularity: day
`,
    });
    expect(error).toBeUndefined();
    const a = prepared.cubeEvaluator.cubeFromPath('a');
    expect(Object.keys(a.dimensions)).toEqual(expect.arrayContaining(['extends', 'xextendsy', 'extendsx']));
    expect((a.dimensions.at as { meta?: unknown }).meta).toEqual({ extends_note: 'kept' });
    expect(Object.keys(a.preAggregations)).toEqual(['extends_daily']);
  });

  test('a cube\'s own extends still inherits, in YAML and in JavaScript', async () => {
    const { error, prepared } = await compile({
      'cubes/base.yml': `cubes:
  - name: base
    sql_table: t
    dimensions:
      - { name: id, sql: id, type: number, primary_key: true }
      - { name: xextendsy, sql: x, type: number }
`,
      'cubes/child.yml': `cubes:
  - name: child
    extends: base
    dimensions:
      - { name: extra, sql: y, type: string }
`,
      'cubes/js_child.js': `cube('js_child', {
  extends: base,
  dimensions: { more_extends: { sql: 'z', type: 'string' } },
});
`,
    });
    expect(error).toBeUndefined();
    expect(Object.keys(prepared.cubeEvaluator.cubeFromPath('child').dimensions)).toEqual(expect.arrayContaining(['id', 'xextendsy', 'extra']));
    expect(Object.keys(prepared.cubeEvaluator.cubeFromPath('js_child').dimensions)).toEqual(expect.arrayContaining(['id', 'xextendsy', 'more_extends']));
  });
});
