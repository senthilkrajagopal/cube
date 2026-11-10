/**
 * Time series derived from the data, on DuckDB (`src/model/dialects.ts`): a
 * rolling window and a time shift with no date range compile with Tesseract,
 * and DuckDB runs what they compile to, over the periods from the data's first
 * to its last. Runs on an in-process DuckDB.
 */
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { prepareCompiler } from '@cubejs-backend/schema-compiler';
import { DuckDBDriver } from '@cubejs-backend/duckdb-driver';
import { PostgresDriver } from '@cubejs-backend/postgres-driver';

import { dialectFactory, xcubeDuckDBQuery } from '../../src/model/dialects';

jest.setTimeout(60 * 1000);

const model = `cubes:
  - name: f
    sql_table: main.facts
    dimensions:
      - { name: id, sql: id, type: number, primary_key: true }
      - { name: at, sql: ts, type: time }
    measures:
      - { name: total, sql: amount, type: sum }
      - name: trailing
        sql: amount
        type: sum
        rolling_window: { trailing: 2 month }
      - name: running
        sql: amount
        type: sum
        rolling_window: { trailing: unbounded }
      - name: total_prior
        multi_stage: true
        sql: "{total}"
        type: number
        time_shift:
          - interval: 1 month
            type: prior
`;

/** January, March and April have rows; February has none, and is a period of the series all the same. */
const FACTS = `CREATE TABLE main.facts AS SELECT * FROM (VALUES
  (1, TIMESTAMP '2024-01-15 10:00:00', 10),
  (2, TIMESTAMP '2024-01-20 00:00:00', 5),
  (3, TIMESTAMP '2024-03-03 12:30:00', 7),
  (4, TIMESTAMP '2024-04-10 23:59:59', 1)
) AS t(id, ts, amount)`;

describe('DuckDB time series from the data', () => {
  let instance: DuckDBInstance;
  let connection: DuckDBConnection;
  let compiled: any;
  const planner = process.env.CUBEJS_TESSERACT_SQL_PLANNER;

  beforeAll(async () => {
    process.env.CUBEJS_TESSERACT_SQL_PLANNER = 'true';
    instance = await DuckDBInstance.create(':memory:');
    connection = await instance.connect();
    await connection.run('SET TimeZone = \'America/Los_Angeles\'');
    await connection.run(FACTS);
    compiled = prepareCompiler({
      localPath: () => '/nowhere',
      dataSchemaFiles: async () => [{ fileName: 'cubes/f.yml', content: model }],
    }, { standalone: true, allowNodeRequire: false });
    await compiled.compiler.compile();
  });

  afterAll(() => {
    connection?.closeSync();
    instance?.closeSync();
    if (planner === undefined) {
      delete process.env.CUBEJS_TESSERACT_SQL_PLANNER;
    } else {
      process.env.CUBEJS_TESSERACT_SQL_PLANNER = planner;
    }
  });

  /** The query's rows on DuckDB, by month, as `{ month: value }` of its one measure. */
  async function byMonth(measure: string, granularity = 'month') {
    const Dialect = xcubeDuckDBQuery();
    const query = new Dialect(compiled, {
      measures: [`f.${measure}`],
      timeDimensions: [{ dimension: 'f.at', granularity }],
      order: [[`f.at.${granularity}`, 'asc']],
      timezone: 'UTC',
    });
    const [sql, params] = query.buildSqlAndParams();
    const reader = await connection.runAndReadAll(sql, params);
    const rows = reader.getRowObjectsJS() as Record<string, unknown>[];
    return Object.fromEntries(rows.map((row) => {
      const values = Object.values(row);
      const at = values[0] instanceof Date ? values[0].toISOString().slice(0, 10) : String(values[0]).slice(0, 10);
      return [at, values[1] === null ? null : Number(values[1])];
    }));
  }

  test('Cube\'s own DuckDB dialect refuses one without a date range', async () => {
    const Dialect = DuckDBDriver.dialectClass() as any;
    const query = new Dialect(compiled, { measures: ['f.trailing'], timeDimensions: [{ dimension: 'f.at', granularity: 'month' }], timezone: 'UTC' });
    expect(() => query.buildSqlAndParams()).toThrow('Date range is required for time series');
  });

  test('a trailing rolling window covers every month from the first row\'s to the last\'s', async () => {
    expect(await byMonth('trailing')).toEqual({
      '2024-01-01': 15, '2024-02-01': 15, '2024-03-01': 7, '2024-04-01': 8,
    });
  });

  test('an unbounded one runs to date', async () => {
    expect(await byMonth('running')).toEqual({
      '2024-01-01': 15, '2024-02-01': 15, '2024-03-01': 22, '2024-04-01': 23,
    });
  });

  test('a time shift reads the period before, the month with no rows included', async () => {
    const prior = await byMonth('total_prior');
    expect(prior['2024-02-01']).toBe(15);
    expect(prior['2024-04-01']).toBe(7);
    expect(prior['2024-03-01'] ?? null).toBeNull();
  });

  test('by quarter, and by week, whose periods DuckDB counts from the data alike', async () => {
    expect(await byMonth('running', 'quarter')).toEqual({ '2024-01-01': 22, '2024-04-01': 23 });
    const weeks = await byMonth('running', 'week');
    expect(Object.keys(weeks)[0]).toBe('2024-01-15');
    expect(Object.values(weeks).at(-1)).toBe(23);
  });

  test('cube.js\'s own dialect comes first; other drivers keep theirs', () => {
    const Mine = class {};
    expect(dialectFactory(() => Mine as any)({ dbType: 'duckdb' })).toBe(Mine);
    expect(dialectFactory()({ dbType: 'duckdb' })).toBe(xcubeDuckDBQuery());
    expect(dialectFactory()({ dbType: 'postgres' })).toBe((PostgresDriver as any).dialectClass?.());
  });
});
