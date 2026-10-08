import yaml from 'js-yaml';
import { prepareCompiler } from '@cubejs-backend/schema-compiler';

import { chainsIn, chainsInFString } from '../../src/names/expr';
import { FolderTree, type AuthoredItem, type PublishedItem } from '../../src/names/items';
import { aliasOf, filesOf, itemsHash, outOfRange, publish, titleOf } from '../../src/names/publish';

const tree = new FolderTree([
  { id: 'froot', parentId: null },
  { id: 'fsales', parentId: 'froot' },
  { id: 'feu', parentId: 'fsales' },
  { id: 'fops', parentId: 'froot' },
]);

const cube = (folderId: string, name: string, body: string): AuthoredItem => ({
  folderId, name, kind: 'cube', yaml: `cubes:\n  - name: ${name}\n${body}`,
});
const view = (folderId: string, name: string, body: string): AuthoredItem => ({
  folderId, name, kind: 'view', yaml: `views:\n  - name: ${name}\n${body}`,
});

const customers = cube('froot', 'customers', [
  '    sql_table: public.customers',
  '    dimensions:',
  '      - name: id',
  '        sql: id',
  '        type: number',
  '        primary_key: true',
  '      - name: city',
  '        sql: city',
  '        type: string',
  '',
].join('\n'));

const orders = (folderId: string) => cube(folderId, 'orders', [
  '    sql_table: public.orders',
  '    joins:',
  '      - name: customers',
  '        sql: "{CUBE}.customer_id = {customers.id}"',
  '        relationship: many_to_one',
  '    dimensions:',
  '      - name: id',
  '        sql: id',
  '        type: number',
  '        primary_key: true',
  '      - name: status',
  '        sql: "{CUBE}.status"',
  '        type: string',
  '      - name: created_at',
  '        sql: created_at',
  '        type: time',
  '    measures:',
  '      - name: count',
  '        type: count',
  '        drill_members: [id, customers.city]',
  '      - name: amount',
  '        sql: "{FILTER_PARAMS.orders.created_at.filter(lambda a, b: f\'{CUBE}.created_at >= {a}\')} + amount"',
  '        type: sum',
  '    pre_aggregations:',
  '      - name: by_city',
  '        measures: [count]',
  '        dimensions: [customers.city]',
  '',
].join('\n'));

function doc(item: PublishedItem): any {
  const parsed: any = yaml.load(item.resolvedYaml);
  return (parsed.cubes ?? parsed.views)[0];
}

const byName = (items: PublishedItem[], name: string) => items.find((i) => i.name === name)!;

describe('expressions', () => {
  test('chains in load position only: not in strings, lambda parameters or keyword arguments', () => {
    const chains = chainsInFString("{CUBE}.x = {orders.id} AND '{not.me}' AND {FILTER_PARAMS.orders.day.filter(lambda a, b: f'{a} {orders.x}')} {f(k=v.w)}");
    expect(chains.map((c) => c.map((s) => s.text).join('.'))).toEqual([
      'CUBE', 'orders.id', 'FILTER_PARAMS.orders.day.filter', 'orders.x', 'f', 'v.w',
    ]);
    expect(chainsIn('customers.city').map((c) => c.map((s) => s.text))).toEqual([['customers', 'city']]);
  });

  test('positions map back through Cube\'s quote escaping', () => {
    const text = 'a "quoted" {orders.id} `tick`';
    const [chain] = chainsInFString(text);
    expect(text.slice(chain[0].start, chain[1].stop + 1)).toBe('orders.id');
  });
});

describe('publish', () => {
  test('items keep their names in every folder; xcube adds only where they came from', () => {
    const { items, errors } = publish({ tree, current: [], upserts: [customers, orders('feu')], deletes: [] });
    expect(errors).toEqual([]);
    const o = doc(byName(items, 'orders'));
    expect(byName(items, 'orders').fullName).toBe('orders');
    expect(o.name).toBe('orders');
    expect(o.title).toBeUndefined();
    expect(o.sql_alias).toBeUndefined();
    expect(o.joins[0]).toMatchObject({ name: 'customers', sql: '{CUBE}.customer_id = {customers.id}' });
    expect(o.measures[1].sql).toBe("{FILTER_PARAMS.orders.created_at.filter(lambda a, b: f'{CUBE}.created_at >= {a}')} + amount");
    expect(o.meta).toEqual({ xcube: { folderId: 'feu', shortName: 'orders' } });
    expect(byName(items, 'orders').bindings).toEqual({ customers: 'customers', orders: 'orders' });
    expect(filesOf(items).map((f) => f.path).sort()).toEqual(['customers.yml', 'orders.yml']);
  });

  test('views: join paths and prefixes are the cubes\' own names', () => {
    const { items, errors } = publish({
      tree,
      current: [],
      upserts: [customers, orders('fsales'), view('feu', 'overview', [
        '    cubes:',
        '      - join_path: orders',
        '        includes: [count]',
        '        prefix: true',
        '      - join_path: orders.customers',
        '        includes: [city]',
        '        prefix: true',
        '        alias: buyer',
        '',
      ].join('\n'))],
      deletes: [],
    });
    expect(errors).toEqual([]);
    expect(doc(byName(items, 'overview')).cubes).toEqual([
      { join_path: 'orders', includes: ['count'], prefix: true },
      { join_path: 'orders.customers', includes: ['city'], prefix: true, alias: 'buyer' },
    ]);
  });

  test('refuses a name the model doesn\'t hold, and a removal something still refers to, naming no folder', () => {
    const lonely = publish({ tree, current: [], upserts: [orders('fops')], deletes: [] });
    expect(lonely.errors.map((e) => e.message)).toEqual(['The join to "customers" names no cube of the model']);

    const { items } = publish({ tree, current: [], upserts: [customers, orders('fsales')], deletes: [] });
    const removal = publish({ tree, current: items, upserts: [], deletes: [{ folderId: 'froot', name: 'customers' }] });
    expect(removal.errors).toEqual([{
      folderId: 'froot', name: 'customers', kind: 'reference', message: 'customers can\'t be removed: orders refers to it',
    }]);
  });

  test('an item must be in a known folder', () => {
    const { errors } = publish({
      tree,
      current: [],
      upserts: [{ folderId: 'fnowhere', name: 'd', kind: 'cube', yaml: 'cubes:\n  - name: d\n' }],
      deletes: [],
    });
    expect(errors.map((e) => [e.name, e.kind])).toEqual([['d', 'folder']]);
  });

  test('an item must be one cube or view, named as the item, in plain YAML', () => {
    const { errors } = publish({
      tree,
      current: [],
      upserts: [
        { folderId: 'froot', name: 'a', kind: 'cube', yaml: 'cubes:\n  - name: b\n    sql_table: t\n' },
        { folderId: 'froot', name: 'c', kind: 'cube', yaml: 'cubes:\n  - name: c\n    sql: "{{ x }}"\n' },
        { folderId: 'froot', name: 'e', kind: 'cube', yaml: 'cubes:\n  - name: e\n   bad: [\n' },
        { folderId: 'froot', name: 'f', kind: 'view', yaml: 'cubes:\n  - name: f\n' },
      ],
      deletes: [],
    });
    expect(errors.map((e) => [e.name, e.kind])).toEqual([['a', 'item'], ['c', 'item'], ['e', 'yaml'], ['f', 'item']]);
    expect(errors[2].line).toBeGreaterThan(0);
  });

  test('the grammar: a letter, then letters, digits and single underscores, at most 40, no reserved word in any case', () => {
    const named = (name: string) => publish({
      tree, current: [], upserts: [{ folderId: 'froot', name, kind: 'cube', yaml: `cubes:\n  - name: ${name}\n    sql_table: t\n` }], deletes: [],
    }).errors.map((e) => e.message);
    for (const ok of ['orders', 'OrderItems', 'Orders_2024', 'a', `a${'b'.repeat(39)}`, 'cube_stats', 'classes']) {
      expect([ok, named(ok)]).toEqual([ok, []]);
    }
    for (const bad of ['a__b', 'orders_', '_orders', '2orders', 'order-items', 'order items', `a${'b'.repeat(40)}`]) {
      expect([bad, named(bad)]).toEqual([bad, [expect.stringMatching(/is not a valid name/)]]);
    }
    // Python's keywords (with None, True and False) and the names Cube resolves before a cube's.
    for (const reserved of ['class', 'Class', 'None', 'none', 'True', 'false', 'CUBE', 'cube', 'Table', 'security_context', 'SECURITY_CONTEXT',
      'securityContext', 'FILTER_PARAMS', 'filter_group', 'SQL_UTILS', 'USER_CONTEXT', 'compile_context']) {
      expect([reserved, named(reserved)]).toEqual([reserved, [`"${reserved}" is a reserved word and can't be a name`]]);
    }
  });

  test('a rollup keeps its names in Cube Store whatever their length; one built in the source is held to Postgres\'s 63 (R38)', () => {
    // wechart's seed: a 30-character stem, partitioned by year, with an index.
    const seed = (extra = '') => cube('froot', 'monthly_orders', [
      '    sql_table: public.orders',
      '    dimensions:',
      '      - name: status',
      '        sql: status',
      '        type: string',
      '      - name: ordered_at',
      '        sql: ordered_at',
      '        type: time',
      '    measures:',
      '      - name: count',
      '        type: count',
      '    pre_aggregations:',
      '      - name: by_status_month',
      '        measures: [count]',
      '        dimensions: [status]',
      '        time_dimension: ordered_at',
      '        granularity: month',
      '        partition_granularity: year',
      extra,
      '        indexes:',
      '          - name: by_status',
      '            columns: [status]',
      '',
    ].filter((l) => l !== '').join('\n'));
    const kept = publish({ tree, current: [], upserts: [seed()], deletes: [] });
    expect(kept.errors).toEqual([]);
    expect(doc(byName(kept.items, 'monthly_orders')).sql_alias).toBeUndefined();
    expect(doc(byName(kept.items, 'monthly_orders')).pre_aggregations[0].sql_alias).toBeUndefined();

    // Built in Postgres, its partition's table would be 30 + 8 + 26 = 64: aliased, and its index still too long.
    const inSource = publish({ tree, current: [], upserts: [seed('        external: false')], deletes: [] });
    expect(inSource.errors).toEqual([{
      folderId: 'froot',
      name: 'monthly_orders',
      kind: 'alias',
      message: 'Pre-aggregation by_status_month\'s rollup table name would be too long: shorten its name to at most 10 characters',
    }]);
    // So too when Cube keeps rollups in the source by default.
    process.env.CUBEJS_EXTERNAL_DEFAULT = 'false';
    try {
      expect(publish({ tree, current: [], upserts: [seed()], deletes: [] }).errors.map((e) => e.kind)).toEqual(['alias']);
    } finally {
      delete process.env.CUBEJS_EXTERNAL_DEFAULT;
    }

    // In the source without an index: the cube's alias shortens, then the pre-aggregation's.
    const long = 'customer_lifetime_orders_by_region';
    const longOrders = cube('fsales', long, `${orders('fsales').yaml.split('\n').slice(2).join('\n').replace('{FILTER_PARAMS.orders.', `{FILTER_PARAMS.${long}.`)}        external: false\n`);
    const shortened = publish({ tree, current: [], upserts: [customers, longOrders], deletes: [] });
    expect(shortened.errors).toEqual([]);
    const o = doc(byName(shortened.items, long));
    expect(o.sql_alias).toMatch(/^x[a-z2-7]{7}$/);
    expect(`${o.sql_alias}_by_city`.length + 26).toBeLessThanOrEqual(63);
    // The same in Cube Store keeps its name.
    const inStore = publish({ tree, current: [], upserts: [customers, cube('fsales', long, longOrders.yaml.split('\n').slice(2).join('\n').replace('        external: false\n', ''))], deletes: [] });
    expect(inStore.errors).toEqual([]);
    expect(doc(byName(inStore.items, long)).sql_alias).toBeUndefined();
    expect(titleOf('order_items')).toBe('Order Items');
    expect(titleOf('user_id')).toBe('User ID');
  });

  test('a name with upper case gets its lower-case form as its alias, so Cube\'s snake-casing can\'t make two names one', () => {
    const upper = cube('fsales', 'OrderItems', '    sql_table: t\n    measures:\n      - name: count\n        type: count\n');
    const lower = cube('fops', 'order_items', '    sql_table: t\n    measures:\n      - name: count\n        type: count\n');
    const caps = cube('froot', 'ORDERS', '    sql_table: t\n    measures:\n      - name: count\n        type: count\n');
    const { items, errors } = publish({ tree, current: [], upserts: [upper, lower, caps], deletes: [] });
    expect(errors).toEqual([]);
    expect(doc(byName(items, 'OrderItems')).sql_alias).toBe('orderitems');
    expect(doc(byName(items, 'order_items')).sql_alias).toBeUndefined();
    // Cube's own snake-casing would make it o_r_d_e_r_s.
    expect(doc(byName(items, 'ORDERS')).sql_alias).toBe('orders');
    expect(doc(byName(items, 'OrderItems')).title).toBeUndefined();
  });

  test('the resolved model compiles in Cube, and queries use the bare names', async () => {
    const upper = cube('fops', 'OrderItems', '    sql_table: t\n    dimensions:\n      - name: id\n        sql: id\n        type: number\n        primary_key: true\n    measures:\n      - name: count\n        type: count\n');
    const { items, errors } = publish({ tree, current: [], upserts: [{ ...customers, folderId: 'fsales' }, orders('feu'), upper], deletes: [] });
    expect(errors).toEqual([]);
    const files = filesOf(items);
    const { compiler, cubeEvaluator, joinGraph } = prepareCompiler({
      localPath: () => '/nowhere',
      dataSchemaFiles: async () => files.map(({ path, content }) => ({ fileName: path, content })),
    }, { standalone: true, allowNodeRequire: false });
    await compiler.compile();
    expect(cubeEvaluator.cubeList.map((c: any) => c.name).sort()).toEqual(['OrderItems', 'customers', 'orders']);
    expect(cubeEvaluator.byPath('measures', 'orders.count')).toBeDefined();
    expect(cubeEvaluator.byPath('measures', 'OrderItems.count')).toBeDefined();
    expect(joinGraph.buildJoin(['orders', 'customers'])).toBeTruthy();
  });
});

describe('one name per model (R71)', () => {
  const published = publish({ tree, current: [], upserts: [customers, orders('fsales')], deletes: [] }).items;
  const simpleCube = (folderId: string, name: string) => cube(folderId, name, '    sql_table: t\n    measures:\n      - name: count\n        type: count\n');

  test('a name in use, in any case, is refused, naming the caller\'s item and never the other\'s folder', () => {
    for (const name of ['orders', 'Orders', 'ORDERS']) {
      const { errors } = publish({ tree, current: published, upserts: [simpleCube('fops', name)], deletes: [] });
      expect(errors).toEqual([{ folderId: 'fops', name, kind: 'name_in_use', message: `The name "${name}" is already in use` }]);
      expect(JSON.stringify(errors)).not.toContain('fsales');
    }
  });

  test('a landed name never changes, not even its case', () => {
    const { errors } = publish({ tree, current: published, upserts: [{ ...orders('fsales'), name: 'Orders', yaml: orders('fsales').yaml.replace('name: orders', 'name: Orders') }], deletes: [] });
    expect(errors).toEqual([{
      folderId: 'fsales', name: 'Orders', kind: 'name_in_use', message: 'The name "Orders" is in use as "orders": a landed name can\'t change, not even its case',
    }]);
  });

  test('an edit in its own folder is the item\'s, and a delete then a new item of its name may land', () => {
    expect(publish({ tree, current: published, upserts: [orders('fsales')], deletes: [] }).errors).toEqual([]);
    const gone = publish({ tree, current: published, upserts: [], deletes: [{ folderId: 'fsales', name: 'orders' }] });
    expect(gone.errors).toEqual([]);
    const again = publish({ tree, current: gone.items, upserts: [orders('fops')], deletes: [] });
    expect(again.errors).toEqual([]);
    expect(byName(again.items, 'orders').folderId).toBe('fops');
  });

  test('a move in one changeset is the same item: a delete of A/orders and an upsert of B/orders (2.7)', () => {
    const withView = publish({ tree, current: published, upserts: [view('feu', 'summary', '    cubes:\n      - join_path: orders\n        includes: [count]\n')], deletes: [] });
    expect(withView.errors).toEqual([]);
    // Up to the root: still on summary's path.
    const moved = publish({ tree, current: withView.items, upserts: [orders('froot')], deletes: [{ folderId: 'fsales', name: 'orders' }] });
    expect(moved.errors).toEqual([]);
    expect(byName(moved.items, 'orders').folderId).toBe('froot');
    expect(doc(byName(moved.items, 'orders')).meta.xcube.folderId).toBe('froot');
    // What refers to it is untouched: it still means orders.
    expect(byName(moved.items, 'summary')).toBe(byName(withView.items, 'summary'));
    // Without the delete, the same upsert is a clash.
    expect(publish({ tree, current: withView.items, upserts: [orders('froot')], deletes: [] }).errors[0].kind).toBe('name_in_use');
    // A delete must name where the item is.
    expect(publish({ tree, current: withView.items, upserts: [], deletes: [{ folderId: 'fops', name: 'orders' }] }).errors[0].message).toBe('There is no such item to delete');
  });

  test('one changeset may not hold two items of one name, in any case', () => {
    const { errors } = publish({ tree, current: [], upserts: [simpleCube('fsales', 'stock'), simpleCube('fops', 'Stock')], deletes: [] });
    expect(errors).toEqual([expect.objectContaining({ name: 'Stock', kind: 'name_in_use', message: expect.stringMatching(/holds two items named "Stock"/) })]);
  });

  test('a view\'s split views take names too', () => {
    const split = view('feu', 'overview', '    cubes:\n      - join_path: orders\n        includes: [count]\n        split: true\n');
    const clash = publish({ tree, current: published, upserts: [simpleCube('fops', 'overview_orders'), split], deletes: [] });
    expect(clash.errors).toEqual([expect.objectContaining({ name: 'overview', kind: 'name_in_use', message: 'Its split view "overview_orders" would take a name already in use' })]);
    const landed = publish({ tree, current: published, upserts: [split], deletes: [] });
    expect(landed.errors).toEqual([]);
    expect(publish({ tree, current: landed.items, upserts: [simpleCube('fops', 'Overview_Orders')], deletes: [] }).errors)
      .toEqual([expect.objectContaining({ name: 'Overview_Orders', kind: 'name_in_use' })]);
  });

  test('extends names a cube up the path; an item never extends itself', () => {
    const child = cube('feu', 'big_orders', '    extends: orders\n');
    const { items, errors } = publish({ tree, current: published, upserts: [child], deletes: [] });
    expect(errors).toEqual([]);
    expect(doc(byName(items, 'big_orders')).extends).toBe('orders');
    expect(doc(byName(items, 'big_orders')).sql_alias).toBe('big_orders');
    const self = publish({ tree, current: [], upserts: [cube('fops', 'loop', '    extends: loop\n    sql_table: t\n')], deletes: [] });
    expect(self.errors.map((e) => e.message)).toEqual(['It extends itself']);
  });

  test('names are matched exactly, as Cube matches them: {amount} stays a member beside a cube Amount', () => {
    const amount = simpleCube('fops', 'Amount');
    const withMember = cube('fsales', 'sales', '    sql_table: t\n    dimensions:\n      - name: amount\n        sql: amount\n        type: number\n    measures:\n      - name: total\n        sql: "{amount}"\n        type: sum\n');
    const { items, errors } = publish({ tree, current: [], upserts: [amount, withMember], deletes: [] });
    expect(errors).toEqual([]);
    expect(doc(byName(items, 'sales')).measures[0].sql).toBe('{amount}');
    expect(byName(items, 'sales').bindings).toEqual({});
  });
});

describe('every reference stays on the referrer\'s folder path (R72)', () => {
  // The tree: froot → fsales → feu, and froot → fops.
  const simpleCube = (folderId: string, name: string) => cube(folderId, name, '    sql_table: t\n    dimensions:\n      - name: id\n        sql: id\n        type: number\n        primary_key: true\n    measures:\n      - name: count\n        type: count\n');
  const refusal = (folderId: string, name: string, target: string) => ({
    folderId, name, kind: 'reference_range', message: `It refers to "${target}", which isn't in its folder or one of its ancestors`,
  });

  test('a join to a sibling branch is refused, naming the referrer and never the other\'s folder', () => {
    const { errors } = publish({ tree, current: [], upserts: [{ ...customers, folderId: 'fops' }, orders('fsales')], deletes: [] });
    expect(errors).toEqual([refusal('fsales', 'orders', 'customers')]);
    expect(JSON.stringify(errors)).not.toContain('fops');
  });

  test('a view over a cube in a sibling branch is refused, each join path segment counted', () => {
    const v = view('fops', 'overview', '    cubes:\n      - join_path: orders\n        includes: [count]\n');
    expect(publish({ tree, current: [], upserts: [customers, orders('fsales'), v], deletes: [] }).errors).toEqual([refusal('fops', 'overview', 'orders')]);
    const path = view('fsales', 'overview', '    cubes:\n      - join_path: orders.customers\n        includes: [city]\n');
    expect(publish({ tree, current: [], upserts: [{ ...customers, folderId: 'fops' }, orders('fsales'), path], deletes: [] }).errors)
      .toEqual([refusal('fsales', 'orders', 'customers'), refusal('fsales', 'overview', 'customers')]);
  });

  test('extends from a sibling branch is refused', () => {
    const { errors } = publish({ tree, current: [], upserts: [simpleCube('fsales', 'base'), cube('fops', 'child', '    extends: base\n')], deletes: [] });
    expect(errors).toEqual([refusal('fops', 'child', 'base')]);
  });

  test('{cube.member} and FILTER_PARAMS references are counted', () => {
    const member = cube('fops', 'stats', '    sql_table: t\n    measures:\n      - name: n\n        sql: "{orders.count}"\n        type: number\n');
    const params = cube('fops', 'params', '    sql: "SELECT * FROM t WHERE {FILTER_PARAMS.orders.status.filter(\'status\')}"\n    measures:\n      - name: n\n        type: count\n');
    const { errors } = publish({ tree, current: [], upserts: [customers, orders('fsales'), member, params], deletes: [] });
    expect(errors).toEqual([refusal('fops', 'stats', 'orders'), refusal('fops', 'params', 'orders')]);
  });

  test('the same references up the path are allowed', () => {
    const v = view('feu', 'overview', '    cubes:\n      - join_path: orders.customers\n        includes: [city]\n');
    const child = cube('feu', 'child', '    extends: orders\n');
    const member = cube('feu', 'stats', '    sql_table: t\n    measures:\n      - name: n\n        sql: "{orders.count} + {customers.count}"\n        type: number\n');
    const { errors } = publish({ tree, current: [], upserts: [customers, orders('fsales'), v, child, member], deletes: [] });
    expect(errors).toEqual([]);
  });

  test('a move that strands a referrer is refused, naming the referrer: in a changeset, and by a folder push (outOfRange)', () => {
    const landed = publish({ tree, current: [], upserts: [customers, orders('fsales')], deletes: [] });
    expect(landed.errors).toEqual([]);
    // customers moved from the root to fops: orders, in fsales, can no longer reach it.
    const moved = publish({ tree, current: landed.items, upserts: [{ ...customers, folderId: 'fops' }], deletes: [{ folderId: 'froot', name: 'customers' }] });
    expect(moved.errors).toEqual([refusal('fsales', 'orders', 'customers')]);
    // fsales moved under fops: orders still reaches the root's customers. customers under fsales, moved: stranded.
    const withLocal = publish({ tree, current: [], upserts: [{ ...customers, folderId: 'fsales' }, orders('feu')], deletes: [] }).items;
    const under = (id: string, parentId: string) => new FolderTree([...tree.folders.filter((f) => f.id !== id), { id, parentId }]);
    expect(outOfRange(withLocal, under('feu', 'fops'), []).items).toEqual(['orders']);
    expect(outOfRange(withLocal, under('fsales', 'fops'), [])).toEqual({ cubes: [], items: [] });
  });
});

describe('review findings', () => {
  const simple = (folderId: string, name: string, extra = '') => cube(folderId, name, [
    '    sql_table: public.t',
    '    dimensions:',
    '      - name: id',
    '        sql: id',
    '        type: number',
    '        primary_key: true',
    '      - name: city',
    '        sql: city',
    '        type: string',
    '      - name: created_at',
    '        sql: created_at',
    '        type: time',
    '    measures:',
    '      - name: count',
    '        type: count',
    extra,
    '',
  ].filter((l) => l !== '').join('\n'));

  test('a pre-aggregation with indexes never gets an alias: the cube\'s alias shortens instead, or it is refused', () => {
    const inSource = (name: string, pa: string, indexes: boolean) => simple('fsales', name, [
      '    pre_aggregations:',
      `      - name: ${pa}`,
      '        measures: [count]',
      '        external: false',
      ...(indexes ? ['        indexes:', '          - name: by_city', '            columns: [city]'] : []),
    ].join('\n'));
    // A table of 18 + 1 + 13 + 26 = 58, but an index of 66: the cube's alias shortens.
    const { items, errors } = publish({ tree, current: [], upserts: [inSource('regional_orders_dl', 'orders_by_day', true)], deletes: [] });
    expect(errors).toEqual([]);
    const o = doc(byName(items, 'regional_orders_dl'));
    expect(o.sql_alias).toMatch(/^x[a-z2-7]{7}$/);
    expect(o.pre_aggregations[0].sql_alias).toBeUndefined();

    const refused = publish({ tree, current: [], upserts: [inSource('orders', 'orders_by_day_and_city_and_more', true)], deletes: [] });
    expect(refused.errors[0].message).toMatch(/rollup table name would be too long: shorten its name to at most 20 characters/);

    const aliased = publish({ tree, current: [], upserts: [inSource('orders', 'orders_by_day_and_city_and_more_x', false)], deletes: [] });
    expect(aliased.errors).toEqual([]);
    const a = doc(aliased.items[0]);
    expect(`${a.sql_alias ?? a.name}_${a.pre_aggregations[0].sql_alias ?? a.pre_aggregations[0].name}`.length + 26).toBeLessThanOrEqual(63);
  });

  test('.sql after a cube is its SQL, even with an item named sql in the model', () => {
    const user = simple('fsales', 'orders', [
      '      - name: from_customers',
      '        sql: "{customers.sql()}"',
      '        type: number',
    ].join('\n'));
    const { items, errors } = publish({ tree, current: [], upserts: [simple('froot', 'customers'), simple('fops', 'sql'), user], deletes: [] });
    expect(errors).toEqual([]);
    expect(doc(byName(items, 'orders')).measures[1].sql).toBe('{customers.sql()}');
    expect(byName(items, 'orders').bindings).toEqual({ customers: 'customers' });
  });

  test('a member\'s SQL alias is length-checked, its cube\'s alias shortened first', () => {
    const longMember = 'average_order_value_for_lifetime';
    const withAmount = simple('fsales', 'customers', [
      '      - name: amount',
      '        sql: amount',
      '        type: sum',
    ].join('\n'));
    const long = 'customers_overview_for_the_sales_team';
    const v = view('fsales', long, `    cubes:\n      - join_path: customers\n        includes:\n          - name: amount\n            alias: ${longMember}\n        prefix: true\n`);
    const { items, errors } = publish({ tree, current: [], upserts: [withAmount, v], deletes: [] });
    expect(errors).toEqual([]);
    expect(doc(byName(items, long)).sql_alias).toMatch(/^x[a-z2-7]{7}$/);
    const longer = view('fsales', 'overview', `    cubes:\n      - join_path: customers\n        includes:\n          - name: amount\n            alias: ${longMember}_and_more_still_longer\n        prefix: true\n`);
    expect(publish({ tree, current: [], upserts: [withAmount, longer], deletes: [] }).errors.map((e) => e.message))
      .toEqual([expect.stringMatching(new RegExp(`Member customers_${longMember}_and_more_still_longer's SQL alias would be longer than 63`))]);
  });
});

describe('overlays', () => {
  const published = publish({ tree, current: [], upserts: [customers, orders('fsales')], deletes: [] }).items;

  test('an overlay item with a published item\'s name is its edit, wherever either is (2.6)', () => {
    // A copy of customers in another folder stands in for the published one.
    const copied = { ...customers, folderId: 'fsales', yaml: `${customers.yaml}    title: Clients\n` };
    const { items, errors, changed } = publish({ tree, current: published, upserts: [copied, orders('feu')], deletes: [], overlay: true });
    expect(errors).toEqual([]);
    expect(changed.sort()).toEqual(['customers', 'orders']);
    expect(items.map((i) => `${i.folderId}/${i.name}`).sort()).toEqual(['feu/orders', 'fsales/customers']);
    expect(doc(byName(items, 'customers')).title).toBe('Clients');
  });

  test('its own items\' references are held to their path; published items it stands in under are checked when it lands', () => {
    // orders (published, in fsales) refers to customers; a copy in fops is off orders' path.
    const copied = { ...customers, folderId: 'fops' };
    expect(publish({ tree, current: published, upserts: [copied], deletes: [], overlay: true }).errors).toEqual([]);
    expect(publish({ tree, current: published, upserts: [copied], deletes: [{ folderId: 'froot', name: 'customers' }] }).errors)
      .toEqual([expect.objectContaining({ name: 'orders', kind: 'reference_range' })]);
    // Its own item off its path is refused at push.
    expect(publish({ tree, current: published, upserts: [orders('fops'), { ...customers, folderId: 'fsales' }], deletes: [], overlay: true }).errors)
      .toEqual([expect.objectContaining({ folderId: 'fops', name: 'orders', kind: 'reference_range' })]);
  });

  test('without the overlay, the same upserts are clashes', () => {
    const { errors } = publish({ tree, current: published, upserts: [{ ...customers, folderId: 'fops' }], deletes: [] });
    expect(errors.map((e) => e.kind)).toEqual(['name_in_use']);
  });

  test('an overlay may not hold two items of one name, in any case', () => {
    const { errors } = publish({
      tree, current: published, upserts: [{ ...customers, folderId: 'fops' }, { ...customers, folderId: 'feu', name: 'Customers', yaml: customers.yaml.replace('name: customers', 'name: Customers') }], deletes: [], overlay: true,
    });
    expect(errors[0]).toMatchObject({ kind: 'name_in_use', message: expect.stringMatching(/holds two items named "Customers"/) });
  });
});

describe('data sources', () => {
  // The tree: froot → fsales → feu, and froot → fops.
  const sources = [
    { folderId: 'froot', name: 'default' },
    { folderId: 'fsales', name: 'warehouse' },
    { folderId: 'fops', name: 'lake' },
  ];
  const cubeWith = (folderId: string, name: string, extra = '') => cube(folderId, name, `    sql_table: t\n${extra}    dimensions:\n      - name: id\n        sql: id\n        type: number\n        primary_key: true\n`);
  const dataSourceOf = (items: PublishedItem[], name: string) => doc(byName(items, name)).data_source;

  test('a cube may use a data source in its folder or an ancestor, written as named; one elsewhere is refused (4.1)', () => {
    const { items, errors } = publish({
      tree,
      current: [],
      deletes: [],
      dataSources: sources,
      upserts: [cubeWith('feu', 'a', '    data_source: warehouse\n'), cubeWith('froot', 'b', '    data_source: default\n')],
    });
    expect(errors).toEqual([]);
    expect(dataSourceOf(items, 'a')).toBe('warehouse');
    expect(dataSourceOf(items, 'b')).toBe('default');
    const sibling = publish({ tree, current: [], deletes: [], dataSources: sources, upserts: [cubeWith('feu', 'c', '    data_source: lake\n')] });
    expect(sibling.errors).toEqual([{
      folderId: 'feu', name: 'c', kind: 'data_source_range', message: 'It uses the data source "lake", which isn\'t in its folder or one of its ancestors',
    }]);
    expect(JSON.stringify(sibling.errors)).not.toContain('fops');
    const unknown = publish({ tree, current: [], deletes: [], dataSources: sources, upserts: [cubeWith('feu', 'c', '    data_source: Warehouse\n')] });
    expect(unknown.errors.map((e) => [e.kind, e.message])).toEqual([['reference', 'It uses the data source "Warehouse", which the model doesn\'t hold']]);
  });

  test('a cube naming none uses the root\'s default, left unwritten; one that extends inherits its parent\'s', () => {
    const { items, errors } = publish({
      tree,
      current: [],
      deletes: [],
      dataSources: sources,
      upserts: [cubeWith('feu', 'a'), cubeWith('fsales', 'w', '    data_source: warehouse\n'), cube('feu', 'child', '    extends: w\n')],
    });
    expect(errors).toEqual([]);
    expect(dataSourceOf(items, 'a')).toBeUndefined();
    expect(dataSourceOf(items, 'child')).toBeUndefined();
  });

  test('an inherited data source is held to the rule too, naming the child and its parent (4.4)', () => {
    // A child off its parent's path is refused for both: R72's reference, and the data source it inherits.
    const { errors } = publish({
      tree,
      current: [],
      deletes: [],
      dataSources: sources,
      upserts: [cubeWith('fsales', 'w', '    data_source: warehouse\n'), cube('fops', 'child', '    extends: w\n')],
    });
    expect(errors).toEqual([{
      folderId: 'fops', name: 'child', kind: 'reference_range', message: 'It refers to "w", which isn\'t in its folder or one of its ancestors',
    }, {
      folderId: 'fops',
      name: 'child',
      kind: 'data_source_range',
      message: 'It uses the data source "warehouse" (through w, which it extends), which isn\'t in its folder or one of its ancestors',
    }]);
    // A parent moved onto another data source can't carry a kept child out of range.
    const landed = publish({
      tree, current: [], deletes: [], dataSources: sources, upserts: [cubeWith('froot', 'p'), cube('fsales', 'kid', '    extends: p\n')],
    });
    expect(landed.errors).toEqual([]);
    const withRootLake = [...sources, { folderId: 'fops', name: 'lake2' }];
    const moved = publish({ tree, current: landed.items, deletes: [], dataSources: withRootLake, upserts: [cubeWith('froot', 'p', '    data_source: lake2\n')] });
    expect(moved.errors.map((e) => [e.name, e.kind]).sort()).toEqual([['kid', 'data_source_range'], ['p', 'data_source_range']]);
  });

  test('outOfRange: the cubes a folder push or a data source moved would carry out of range', () => {
    const { items } = publish({
      tree,
      current: [],
      deletes: [],
      dataSources: sources,
      upserts: [cubeWith('feu', 'a', '    data_source: warehouse\n'), cube('feu', 'child', '    extends: a\n'), cubeWith('fops', 'b')],
    });
    expect(outOfRange(items, tree, sources)).toEqual({ cubes: [], items: [] });
    // warehouse moved into feu: still in range. Into fops: a and child out of it.
    expect(outOfRange(items, tree, sources.map((s) => (s.name === 'warehouse' ? { ...s, folderId: 'feu' } : s)))).toEqual({ cubes: [], items: [] });
    expect(outOfRange(items, tree, sources.map((s) => (s.name === 'warehouse' ? { ...s, folderId: 'fops' } : s))).cubes).toEqual(['a', 'child']);
    // feu moved under fops: away from warehouse.
    const moved = new FolderTree([...tree.folders.filter((f) => f.id !== 'feu'), { id: 'feu', parentId: 'fops' }]);
    expect(outOfRange(items, moved, sources).cubes).toEqual(['a', 'child']);
  });

  test('without connections, data_source is left as written', () => {
    const { items } = publish({ tree, current: [], deletes: [], upserts: [cubeWith('feu', 'a', '    data_source: anything\n')] });
    expect(dataSourceOf(items, 'a')).toBe('anything');
  });

  test('a cube\'s alias names the data source it uses, so another data source is another SQL and another rollup table', () => {
    const aliasOfItem = (items: PublishedItem[], name: string) => doc(byName(items, name)).sql_alias;
    const plain = publish({ tree, current: [], deletes: [], dataSources: sources, upserts: [cubeWith('feu', 'a')] });
    expect(aliasOfItem(plain.items, 'a')).toBeUndefined();
    const named = publish({ tree, current: [], deletes: [], dataSources: sources, upserts: [cubeWith('feu', 'a', '    data_source: warehouse\n')] });
    expect(aliasOfItem(named.items, 'a')).toBe(aliasOf('a', 'warehouse'));
    expect(aliasOf('a', 'warehouse')).not.toBe('a');
    // An alias the author wrote is kept.
    const mine = publish({ tree, current: [], deletes: [], dataSources: sources, upserts: [cubeWith('feu', 'b', '    sql_alias: mine\n    data_source: warehouse\n')] });
    expect(aliasOfItem(mine.items, 'b')).toBe('mine');
  });

  test('a cube that extends another is aliased by the data source it inherits, and never shares its parent\'s alias', () => {
    const aliasOfItem = (items: PublishedItem[], name: string) => doc(byName(items, name)).sql_alias;
    const first = publish({
      tree,
      current: [],
      deletes: [],
      dataSources: sources,
      upserts: [
        cubeWith('fsales', 'base', '    data_source: warehouse\n'),
        cube('feu', 'child', '    extends: base\n'),
        cubeWith('froot', 'abase', '    sql_alias: ab\n'),
        cube('froot', 'achild', '    extends: abase\n'),
      ],
    });
    expect(first.errors).toEqual([]);
    expect(aliasOfItem(first.items, 'child')).toBe(aliasOf('child', 'warehouse'));
    // On Cube's default, a child under an authored alias has its own name, not the parent's `ab`.
    expect(aliasOfItem(first.items, 'abase')).toBe('ab');
    expect(aliasOfItem(first.items, 'achild')).toBe('achild');

    // The parent alone published onto Cube's default: the kept child follows, its alias only.
    const again = publish({ tree, current: first.items, deletes: [], dataSources: sources, upserts: [cubeWith('fsales', 'base')] });
    expect(again.errors).toEqual([]);
    expect(aliasOfItem(again.items, 'base')).toBeUndefined();
    expect(aliasOfItem(again.items, 'child')).toBe('child');
    expect(again.changed).toEqual(expect.arrayContaining(['base', 'child']));
    expect(byName(again.items, 'child').bindings).toEqual(byName(first.items, 'child').bindings);
    // What doesn't change isn't touched.
    expect(again.changed).not.toContain('achild');
    expect(byName(again.items, 'achild')).toBe(byName(first.items, 'achild'));
  });
});

describe('titles match Cube\'s own', () => {
  test('for names with digit words, ids and single letters', async () => {
    const names = ['orders', 'order_items', 'sales_2023', 'q3_sales', 'user_id', 'user_ids', 'a2b_c', 'v1', 'x_2_y', 'id', 'kpi_2023_q4'];
    const files = names.map((name) => ({ fileName: `${name}.yml`, content: `cubes:\n  - name: ${name}\n    sql: "SELECT 1 AS x"\n    measures:\n      - name: count\n        type: count\n` }));
    const { compiler, metaTransformer } = prepareCompiler({ localPath: () => '/nowhere', dataSchemaFiles: async () => files }, { standalone: true, allowNodeRequire: false });
    await compiler.compile();
    const cubeTitles = Object.fromEntries(metaTransformer.cubes.map((c: any) => [c.config.name, c.config.title]));
    expect(Object.fromEntries(names.map((n) => [n, titleOf(n)]))).toEqual(cubeTitles);
  });
});

describe('itemsHash', () => {
  // The golden vector wechart tests its own hash against.
  test('is the SHA-256 of the items sorted by folderId/name, as [{folderId, name, kind, yaml}]', () => {
    const items = [
      { folderId: 'fsales', name: 'orders', kind: 'cube' as const, yaml: 'cubes:\n  - name: orders\n' },
      { folderId: 'froot', name: 'customers', kind: 'cube' as const, yaml: 'cubes:\n  - name: customers\n' },
    ];
    expect(itemsHash(items)).toBe('49ef16c81790839fe68a0306e4942506ba81c09e060c18c32341864ff0ffeee4');
    expect(itemsHash([...items].reverse())).toBe(itemsHash(items));
  });
});
