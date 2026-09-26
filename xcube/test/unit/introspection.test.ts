import { CubejsHandlerError } from '@cubejs-backend/api-gateway';

import { CatalogReader, DataSourceIntrospection, tableTypeOf } from '../../src';

const CATALOG = {
  public: {
    orders: [
      { name: 'id', type: 'integer', attributes: ['primaryKey'] },
      { name: 'status', type: 'character varying', attributes: [] },
      { name: 'created_at', type: 'timestamp without time zone', attributes: [] },
      { name: 'total_amount', type: 'numeric', attributes: [] },
      { name: 'quantity_shipped_ratio_x', type: 'double precision', attributes: [] },
      { name: '_loaded_at', type: 'timestamp', attributes: [] },
      { name: 'customer_id', type: 'integer', attributes: [] },
    ],
    customers: [
      { name: 'id', type: 'integer', attributes: ['primaryKey'] },
      { name: 'name', type: 'text', attributes: [] },
    ],
  },
  sales: {
    orders: [
      { name: 'id', type: 'integer', attributes: [] },
    ],
  },
};

const TABLE_TYPES = {
  'public.orders': 'BASE TABLE',
  'public.customers': 'VIEW',
  'sales.orders': 'MATERIALIZED VIEW',
};

const driver = (incrementalSchemaLoading: boolean) => ({
  capabilities: () => ({ incrementalSchemaLoading }),
  quoteIdentifier: (name: string) => `"${name}"`,
});

/**
 * An orchestrator that answers from CATALOG as a driver would: level by level
 * for the incremental methods, all at once for the tables schema.
 */
const orchestrator = () => ({
  queryDataSourceSchemas: jest.fn(async () => Object.keys(CATALOG).map(schema => ({ schema_name: schema }))),
  queryTablesForSchemas: jest.fn(async (schemas: { schema_name: string }[]) => schemas.flatMap(
    ({ schema_name: schema }) => Object.keys(CATALOG[schema] || {}).map(table => ({
      schema_name: schema,
      table_name: table,
      table_type: TABLE_TYPES[`${schema}.${table}`],
    }))
  )),
  queryColumnsForTables: jest.fn(async (tables: { schema_name: string, table_name: string }[]) => tables.flatMap(
    ({ schema_name: schema, table_name: table }) => (CATALOG[schema]?.[table] || []).map(column => ({
      schema_name: schema,
      table_name: table,
      column_name: column.name,
      data_type: column.type,
      attributes: column.attributes,
      foreign_keys: column.name === 'customer_id'
        ? [{ target_schema: 'public', target_table: 'customers', target_column: 'id' }]
        : [],
    }))
  )),
  queryDataSourceTablesSchema: jest.fn(async () => CATALOG),
});

/** Catalog reads, answered by the orchestrator above. */
const readerFor = (api: ReturnType<typeof orchestrator>): CatalogReader => (async (operation, params: any = {}) => {
  switch (operation) {
    case 'schemas':
      return api.queryDataSourceSchemas();
    case 'tables':
      return api.queryTablesForSchemas(params.schemas);
    case 'columns':
      return api.queryColumnsForTables(params.tables);
    case 'tablesSchema':
      return api.queryDataSourceTablesSchema();
    default:
      throw new Error(`Unexpected catalog read: ${operation}`);
  }
}) as CatalogReader;

const introspection = (
  { incremental = true, dataSource = 'default' }: { incremental?: boolean, dataSource?: string } = {}
) => {
  const api = orchestrator();
  return {
    api,
    introspection: new DataSourceIntrospection(readerFor(api), () => driver(incremental) as any, dataSource),
  };
};

describe('tableTypeOf', () => {
  test.each([
    ['BASE TABLE', 'table'],
    ['TABLE', 'table'],
    ['LOCAL TEMPORARY', 'table'],
    ['VIEW', 'view'],
    ['SYSTEM VIEW', 'view'],
    ['MATERIALIZED VIEW', 'materialized_view'],
    ['MATERIALIZED_VIEW', 'materialized_view'],
    ['EXTERNAL TABLE', 'external'],
    ['EXTERNAL', 'external'],
    ['FOREIGN', 'external'],
    ['view', 'view'],
  ])('%s is a %s', (rawType, type) => {
    expect(tableTypeOf(rawType)).toEqual(type);
  });

  test('is unknown when the driver says nothing', () => {
    expect(tableTypeOf(undefined)).toBeNull();
    expect(tableTypeOf('')).toBeNull();
  });
});

describe('DataSourceIntrospection', () => {
  describe('with incremental schema loading', () => {
    test('lists schemas sorted, a level at a time', async () => {
      const { api, introspection: subject } = introspection({ dataSource: 'warehouse' });

      await expect(subject.schemas()).resolves.toEqual(['public', 'sales']);
      expect(api.queryDataSourceSchemas).toHaveBeenCalledTimes(1);
      expect(api.queryDataSourceTablesSchema).not.toHaveBeenCalled();
    });

    test('lists the tables of the schemas asked for, each with its type', async () => {
      const { api, introspection: subject } = introspection();

      await expect(subject.tables(['sales', 'public', 'public'])).resolves.toEqual([
        { schema: 'public', name: 'customers', type: 'view', rawType: 'VIEW' },
        { schema: 'public', name: 'orders', type: 'table', rawType: 'BASE TABLE' },
        { schema: 'sales', name: 'orders', type: 'materialized_view', rawType: 'MATERIALIZED VIEW' },
      ]);
      expect(api.queryTablesForSchemas).toHaveBeenCalledWith([{ schema_name: 'sales' }, { schema_name: 'public' }]);
    });

    test('lists no tables, and asks nothing, for no schemas', async () => {
      const { api, introspection: subject } = introspection();

      await expect(subject.tables([])).resolves.toEqual([]);
      expect(api.queryTablesForSchemas).not.toHaveBeenCalled();
    });

    test('gives each table\'s columns with raw and Cube types and keys, in the order asked for', async () => {
      const { introspection: subject } = introspection();

      const [customers, orders] = await subject.columns([
        { schema: 'public', table: 'customers' },
        { schema: 'public', table: 'orders' },
      ]);

      expect(customers).toEqual({
        schema: 'public',
        name: 'customers',
        columns: [
          { name: 'id', rawType: 'integer', type: 'number', primaryKey: true, foreignKeys: [] },
          { name: 'name', rawType: 'text', type: 'string', primaryKey: false, foreignKeys: [] },
        ],
      });
      expect(orders.columns.find(c => c.name === 'created_at')).toMatchObject({ type: 'time' });
      expect(orders.columns.find(c => c.name === 'customer_id')).toMatchObject({
        foreignKeys: [{ schema: 'public', table: 'customers', column: 'id' }],
      });
    });

    test('refuses with a 404 naming every table the data source doesn\'t have', async () => {
      const { introspection: subject } = introspection({ dataSource: 'warehouse' });

      const error = await subject.columns([
        { schema: 'public', table: 'orders' },
        { schema: 'public', table: 'missing' },
        { schema: 'nowhere', table: 'orders' },
      ]).catch(e => e);

      expect(error).toBeInstanceOf(CubejsHandlerError);
      expect(error.status).toEqual(404);
      expect(error.message).toEqual('The \'warehouse\' data source has no table public.missing, nowhere.orders');
    });
  });

  describe('without incremental schema loading', () => {
    test('reads schemas, tables and columns from the whole catalog', async () => {
      const { api, introspection: subject } = introspection({ incremental: false });

      await expect(subject.schemas()).resolves.toEqual(['public', 'sales']);
      await expect(subject.tables(['public'])).resolves.toEqual([
        { schema: 'public', name: 'customers', type: null, rawType: null },
        { schema: 'public', name: 'orders', type: null, rawType: null },
      ]);
      const [customers] = await subject.columns([{ schema: 'public', table: 'customers' }]);
      expect(customers.columns[0]).toEqual({
        name: 'id', rawType: 'integer', type: 'number', primaryKey: true, foreignKeys: [],
      });

      expect(api.queryDataSourceTablesSchema).toHaveBeenCalledTimes(3);
      expect(api.queryDataSourceSchemas).not.toHaveBeenCalled();
      expect(api.queryTablesForSchemas).not.toHaveBeenCalled();
      expect(api.queryColumnsForTables).not.toHaveBeenCalled();
    });
  });

  describe('scaffold', () => {
    test('generates a YAML cube per table with dimensions, measures, a count and joins between them', async () => {
      const { introspection: subject } = introspection();

      const cubes = await subject.scaffold(
        [{ schema: 'public', table: 'orders' }, { schema: 'public', table: 'customers' }],
        { format: 'yaml' },
      );

      expect(cubes.map(({ cube, fileName, table }) => ({ cube, fileName, table }))).toEqual([
        { cube: 'orders', fileName: 'orders.yml', table: { schema: 'public', table: 'orders' } },
        { cube: 'customers', fileName: 'customers.yml', table: { schema: 'public', table: 'customers' } },
      ]);

      const [orders] = cubes;
      expect(orders.content).toContain('sql_table: public.orders');
      expect(orders.content).toContain([
        '    joins:',
        '      - name: customers',
        '        sql: "{CUBE}.customer_id = {customers.id}"',
        '        relationship: many_to_one',
      ].join('\n'));
      expect(orders.content).toContain([
        '      - name: status',
        '        sql: status',
        '        type: string',
      ].join('\n'));
      expect(orders.content).toContain([
        '      - name: created_at',
        '        sql: created_at',
        '        type: time',
      ].join('\n'));
      expect(orders.content).toContain([
        '      - name: total_amount',
        '        sql: total_amount',
        '        type: sum',
      ].join('\n'));
      expect(orders.content).toContain('type: count');
      expect(orders.content).not.toContain('data_source');
    });

    test('reports every column the cube leaves out, and why', async () => {
      const { introspection: subject } = introspection();

      const [orders] = await subject.scaffold([{ schema: 'public', table: 'orders' }], { format: 'yaml' });

      expect(orders.unmappedColumns).toEqual([
        { name: 'quantity_shipped_ratio_x', rawType: 'double precision', reason: 'numeric_not_measure' },
        { name: '_loaded_at', rawType: 'timestamp', reason: 'underscore_prefix' },
        { name: 'customer_id', rawType: 'integer', reason: 'numeric_not_measure' },
      ]);
    });

    test('names the data source in each cube when it isn\'t the default', async () => {
      const { introspection: subject } = introspection({ dataSource: 'warehouse' });

      const [customers] = await subject.scaffold([{ schema: 'public', table: 'customers' }], { format: 'yaml' });

      expect(customers.content).toContain('data_source: warehouse');
    });

    test('generates JavaScript when asked', async () => {
      const { introspection: subject } = introspection();

      const [customers] = await subject.scaffold([{ schema: 'public', table: 'customers' }], { format: 'js' });

      expect(customers.fileName).toEqual('customers.js');
      expect(customers.content).toContain('cube(`customers`');
    });

    test('names tables of the same name after their schema, and joins them by that name', async () => {
      const { introspection: subject } = introspection();

      const cubes = await subject.scaffold(
        [{ schema: 'public', table: 'orders' }, { schema: 'sales', table: 'orders' }, { schema: 'public', table: 'customers' }],
        { format: 'yaml' },
      );

      expect(cubes.map(({ cube, fileName }) => [cube, fileName])).toEqual([
        ['public_orders', 'public_orders.yml'],
        ['sales_orders', 'sales_orders.yml'],
        ['customers', 'customers.yml'],
      ]);
      expect(cubes[0].content).toContain('- name: public_orders');
      expect(cubes[0].content).toContain('sql_table: public.orders');
      expect(cubes[0].content).toContain('sql: "{CUBE}.customer_id = {customers.id}"');
      expect(cubes[1].content).toContain('sql_table: sales.orders');
    });

    test('numbers a schema-qualified name that another table\'s cube already has', async () => {
      const api = orchestrator();
      api.queryColumnsForTables.mockImplementation(async (tables: { schema_name: string, table_name: string }[]) => tables.map(
        ({ schema_name: schema, table_name: table }) => ({
          schema_name: schema, table_name: table, column_name: 'id', data_type: 'integer', attributes: [], foreign_keys: [],
        })
      ));
      const subject = new DataSourceIntrospection(readerFor(api), () => driver(true) as any, 'default');

      const cubes = await subject.scaffold(
        [{ schema: 'a', table: 'b_c' }, { schema: 'x', table: 'b_c' }, { schema: 'y', table: 'a_b_c' }],
        { format: 'yaml' },
      );

      expect(cubes.map(({ cube }) => cube)).toEqual(['a_b_c_2', 'x_b_c', 'a_b_c']);
    });

    test('refuses with a 404 when a table is missing, generating nothing', async () => {
      const { introspection: subject } = introspection();

      await expect(subject.scaffold([{ schema: 'public', table: 'missing' }], { format: 'yaml' }))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  describe('a failed read', () => {
    test('is left as the reader answered it', async () => {
      const api = orchestrator();
      const failure = new Error('connection refused');
      api.queryDataSourceSchemas.mockImplementation(async () => {
        throw failure;
      });
      const subject = new DataSourceIntrospection(readerFor(api), () => driver(true) as any, 'default');

      await expect(subject.schemas()).rejects.toBe(failure);
    });

    test('passes the queue\'s Continue wait through for the gateway', async () => {
      const api = orchestrator();
      api.queryColumnsForTables.mockImplementation(async () => {
        // eslint-disable-next-line no-throw-literal
        throw { error: 'Continue wait' };
      });
      const subject = new DataSourceIntrospection(readerFor(api), () => driver(true) as any, 'default');

      await expect(subject.scaffold([{ schema: 'public', table: 'orders' }], { format: 'yaml' }))
        .rejects.toEqual({ error: 'Continue wait' });
    });
  });
});
