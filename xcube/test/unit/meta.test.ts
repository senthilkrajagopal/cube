import { PostgresQuery, prepareCompiler } from '@cubejs-backend/schema-compiler';

import { installPreAggregationMeta, PreAggregationMetaValidator } from '../../src/model/meta';

// eslint-disable-next-line global-require
const validators: { CubeValidator: unknown } = require('@cubejs-backend/schema-compiler/dist/src/compiler/CubeValidator');
const cubes = validators.CubeValidator;
// eslint-disable-next-line global-require
require('../../src/server');

/** A rollup with no time dimension, one with, and an original_sql, each with the `meta` given after `meta:`. */
const model = (meta?: string) => {
  const marked = meta ? `        meta:\n${meta.replace(/^/gm, '          ')}\n` : '';
  return `cubes:
  - name: c
    sql_table: t
    dimensions:
      - { name: k, sql: k, type: string, primary_key: true }
      - { name: g, sql: g, type: string }
      - { name: at, sql: at, type: time }
    measures:
      - { name: count, type: count }
    pre_aggregations:
      - name: by_g
        measures: [count]
        dimensions: [g]
        refresh_key: { every: 1 day }
${marked}      - name: by_day
        measures: [count]
        dimensions: [g]
        time_dimension: at
        granularity: day
        partition_granularity: month
${marked}      - name: source
        type: original_sql
${marked}`;
};

const written = 'writtenBy: dashboard-rollups\ndashboards: [d1, d2]\nversion: 3';

async function compile(content: string) {
  const prepared = prepareCompiler({
    localPath: () => '/nowhere',
    dataSchemaFiles: async () => [{ fileName: 'cubes/c.yml', content }],
  }, { standalone: true, allowNodeRequire: false });
  try {
    await prepared.compiler.compile();
  } catch (e: any) {
    return { prepared, error: e.message as string };
  }
  return { prepared, error: undefined };
}

const byG = { measures: ['c.count'], dimensions: ['c.g'] };
const byDay = { measures: ['c.count'], timeDimensions: [{ dimension: 'c.at', granularity: 'day', dateRange: ['2026-01-01', '2026-02-15'] }] };

/** What a query's rollup is built and matched from: its SQL, and its tables' names and load SQL. */
async function rollups(content: string, query: object) {
  const { error, prepared } = await compile(content);
  expect(error).toBeUndefined();
  const built = new PostgresQuery(prepared, { ...query, timezone: 'UTC' });
  const [sql] = built.buildSqlAndParams();
  return { sql, descriptions: built.preAggregations.preAggregationsDescription() };
}

describe('pre-aggregation meta', () => {
  const planner = process.env.CUBEJS_TESSERACT_SQL_PLANNER;
  afterAll(() => {
    if (planner === undefined) {
      delete process.env.CUBEJS_TESSERACT_SQL_PLANNER;
    } else {
      process.env.CUBEJS_TESSERACT_SQL_PLANNER = planner;
    }
  });

  test('the server compiles with it', () => {
    expect(validators.CubeValidator).toBe(PreAggregationMetaValidator);
  });

  test('Cube refuses a pre-aggregation meta', async () => {
    validators.CubeValidator = cubes;
    try {
      const { error } = await compile(model(written));
      expect(error).toContain('preAggregations.by_day.meta');
      expect(error).toContain('preAggregations.by_g');
    } finally {
      installPreAggregationMeta();
    }
  });

  test('every pre-aggregation takes a meta of any shape, kept on its definition', async () => {
    const { error, prepared: { cubeEvaluator } } = await compile(model(written));
    expect(error).toBeUndefined();
    const meta = { writtenBy: 'dashboard-rollups', dashboards: ['d1', 'd2'], version: 3 };
    expect(Object.fromEntries(cubeEvaluator.preAggregations({}).map(p => [p.preAggregationName, p.preAggregation.meta])))
      .toEqual({ by_g: meta, by_day: meta, source: meta });
    // A scalar, or nothing, as Joi.any() takes.
    expect((await compile(model('7').replace(/meta:\n\s+7/g, 'meta: 7'))).error).toBeUndefined();
    expect((await compile(model('7').replace(/meta:\n\s+7/g, 'meta:'))).error).toBeUndefined();
  });

  test('the rest of a pre-aggregation is checked as Cube checks it', async () => {
    const bad = (content: string) => content.replace('granularity: day', 'granularity: fortnight').replace('refresh_key:', 'refresh_keys:');
    const { error } = await compile(bad(model(written)));
    expect(error).toBeDefined();
    expect(error).not.toContain('.meta');
    expect(error).toEqual((await compile(bad(model()))).error);
  });

  // The SQL cache is per model, and each compile here is a model of its own.
  test.each([['tesseract', 'true'], ['legacy', 'false']])('with the %s planner, a rollup is built and matched as with no meta', async (_name, flag) => {
    process.env.CUBEJS_TESSERACT_SQL_PLANNER = flag;
    for (const query of [byG, byDay]) {
      const plain = await rollups(model(), query);
      expect(plain.descriptions.length).toBeGreaterThan(0);
      expect(plain.sql).toContain('c_by_');
      expect(await rollups(model(written), query)).toEqual(plain);
      expect(await rollups(model('writtenBy: someone-else\nversion: 4'), query)).toEqual(plain);
    }
  });
});
