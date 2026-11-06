import { prepareCompiler } from '@cubejs-backend/schema-compiler';

import { installKeylessJoins, KeylessJoinGraph } from '../../src/model/joins';

installKeylessJoins();

/** A cube on table `t` with the measures and joins given, and a key when `key` is set. */
const cube = (name: string, { optIn = false, key = false, joins = [] as [string, string][], measures = ['count: count'] } = {}) => [
  `  - name: ${name}`,
  `    sql_table: ${name}`,
  ...(optIn ? ['    meta:', '      xcube_keyless_joins: true'] : []),
  ...(joins.length ? ['    joins:', ...joins.flatMap(([to, relationship]) => [
    `      - name: ${to}`,
    `        relationship: ${relationship}`,
    `        sql: "{CUBE}.k = {${to}}.k"`,
  ])] : []),
  '    dimensions:',
  '      - name: k',
  '        sql: k',
  '        type: string',
  ...(key ? ['        primary_key: true'] : []),
  '    measures:',
  ...measures.flatMap((m) => {
    const [measure, type, sql = 'v'] = m.split(/:\s*|\s+on\s+/);
    return [`      - name: ${measure}`, `        type: ${type}`, ...(type === 'count' ? [] : [`        sql: "${sql}"`])];
  }),
].join('\n');

/** H, unique on its key, with no measures, as wechart writes it. */
const helper = (joins: [string, string][] = []) => cube('h', { key: true, joins, measures: [] }).replace('    measures:', '');

async function compile(...cubes: string[]) {
  const content = `cubes:\n${cubes.join('\n')}\n`;
  const prepared = prepareCompiler({
    localPath: () => '/nowhere',
    dataSchemaFiles: async () => [{ fileName: 'cubes/model.yml', content }],
  }, { standalone: true, allowNodeRequire: false });
  try {
    await prepared.compiler.compile();
  } catch (e: any) {
    return { ...prepared, error: e.message as string };
  }
  return { ...prepared, error: undefined };
}

const required = (name: string) => `primary key for '${name}' is required when join is defined`;

describe('keyless joins', () => {
  test('a cube with no key joins many_to_one when it opts in, and counts its rows once', async () => {
    const { error, joinGraph } = await compile(cube('a', { optIn: true, joins: [['h', 'many_to_one']], measures: ['count: count', 'total: sum'] }), helper());
    expect(error).toBeUndefined();
    expect(joinGraph).toBeInstanceOf(KeylessJoinGraph);
    expect(joinGraph.buildJoin(['a', 'h'])?.multiplicationFactor.a).toBe(false);
  });

  test('without the opt-in, Cube refuses the join as it always has', async () => {
    expect((await compile(cube('a', { joins: [['h', 'many_to_one']] }), helper())).error).toContain(required('a'));
    const notTrue = cube('a', { optIn: true, joins: [['h', 'many_to_one']] }).replace('xcube_keyless_joins: true', 'xcube_keyless_joins: "true"');
    expect((await compile(notTrue, helper())).error).toContain(required('a'));
  });

  test('one_to_one joins too', async () => {
    expect((await compile(cube('a', { optIn: true, joins: [['h', 'one_to_one']] }), helper())).error).toBeUndefined();
  });

  test('a one_to_many join from the cube is still refused, and its many_to_one kept', async () => {
    const { error } = await compile(
      cube('a', { optIn: true, joins: [['h', 'many_to_one'], ['x', 'one_to_many']] }),
      helper(),
      cube('x', { key: true }),
    );
    expect(error).toContain(required('a'));
    expect(error).not.toContain('can repeat its rows');
  });

  test('a join to the cube is still refused', async () => {
    const { error } = await compile(
      cube('a', { optIn: true, joins: [['h', 'many_to_one']] }),
      helper(),
      cube('b', { key: true, joins: [['a', 'many_to_one']] }),
    );
    expect(error).toContain(required('a'));
  });

  test('refused when a join beyond the cube it joins can repeat its rows', async () => {
    const { error } = await compile(
      cube('a', { optIn: true, joins: [['h', 'many_to_one']] }),
      helper([['x', 'one_to_many']]),
      cube('x', { key: true }),
    );
    expect(error).toContain('primary key for \'a\' is required: it joins with meta xcube_keyless_joins, '
      + 'but the hasMany join from \'h\' to \'x\' can repeat its rows');
  });

  test('a join into a cube it reaches, from a cube it can\'t, is no matter', async () => {
    // x reaches h, but no join tree holds both a and x: none reaches the other.
    const { error } = await compile(
      cube('a', { optIn: true, joins: [['h', 'many_to_one']] }),
      helper(),
      cube('x', { key: true, joins: [['h', 'many_to_one']] }),
    );
    expect(error).toBeUndefined();
  });

  test('a join into a cube it reaches, from another cube it reaches, is refused', async () => {
    // a reaches y and h, and in a tree of a -> h, a -> y and y -> h Cube counts a's rows repeated.
    const { error } = await compile(
      cube('a', { optIn: true, joins: [['h', 'many_to_one'], ['y', 'many_to_one']] }),
      helper(),
      cube('y', { key: true, joins: [['h', 'many_to_one']] }),
    );
    expect(error).toContain('can repeat its rows');
  });

  test('a cube with a key, or with no measure a join repeats, is Cube\'s alone', async () => {
    expect((await compile(cube('a', { optIn: true, key: true, joins: [['h', 'many_to_one'], ['x', 'one_to_many']] }), helper(), cube('x', { key: true }))).error).toBeUndefined();
    expect((await compile(cube('a', { optIn: true, joins: [['x', 'one_to_many']], measures: ['top: max'] }), cube('x', { key: true }))).error).toBeUndefined();
  });

  test('the opt-in keeps a join for every measure Cube would refuse it for', async () => {
    // Every measure type Cube knows, and a count(*) under another: Cube refuses
    // a keyless cube's join for some, and with the opt-in each joins.
    const measures = ['count: count', 'total: sum', 'mean: avg', 'ratio: number', 'top: max', 'least: min',
      'distinct: count_distinct', 'approx: count_distinct_approx', 'rows: max on count(*)'];
    const refused: string[] = [];
    for (const [i, measure] of measures.entries()) {
      const name = `m${i}`;
      const without = await compile(cube(name, { joins: [['h', 'many_to_one']], measures: [measure] }), helper());
      if (without.error?.includes(required(name))) {
        refused.push(measure);
      }
      const opted = await compile(cube(name, { optIn: true, joins: [['h', 'many_to_one']], measures: [measure] }), helper());
      expect([measure, opted.error]).toEqual([measure, undefined]);
    }
    expect(refused).toEqual(['count: count', 'total: sum', 'mean: avg', 'ratio: number', 'rows: max on count(*)']);
  });
});
