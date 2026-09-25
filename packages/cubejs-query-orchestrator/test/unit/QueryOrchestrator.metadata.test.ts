/* eslint-disable @typescript-eslint/no-explicit-any */
import { QueryOrchestrator } from '../../src';

/**
 * A driver as a real one behaves: `query` takes SQL and fails on anything
 * else, so a metadata operation only succeeds through the driver's own
 * metadata methods.
 */
class SqlOnlyDriver {
  public readonly queries: unknown[] = [];

  public getSchemas = jest.fn(async () => [{ schema_name: 'public' }]);

  public getTablesForSpecificSchemas = jest.fn(async (schemas: any[]) => schemas.map(({ schema_name: schema }) => ({
    schema_name: schema,
    table_name: 'orders',
    table_type: 'BASE TABLE',
  })));

  public getColumnsForSpecificTables = jest.fn(async (tables: any[]) => tables.map(({ schema_name: schema, table_name: table }) => ({
    schema_name: schema,
    table_name: table,
    column_name: 'id',
    data_type: 'integer',
  })));

  public tablesSchema = jest.fn(async () => ({ public: { orders: [{ name: 'id', type: 'integer', attributes: [] }] } }));

  public async query(query: unknown) {
    this.queries.push(query);
    if (typeof query !== 'string') {
      throw new Error(`syntax error at or near "${String(query)}"`);
    }
    return [];
  }

  public async testConnection() {
    return undefined;
  }

  public async release() {
    return undefined;
  }
}

describe('QueryOrchestrator data source metadata', () => {
  let driver: SqlOnlyDriver;
  let orchestrator: QueryOrchestrator;

  beforeEach(() => {
    driver = new SqlOnlyDriver();
    orchestrator = new QueryOrchestrator(
      'ORCHESTRATOR_METADATA_TEST',
      async () => driver as any,
      () => undefined,
      {
        cacheAndQueueDriver: 'memory',
        continueWaitTimeout: 5,
        queryCacheOptions: {
          queueOptions: () => ({ concurrency: 2, processUid: 'metadata_test' }),
        },
        preAggregationsOptions: {
          queueOptions: () => ({ concurrency: 2, processUid: 'metadata_test' }),
        },
      }
    );
  });

  afterEach(async () => {
    await orchestrator.cleanup();
  });

  test('lists schemas through the driver\'s getSchemas, never as SQL', async () => {
    await expect(orchestrator.queryDataSourceSchemas()).resolves.toEqual([{ schema_name: 'public' }]);
    expect(driver.getSchemas).toHaveBeenCalledTimes(1);
    expect(driver.queries).toEqual([]);
  });

  test('lists tables through getTablesForSpecificSchemas', async () => {
    await expect(orchestrator.queryTablesForSchemas([{ schema_name: 'public' }])).resolves.toEqual([
      { schema_name: 'public', table_name: 'orders', table_type: 'BASE TABLE' },
    ]);
    expect(driver.getTablesForSpecificSchemas).toHaveBeenCalledWith([{ schema_name: 'public' }]);
    expect(driver.queries).toEqual([]);
  });

  test('lists columns through getColumnsForSpecificTables', async () => {
    await expect(orchestrator.queryColumnsForTables([{ schema_name: 'public', table_name: 'orders' }])).resolves.toEqual([
      { schema_name: 'public', table_name: 'orders', column_name: 'id', data_type: 'integer' },
    ]);
    expect(driver.getColumnsForSpecificTables).toHaveBeenCalledWith([{ schema_name: 'public', table_name: 'orders' }]);
    expect(driver.queries).toEqual([]);
  });

  test('reads the whole catalog through tablesSchema', async () => {
    await expect(orchestrator.queryDataSourceTablesSchema()).resolves.toEqual({
      public: { orders: [{ name: 'id', type: 'integer', attributes: [] }] },
    });
    expect(driver.tablesSchema).toHaveBeenCalledTimes(1);
    expect(driver.queries).toEqual([]);
  });

  test('answers a driver\'s failure with its error', async () => {
    driver.getSchemas.mockRejectedValueOnce(new Error('connection refused'));

    await expect(orchestrator.queryDataSourceSchemas()).rejects.toThrow('connection refused');
  });
});
