import yaml from 'js-yaml';
import { prepareCompiler } from '@cubejs-backend/schema-compiler';

import { chainsIn, chainsInFString } from '../../src/names/expr';
import { FolderTree, type AuthoredItem, type PublishedItem } from '../../src/names/items';
import { aliasOf, filesOf, publish, titleOf } from '../../src/names/publish';

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

const byName = (items: PublishedItem[], fullName: string) => items.find((i) => i.fullName === fullName)!;

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
  test('root items keep their names; xcube adds only where they came from', () => {
    const { items, errors } = publish({ tree, current: [], upserts: [customers, orders('froot')], deletes: [] });
    expect(errors).toEqual([]);
    const o = doc(byName(items, 'orders'));
    expect(o.name).toBe('orders');
    expect(o.title).toBeUndefined();
    expect(o.sql_alias).toBeUndefined();
    expect(o.joins[0]).toMatchObject({ name: 'customers', sql: '{CUBE}.customer_id = {customers.id}' });
    expect(o.meta).toEqual({ xcube: { folderId: 'froot', shortName: 'orders' } });
    expect(byName(items, 'orders').bindings).toEqual({ customers: 'customers', orders: 'orders' });
  });

  test('a folder item gets its prefix, title and alias, and binds nearest-first', () => {
    const localCustomers = { ...customers, folderId: 'fsales' };
    const { items, errors } = publish({
      tree,
      current: [],
      upserts: [customers, localCustomers, orders('feu'), orders('fops')],
      deletes: [],
    });
    expect(errors).toEqual([]);

    const eu = doc(byName(items, 'feu__orders'));
    expect(eu.title).toBe('Orders');
    expect(eu.sql_alias).toBe('feu__orders');
    expect(eu.joins[0]).toMatchObject({
      name: 'fsales__customers',
      sql: '{CUBE}.customer_id = {fsales__customers.id}',
    });
    expect(eu.measures[0].drill_members).toEqual(['id', 'fsales__customers.city']);
    expect(eu.measures[1].sql).toBe("{FILTER_PARAMS.feu__orders.created_at.filter(lambda a, b: f'{CUBE}.created_at >= {a}')} + amount");
    expect(eu.pre_aggregations[0].dimensions).toEqual(['fsales__customers.city']);

    // ops has no customers of its own: the root's.
    expect(doc(byName(items, 'fops__orders')).joins[0].name).toBe('customers');
  });

  test('views: join paths, and the short cube name kept for prefixed members', () => {
    const { items, errors } = publish({
      tree,
      current: [],
      upserts: [customers, orders('fsales'), view('fsales', 'overview', [
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
    const v = doc(byName(items, 'fsales__overview'));
    expect(v.cubes).toEqual([
      { join_path: 'fsales__orders', includes: ['count'], prefix: true, alias: 'orders' },
      { join_path: 'fsales__orders.customers', includes: ['city'], prefix: true, alias: 'buyer' },
    ]);
  });

  test('refuses a name no folder on the path holds, and a removal something still refers to', () => {
    const lonely = publish({ tree, current: [], upserts: [orders('fops')], deletes: [] });
    expect(lonely.errors.map((e) => e.message)).toEqual([
      'The join to "customers" names no cube in a folder on this item\'s path',
    ]);

    const { items } = publish({ tree, current: [], upserts: [customers, orders('fsales')], deletes: [] });
    const removal = publish({ tree, current: items, upserts: [], deletes: [{ folderId: 'froot', name: 'customers' }] });
    expect(removal.errors).toEqual([{
      folderId: 'froot',
      name: 'customers',
      kind: 'reference',
      message: 'froot/customers can\'t be removed or renamed: fsales/orders refers to it',
    }]);
  });

  test('keeps an item\'s bindings until it is published again (no rebinding)', () => {
    const first = publish({ tree, current: [], upserts: [customers, orders('feu')], deletes: [] });
    expect(doc(byName(first.items, 'feu__orders')).joins[0].name).toBe('customers');

    // A nearer customers appears; feu/orders keeps the root's until it is published again.
    const second = publish({ tree, current: first.items, upserts: [{ ...customers, folderId: 'fsales' }], deletes: [] });
    expect(doc(byName(second.items, 'feu__orders')).joins[0].name).toBe('customers');

    const third = publish({ tree, current: second.items, upserts: [orders('feu')], deletes: [] });
    expect(doc(byName(third.items, 'feu__orders')).joins[0].name).toBe('fsales__customers');
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
        { folderId: 'froot', name: 'Bad__Name', kind: 'cube', yaml: 'cubes: []' },
        { folderId: 'froot', name: 'c', kind: 'cube', yaml: 'cubes:\n  - name: c\n    sql: "{{ x }}"\n' },
        { folderId: 'froot', name: 'e', kind: 'cube', yaml: 'cubes:\n  - name: e\n   bad: [\n' },
        { folderId: 'froot', name: 'f', kind: 'view', yaml: 'cubes:\n  - name: f\n' },
      ],
      deletes: [],
    });
    expect(errors.map((e) => [e.name, e.kind])).toEqual([['a', 'item'], ['Bad__Name', 'item'], ['c', 'item'], ['e', 'yaml'], ['f', 'item']]);
    expect(errors[3].line).toBeGreaterThan(0);
  });

  test('aliases: long names get a stable hash, and long pre-aggregation stems a short alias', () => {
    const longFolder = 'f0123456789abcdef0123456789abcdef';
    const longTree = new FolderTree([{ id: 'froot', parentId: null }, { id: longFolder, parentId: 'froot' }]);
    const { items, errors } = publish({ tree: longTree, current: [], upserts: [customers, orders(longFolder)], deletes: [] });
    expect(errors).toEqual([]);
    const o = doc(byName(items, `${longFolder}__orders`));
    expect(o.sql_alias).toBe(aliasOf(`${longFolder}__orders`));
    expect(o.sql_alias).toMatch(/^x[a-z2-7]{7}$/);
    expect(`${o.sql_alias}_by_city`.length).toBeLessThanOrEqual(25);
    expect(titleOf('order_items')).toBe('Order Items');
    expect(titleOf('user_id')).toBe('User ID');
  });

  test('the resolved model compiles in Cube, and queries use the full names', async () => {
    const { items, errors } = publish({
      tree,
      current: [],
      upserts: [customers, { ...customers, folderId: 'fsales' }, orders('feu'), orders('froot')],
      deletes: [],
    });
    expect(errors).toEqual([]);
    const files = filesOf(items);
    const { compiler, cubeEvaluator, joinGraph } = prepareCompiler({
      localPath: () => '/nowhere',
      dataSchemaFiles: async () => files.map(({ path, content }) => ({ fileName: path, content })),
    }, { standalone: true, allowNodeRequire: false });
    await compiler.compile();
    expect(Object.keys(cubeEvaluator.cubeList.reduce((all: any, c: any) => ({ ...all, [c.name]: true }), {})).sort())
      .toEqual(['customers', 'feu__orders', 'fsales__customers', 'orders']);
    expect(cubeEvaluator.byPath('measures', 'feu__orders.count')).toBeDefined();
    expect(joinGraph.buildJoin(['feu__orders', 'fsales__customers'])).toBeTruthy();
  });
});

describe('the rewrite corpus', () => {
  const corpusTree = new FolderTree([{ id: 'froot', parentId: null }, { id: 'fsales', parentId: 'froot' }]);

  const root = cube('froot', 'customers', [
    '    sql_table: public.customers',
    '    dimensions:',
    '      - name: id',
    '        sql: id',
    '        type: number',
    '        primary_key: true',
    '      - name: name',
    '        sql: name',
    '        type: string',
    '    measures:',
    '      - name: count',
    '        type: count',
    '    pre_aggregations:',
    '      - name: by_name',
    '        dimensions: [name]',
    '        measures: [count]',
    '',
  ].join('\n'));

  // `clash`: a member named as the cube it joins, to check the member-first rule; Cube itself can't
  // then reach that cube through the member's name, so the compile check leaves it out.
  const base = (clash: boolean) => cube('fsales', 'base_orders', [
    '    sql_table: public.orders',
    '    dimensions:',
    '      - name: id',
    '        sql: id',
    '        type: number',
    '        primary_key: true',
    ...(clash ? ['      - name: customers', '        sql: customer_id', '        type: number'] : []),
    '',
  ].join('\n'));

  const corpusOrders = (clash: boolean) => cube('fsales', 'orders', [
    '    extends: base_orders',
    '    joins:',
    '      - name: customers',
    '        sql: "{CUBE}.customer_id = {customers}.id"',
    '        relationship: many_to_one',
    '    dimensions:',
    '      - name: status',
    '        sql: "{CUBE}.status"',
    '        type: string',
    '      - name: created_at',
    '        sql: created_at',
    '        type: time',
    '      - name: buyer',
    '        sql: "{customers.name} || \' \' || \'customers.name\'"',
    '        type: string',
    ...(clash ? [
      '      - name: own_customer_column',
      '        sql: "{CUBE.customers} + {orders.customers}"',
      '        type: number',
    ] : []),
    '      - name: status_case',
    '        type: string',
    '        case:',
    '          when:',
    '            - sql: "{CUBE}.status = \'a\'"',
    '              label: A',
    '          else:',
    '            label: B',
    '      - name: link',
    '        sql: id',
    '        type: number',
    '        links:',
    '          - name: open',
    '            label: Open',
    '            url: "{customers.name}"',
    '    segments:',
    '      - name: big',
    '        sql: "{CUBE}.amount > 10 AND {customers.name} IS NOT NULL"',
    '    measures:',
    '      - name: count',
    '        type: count',
    '      - name: count_by_buyer',
    '        type: count',
    '        filters:',
    '          - sql: "{customers.name} <> \'\'"',
    '      - name: count_last_year',
    '        type: count',
    '        multi_stage: true',
    '        sql: "{count}"',
    '        time_shift:',
    '          - time_dimension: created_at',
    '            interval: 1 year',
    '            type: prior',
    '      - name: filtered',
    '        sql: "{FILTER_PARAMS.orders.created_at.filter(lambda customers, b: f\'{customers} <= {b}\')}"',
    '        type: number',
    '    hierarchies:',
    '      - name: path',
    '        levels: [status, customers.name]',
    '    pre_aggregations:',
    '      - name: main',
    '        measures: [count]',
    '        dimensions: [status, customers.name]',
    '        time_dimension: created_at',
    '        granularity: day',
    '      - name: joined',
    '        type: rollup_join',
    '        measures: [count]',
    '        dimensions: [customers.name]',
    '        rollups: [customers.by_name, main]',
    '    access_policy:',
    '      - group: "*"',
    '        row_level:',
    '          filters:',
    '            - member: orders.status',
    '              operator: equals',
    '              values: ["customers"]',
    '        member_level:',
    '          includes: [orders.count, status]',
    '',
  ].join('\n'));

  const summary = view('fsales', 'summary', [
    '    cubes:',
    '      - join_path: orders',
    '        includes: [count, status]',
    '      - join_path: orders.customers',
    '        includes: [name]',
    '        prefix: true',
    '    default_filters:',
    '      - member: orders.status',
    '        operator: equals',
    '        values: [a]',
    '',
  ].join('\n'));

  const published = (clash = true) => {
    const result = publish({ tree: corpusTree, current: [], upserts: [root, base(clash), corpusOrders(clash), summary], deletes: [] });
    expect(result.errors).toEqual([]);
    return result.items;
  };

  test('every construct that names another cube is rewritten, and nothing else', () => {
    const items = published();
    const o = doc(byName(items, 'fsales__orders'));
    const dim = (n: string) => o.dimensions.find((d: any) => d.name === n);
    const measure = (n: string) => o.measures.find((m: any) => m.name === n);

    expect(o.extends).toBe('fsales__base_orders');
    expect(o.joins[0]).toMatchObject({ name: 'customers', sql: '{CUBE}.customer_id = {customers}.id' });
    // Root names are bare; the string literal is untouched.
    expect(dim('buyer').sql).toBe("{customers.name} || ' ' || 'customers.name'");
    // `customers` is an inherited member of orders, so after `CUBE.` and `orders.` it stays a member.
    expect(dim('own_customer_column').sql).toBe('{CUBE.customers} + {fsales__orders.customers}');
    expect(dim('link').links[0].url).toBe('{customers.name}');
    expect(measure('filtered').sql).toBe("{FILTER_PARAMS.fsales__orders.created_at.filter(lambda customers, b: f'{customers} <= {b}')}");
    expect(o.hierarchies[0].levels).toEqual(['status', 'customers.name']);
    expect(o.pre_aggregations[1].rollups).toEqual(['customers.by_name', 'main']);
    expect(o.access_policy[0].row_level.filters[0]).toMatchObject({ member: 'fsales__orders.status', values: ['customers'] });
    expect(o.access_policy[0].member_level.includes).toEqual(['fsales__orders.count', 'status']);

    const v = doc(byName(items, 'fsales__summary'));
    expect(v.cubes).toEqual([
      { join_path: 'fsales__orders', includes: ['count', 'status'] },
      { join_path: 'fsales__orders.customers', includes: ['name'], prefix: true, alias: 'customers' },
    ]);
    expect(v.default_filters[0].member).toBe('fsales__orders.status');
    expect(byName(items, 'fsales__orders').bindings).toEqual({
      base_orders: 'fsales__base_orders', customers: 'customers', orders: 'fsales__orders',
    });
  });

  test('the corpus compiles in Cube', async () => {
    const files = filesOf(published(false));
    const { compiler, cubeEvaluator } = prepareCompiler({
      localPath: () => '/nowhere',
      dataSchemaFiles: async () => files.map(({ path, content }) => ({ fileName: path, content })),
    }, { standalone: true, allowNodeRequire: false });
    await compiler.compile();
    expect(cubeEvaluator.byPath('dimensions', 'fsales__summary.customers_name')).toBeDefined();
    expect(cubeEvaluator.byPath('measures', 'fsales__orders.count_by_buyer')).toBeDefined();
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
    const withIndexes = simple('fsales', 'orders', [
      '    pre_aggregations:',
      '      - name: orders_by_day',
      '        measures: [count]',
      '        time_dimension: created_at',
      '        granularity: day',
      '        indexes:',
      '          - name: by_city',
      '            columns: [city]',
    ].join('\n'));
    const { items, errors } = publish({ tree, current: [], upserts: [withIndexes], deletes: [] });
    expect(errors).toEqual([]);
    const o = doc(byName(items, 'fsales__orders'));
    expect(o.sql_alias).toMatch(/^x[a-z2-7]{7}$/);
    expect(o.pre_aggregations[0].sql_alias).toBeUndefined();

    const tooLong = simple('fsales', 'orders', [
      '    pre_aggregations:',
      '      - name: orders_by_day_and_city_and_more',
      '        measures: [count]',
      '        indexes:',
      '          - name: by_city',
      '            columns: [city]',
    ].join('\n'));
    const refused = publish({ tree, current: [], upserts: [tooLong], deletes: [] });
    expect(refused.errors[0].message).toMatch(/rollup table name would be too long: shorten its name to at most 16 characters/);

    const noIndexes = simple('fsales', 'orders', [
      '    pre_aggregations:',
      '      - name: orders_by_day_and_city_and_more',
      '        measures: [count]',
    ].join('\n'));
    const aliased = publish({ tree, current: [], upserts: [noIndexes], deletes: [] });
    expect(aliased.errors).toEqual([]);
    const a = doc(aliased.items[0]);
    expect(`${a.sql_alias}_${a.pre_aggregations[0].sql_alias}`.length).toBeLessThanOrEqual(25);
  });

  test('legacy snake_case *_references keys are rewritten, as Cube camelizes them', () => {
    const withReferences = simple('fsales', 'orders', [
      '    joins:',
      '      - name: customers',
      '        sql: "{CUBE}.id = {customers.id}"',
      '        relationship: many_to_one',
      '    pre_aggregations:',
      '      - name: main',
      '        measure_references: [count]',
      '        dimension_references: [customers.city]',
    ].join('\n'));
    const { items, errors } = publish({ tree, current: [], upserts: [simple('froot', 'customers'), simple('fsales', 'customers'), withReferences], deletes: [] });
    expect(errors).toEqual([]);
    expect(doc(byName(items, 'fsales__orders')).pre_aggregations[0].dimension_references).toEqual(['fsales__customers.city']);
  });

  test('.sql after a cube is its SQL, even with an item named sql in scope', () => {
    const user = simple('fsales', 'orders', [
      '      - name: from_customers',
      '        sql: "{customers.sql()}"',
      '        type: number',
    ].join('\n').replace('    measures:', '    measures:'));
    const { items, errors } = publish({ tree, current: [], upserts: [simple('froot', 'customers'), simple('fsales', 'sql'), user], deletes: [] });
    expect(errors).toEqual([]);
    expect(doc(byName(items, 'fsales__orders')).measures[1].sql).toBe('{customers.sql()}');
  });

  test('an override reaches its ancestor\'s namesake through extends and join paths', () => {
    const override = cube('fsales', 'orders', '    extends: orders\n');
    const overview = view('fops', 'orders', '    cubes:\n      - join_path: orders\n        includes: [count]\n');
    const { items, errors } = publish({ tree, current: [], upserts: [simple('froot', 'orders'), override, overview], deletes: [] });
    expect(errors).toEqual([]);
    expect(doc(byName(items, 'fsales__orders')).extends).toBe('orders');
    expect(doc(byName(items, 'fops__orders')).cubes[0].join_path).toBe('orders');
  });

  test('a full name written by hand is refused: refer by short name', () => {
    const sneaky = simple('fops', 'orders', [
      '      - name: from_sales',
      '        sql: "{fsales__customers.id}"',
      '        type: number',
    ].join('\n'));
    const { errors } = publish({ tree, current: [], upserts: [simple('fsales', 'customers'), sneaky], deletes: [] });
    expect(errors.map((e) => e.message)).toEqual(['"fsales__customers" is a full name; refer to it by its short name']);
  });

  test('members a prefixed view includes are length-checked', () => {
    const longMember = 'average_order_value_bucket_for_lifetime_segment';
    const withAmount = simple('fsales', 'customers', [
      '      - name: amount',
      '        sql: amount',
      '        type: sum',
    ].join('\n'));
    const v = view('fsales', 'overview', `    cubes:\n      - join_path: customers\n        includes:\n          - name: amount\n            alias: ${longMember}\n        prefix: true\n`);
    const { errors } = publish({ tree, current: [], upserts: [withAmount, v], deletes: [] });
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(new RegExp(`Member customers_${longMember}'s SQL alias would be longer than 63`))]);
  });
});
