/**
 * The catalog reads against real databases, through Cube's published
 * drivers. DuckDB always runs, in process; the others run when their
 * environment variables name a database to use:
 *
 *   INTROSPECTION_TEST_POSTGRES=host:port   (user, password, database: test)
 *   INTROSPECTION_TEST_MYSQL=host:port      (user root, password test, database test)
 *   INTROSPECTION_TEST_TRINO=host:port      (its tpch catalog, as user presto)
 */
import { BaseDriver } from '@cubejs-backend/base-driver';
import { DuckDBDriver } from '@cubejs-backend/duckdb-driver';
import { MySqlDriver } from '@cubejs-backend/mysql-driver';
import { PostgresDriver } from '@cubejs-backend/postgres-driver';
import { TrinoDriver } from '@cubejs-backend/trino-driver';

import { runCatalogOperation } from '../../src';

jest.setTimeout(60 * 1000);

const read = (driver: BaseDriver, operation: 'schemas' | 'tables' | 'columns', params: Record<string, any> = {}) => (
  runCatalogOperation(driver, { operation, params, dataSource: 'default' }) as Promise<any[]>
);

const hostPort = (name: string) => {
  const value = process.env[name];
  if (!value) {
    return null;
  }
  const [host, port] = value.split(':');
  return { host, port: Number(port) };
};

const describeIf = (condition: unknown) => (condition ? describe : describe.skip);

describe('DuckDB', () => {
  const initSql = [
    'CREATE SCHEMA sales',
    'CREATE TABLE sales.orders (id INTEGER PRIMARY KEY, amount DECIMAL(10, 2), placed_at TIMESTAMP)',
    'CREATE VIEW sales.big_orders AS SELECT * FROM sales.orders WHERE amount > 100',
    "ATTACH ':memory:' AS other",
    'CREATE SCHEMA other.sales',
    'CREATE TABLE other.sales.returns (id INTEGER)',
  ].join('; ');

  test('lists schemas, tables with their types, and columns', async () => {
    const driver = new DuckDBDriver({ initSql });

    try {
      expect(await read(driver, 'schemas')).toContainEqual({ schema_name: 'sales' });
      expect(await read(driver, 'tables', { schemas: [{ schema_name: 'sales' }] })).toEqual(expect.arrayContaining([
        { schema_name: 'sales', table_name: 'orders', table_type: 'BASE TABLE' },
        { schema_name: 'sales', table_name: 'big_orders', table_type: 'VIEW' },
      ]));

      const columns = await read(driver, 'columns', { tables: [{ schema_name: 'sales', table_name: 'orders' }] });
      expect(columns.map(({ column_name: name, data_type: type }) => [name, type])).toEqual([
        ['id', 'INTEGER'],
        ['amount', 'DECIMAL(10,2)'],
        ['placed_at', 'TIMESTAMP'],
      ]);
    } finally {
      await driver.release();
    }
  });

  test('keeps to the configured catalog', async () => {
    const driver = new DuckDBDriver({ initSql, schema: 'memory' });

    try {
      const tables = await read(driver, 'tables', { schemas: [{ schema_name: 'sales' }] });
      expect(tables.map(t => t.table_name).sort()).toEqual(['big_orders', 'orders']);
      expect(await read(driver, 'columns', { tables: [{ schema_name: 'sales', table_name: 'returns' }] })).toEqual([]);
    } finally {
      await driver.release();
    }
  });
});

const postgres = hostPort('INTROSPECTION_TEST_POSTGRES');

describeIf(postgres)('Postgres', () => {
  let driver: PostgresDriver;

  beforeAll(async () => {
    driver = new PostgresDriver({ ...postgres!, user: 'test', password: 'test', database: 'test' });
    await driver.query('DROP SCHEMA IF EXISTS introspection CASCADE', []);
    await driver.query('CREATE SCHEMA introspection', []);
    await driver.query('CREATE TABLE introspection.customers (id serial PRIMARY KEY, name text)', []);
    await driver.query(
      'CREATE TABLE introspection.orders (id serial PRIMARY KEY, customer_id integer REFERENCES introspection.customers(id))',
      []
    );
    await driver.query('CREATE VIEW introspection.customer_names AS SELECT name FROM introspection.customers', []);
    await driver.query(
      'CREATE MATERIALIZED VIEW introspection.orders_per_customer AS ' +
      'SELECT customer_id, count(*) AS order_count, now() AS refreshed_at FROM introspection.orders GROUP BY 1',
      []
    );
  });

  afterAll(async () => {
    await driver.release();
  });

  test('says what each relation is, materialized views included', async () => {
    expect(await read(driver, 'tables', { schemas: [{ schema_name: 'introspection' }] })).toEqual(expect.arrayContaining([
      { schema_name: 'introspection', table_name: 'customers', table_type: 'BASE TABLE' },
      { schema_name: 'introspection', table_name: 'customer_names', table_type: 'VIEW' },
      { schema_name: 'introspection', table_name: 'orders_per_customer', table_type: 'MATERIALIZED VIEW' },
    ]));
  });

  test('gives a materialized view\'s columns, in order', async () => {
    const columns = await read(driver, 'columns', { tables: [{ schema_name: 'introspection', table_name: 'orders_per_customer' }] });

    expect(columns.map(({ column_name: name, data_type: type }) => [name, type])).toEqual([
      ['customer_id', 'integer'],
      ['order_count', 'bigint'],
      ['refreshed_at', 'timestamp with time zone'],
    ]);
  });

  test('gives a column its foreign key, with its schema, when the referenced table isn\'t asked for', async () => {
    const columns = await read(driver, 'columns', { tables: [{ schema_name: 'introspection', table_name: 'orders' }] });

    expect(columns.map(c => c.column_name)).toEqual(['id', 'customer_id']);
    expect(columns.find(c => c.column_name === 'customer_id').foreign_keys).toEqual([
      { target_schema: 'introspection', target_table: 'customers', target_column: 'id' },
    ]);
    expect(columns.find(c => c.column_name === 'id').attributes).toEqual(['primaryKey']);
  });

  test('leaves the driver Cube queries with as it was', async () => {
    const upstream = await driver.getTablesForSpecificSchemas([{ schema_name: 'introspection' }]);

    expect(upstream).toContainEqual({ schema_name: 'introspection', table_name: 'customers' });
    expect(upstream.map(t => t.table_name)).not.toContain('orders_per_customer');
  });
});

const mysql = hostPort('INTROSPECTION_TEST_MYSQL');

describeIf(mysql)('MySQL', () => {
  let driver: MySqlDriver;

  beforeAll(async () => {
    driver = new MySqlDriver({ ...mysql!, user: 'root', password: 'test', database: 'test' } as any);
    await driver.query('DROP DATABASE IF EXISTS introspection', []);
    await driver.query('CREATE DATABASE introspection', []);
    await driver.query('CREATE TABLE introspection.customers (id int PRIMARY KEY, name text)', []);
    await driver.query(
      'CREATE TABLE introspection.orders (id int PRIMARY KEY, customer_id int, ' +
      'CONSTRAINT orders_customer FOREIGN KEY (customer_id) REFERENCES introspection.customers (id))',
      []
    );
    await driver.query('CREATE VIEW introspection.customer_names AS SELECT name FROM introspection.customers', []);
  });

  afterAll(async () => {
    await driver.release();
  });

  test('says whether each relation is a table or a view', async () => {
    expect(await read(driver, 'tables', { schemas: [{ schema_name: 'introspection' }] })).toEqual(expect.arrayContaining([
      { schema_name: 'introspection', table_name: 'orders', table_type: 'BASE TABLE' },
      { schema_name: 'introspection', table_name: 'customer_names', table_type: 'VIEW' },
    ]));
  });

  test('gives each column its primary key and the table and column its foreign key references', async () => {
    const columns = await read(driver, 'columns', { tables: [{ schema_name: 'introspection', table_name: 'orders' }] });

    expect(columns.find(c => c.column_name === 'id').attributes).toEqual(['primaryKey']);
    expect(columns.find(c => c.column_name === 'id').foreign_keys).toEqual([]);
    expect(columns.find(c => c.column_name === 'customer_id').foreign_keys).toEqual([
      { target_schema: 'introspection', target_table: 'customers', target_column: 'id' },
    ]);
  });
});

const trino = hostPort('INTROSPECTION_TEST_TRINO');

describeIf(trino)('Trino', () => {
  test('lists schemas, tables with their types, and columns', async () => {
    const driver = new TrinoDriver({
      ...trino!,
      catalog: 'tpch',
      schema: 'sf1',
      basic_auth: { user: 'presto', password: '' },
    } as any);

    expect(await read(driver, 'schemas')).toContainEqual({ schema_name: 'sf1' });
    expect(await read(driver, 'tables', { schemas: [{ schema_name: 'sf1' }] }))
      .toContainEqual({ schema_name: 'sf1', table_name: 'orders', table_type: 'BASE TABLE' });

    const columns = await read(driver, 'columns', { tables: [{ schema_name: 'sf1', table_name: 'orders' }] });
    expect(columns).toContainEqual(expect.objectContaining({ column_name: 'orderkey', data_type: 'bigint' }));
    expect(columns.every(c => c.table_name === 'orders')).toBe(true);
  });
});
