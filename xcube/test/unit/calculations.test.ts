import yaml from 'js-yaml';

import {
  calcVersion, companionName, companionsOf, refusalOf, withCompanions, type CalcSpec,
} from '../../src/calcs/companions';
import { CalculationError, planCalculations } from '../../src/calcs/requests';

const cube = `cubes:
  - name: orders
    sql_table: t
    dimensions:
      - name: created_at
        sql: created_at
        type: time
      - name: category
        sql: category
        type: string
    measures:
      - name: count
        type: count
      - name: customers
        sql: customer
        type: count_distinct
        filters:
          - sql: "{CUBE}.active"
      - name: avg_amount
        sql: amount
        type: avg
    access_policy:
      - role: "*"
        member_level:
          includes:
            - count
            - category
`;
const child = 'cubes:\n  - name: big_orders\n    extends: orders\n';
const view = `views:
  - name: v
    cubes:
      - join_path: orders
        includes:
          - count
          - name: customers
            alias: buyers
      - join_path: orders
        prefix: true
        includes: "*"
        excludes:
          - avg_amount
`;
const files = [
  { path: 'orders.yml', content: cube },
  { path: 'big_orders.yml', content: child },
  { path: 'v.yml', content: view },
];
const spec = (over: Partial<CalcSpec>): CalcSpec => ({ cube: 'orders', measure: 'count', kind: 'rank', granularity: '', periods: 0, ...over });

describe('quick calculations: companions', () => {
  test('names are the measure\'s, marked, with the calculation and its granularity or periods', () => {
    expect(companionName(spec({ kind: 'pct_of_total' }))).toBe('count__xc_pct_of_total');
    expect(companionName(spec({ kind: 'difference', granularity: 'month' }))).toBe('count__xc_diff_month');
    expect(companionName(spec({ kind: 'moving_average', granularity: 'week', periods: 6 }))).toBe('count__xc_ma6_week');
    expect(calcVersion([])).toBeUndefined();
    expect(calcVersion([spec({}), spec({ kind: 'pct_of_total' })])).toBe(calcVersion([spec({ kind: 'pct_of_total' }), spec({})]));
  });

  test('a calculation takes only the types it is correct for, never a calculation already', () => {
    expect(refusalOf('pct_of_total', { type: 'sum' })).toBeUndefined();
    expect(refusalOf('pct_of_total', { type: 'avg' })).toMatch(/avg/);
    expect(refusalOf('running_total', { type: 'count_distinct' })).toBeUndefined();
    expect(refusalOf('running_total', { type: 'max' })).toMatch(/max/);
    expect(refusalOf('moving_average', { type: 'number' })).toMatch(/number/);
    expect(refusalOf('previous_period', { type: 'avg' })).toBeUndefined();
    expect(refusalOf('rank', { type: 'sum', multi_stage: true })).toMatch(/multi-stage/);
  });

  test('a distinct count\'s running total counts the rows so far; a count\'s adds up its periods\'', () => {
    const [distinct] = companionsOf(spec({ measure: 'customers', kind: 'running_total', granularity: 'month' }), {
      name: 'customers', type: 'count_distinct', sql: 'customer', filters: [{ sql: '{CUBE}.active' }],
    });
    expect(distinct).toMatchObject({ type: 'count_distinct', sql: 'customer', filters: [{ sql: '{CUBE}.active' }], rolling_window: { trailing: 'unbounded' } });
    expect(distinct.multi_stage).toBeUndefined();
    const [counted] = companionsOf(spec({ kind: 'running_total', granularity: 'month' }), { name: 'count', type: 'count' });
    expect(counted).toMatchObject({ multi_stage: true, sql: '{count}', type: 'sum', rolling_window: { trailing: 'unbounded' } });
  });

  test('added to the cube, its child\'s inherited measure, the policy\'s explicit list, and the views listing the measure', () => {
    const served = withCompanions(files, [
      spec({ kind: 'pct_of_total' }),
      spec({ measure: 'customers', kind: 'rank' }),
      spec({ cube: 'big_orders', kind: 'rank' }),
      // A measure gone, and a type refused: nothing added for them.
      spec({ measure: 'gone' }),
      spec({ measure: 'avg_amount', kind: 'running_total', granularity: 'month' }),
    ]);
    const [orders, big, v] = served.files.map((f) => yaml.load(f.content) as any);
    const measures = (doc: any) => doc.cubes[0].measures.map((m: any) => m.name);
    expect(measures(orders)).toEqual(['count', 'customers', 'avg_amount', 'count__xc_total', 'count__xc_pct_of_total', 'customers__xc_rank']);
    expect(measures(big)).toEqual(['count__xc_rank']);
    expect(orders.cubes[0].access_policy[0].member_level.includes).toEqual(['count', 'category', 'count__xc_total', 'count__xc_pct_of_total']);
    const [listed, starred] = v.views[0].cubes;
    expect(listed.includes).toEqual([
      'count', { name: 'customers', alias: 'buyers' }, 'count__xc_total', 'count__xc_pct_of_total', { name: 'customers__xc_rank', alias: 'buyers__xc_rank' },
    ]);
    expect(starred.includes).toBe('*');
    expect([...served.salts.keys()].sort()).toEqual(['big_orders.yml', 'orders.yml', 'v.yml']);
    expect(withCompanions(files, []).files).toBe(files);
  });
});

describe('quick calculations: a query\'s calculations', () => {
  const month = { dimension: 'orders.created_at', granularity: 'month', dateRange: ['2024-03-01', '2024-06-30'] };

  test('asked for in place of their measures, in measures and order; a running total also filters on its range', () => {
    const plan = planCalculations({
      measures: ['orders.count', 'orders.customers'],
      timeDimensions: [month],
      order: { 'orders.count': 'desc' },
      calculations: [{ measure: 'orders.count', kind: 'running_total' }],
    }, files);
    expect(plan.specs).toEqual([spec({ kind: 'running_total', granularity: 'month' })]);
    expect(plan.query).toEqual({
      measures: ['orders.count__xc_running_total', 'orders.customers'],
      timeDimensions: [month],
      order: { 'orders.count__xc_running_total': 'desc' },
      filters: [{ member: 'orders.created_at', operator: 'inDateRange', values: ['2024-03-01', '2024-06-30'] }],
    });
    expect(plan.columns).toEqual([{ measure: 'orders.count', kind: 'running_total', member: 'orders.count__xc_running_total' }]);
  });

  test('through a view: the cube\'s measure, under the view\'s name for it, alias and prefix alike', () => {
    const aliased = planCalculations({ measures: ['v.buyers'], calculations: [{ measure: 'v.buyers', kind: 'rank' }] }, files);
    expect(aliased.specs).toEqual([spec({ measure: 'customers' })]);
    expect(aliased.query.measures).toEqual(['v.buyers__xc_rank']);
    const prefixed = planCalculations({ measures: ['v.orders_count'], calculations: [{ measure: 'v.orders_count', kind: 'pct_of_total' }] }, files);
    expect(prefixed.query.measures).toEqual(['v.orders_count__xc_pct_of_total']);
    // Excluded from the view: not its member.
    expect(() => planCalculations({ measures: ['v.orders_avg_amount'], calculations: [{ measure: 'v.orders_avg_amount', kind: 'rank' }] }, files))
      .toThrow(CalculationError);
  });

  test('a period calculation takes the query\'s one granularity, a supported one', () => {
    const reasons = (query: any) => {
      try {
        planCalculations(query, files);
        return [];
      } catch (e: any) {
        return e.refusals.map((r: any) => r.reason);
      }
    };
    expect(reasons({ measures: ['orders.count'], calculations: [{ measure: 'orders.count', kind: 'difference' }] })).toEqual(['granularity']);
    expect(reasons({
      measures: ['orders.count'],
      timeDimensions: [{ ...month, granularity: 'fiscal_week' }],
      calculations: [{ measure: 'orders.count', kind: 'difference' }],
    })).toEqual(['granularity']);
    expect(reasons({
      measures: ['orders.count'],
      timeDimensions: [month, { dimension: 'orders.created_at', granularity: 'year' }],
      calculations: [{ measure: 'orders.count', kind: 'moving_average', periods: 3 }],
    })).toEqual(['granularity']);
    expect(reasons({ measures: ['orders.count'], timeDimensions: [month], calculations: [{ measure: 'orders.count', kind: 'moving_average', periods: 12 }] })).toEqual([]);
    expect(reasons({ measures: ['orders.count'], calculations: 'rank' })).toEqual(['kind']);
  });
});
