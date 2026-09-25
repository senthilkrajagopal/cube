import { PostgresDBRunner } from '@cubejs-backend/testing-shared';
import { StartedTestContainer } from 'testcontainers';
import { PostgresDriver } from '../src';

const streamToArray = require('stream-to-array');

function largeParams(): Array<string> {
  return new Array(65536).fill('foo');
}

describe('PostgresDriver', () => {
  let container: StartedTestContainer;
  let driver: PostgresDriver;

  jest.setTimeout(2 * 60 * 1000);

  beforeAll(async () => {
    container = await PostgresDBRunner.startContainer({ volumes: [] });
    driver = new PostgresDriver({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: 'test',
      password: 'test',
      database: 'test',
    });
    await driver.query('CREATE SCHEMA IF NOT EXISTS test;', []);
  });

  afterAll(async () => {
    await container.stop();
  });

  test('type coercion', async () => {
    await driver.query('CREATE TYPE CUBEJS_TEST_ENUM AS ENUM (\'FOO\');', []);

    const data = await driver.query(
      `
        SELECT
          CAST('2020-01-01' as DATE) as date,
          CAST('2020-01-01 00:00:00' as TIMESTAMP) as timestamp,
          CAST('2020-01-01 00:00:00+02' as TIMESTAMPTZ) as timestamptz,
          CAST('1.0' as DECIMAL(10,2)) as decimal,
          CAST('FOO' as CUBEJS_TEST_ENUM) as enum
      `,
      []
    );

    expect(data).toEqual([
      {
        // Date in UTC
        date: '2020-01-01T00:00:00.000',
        timestamp: '2020-01-01T00:00:00.000',
        // converted to utc
        timestamptz: '2019-12-31T22:00:00.000',
        // Numerics as string
        decimal: '1.00',
        // Enum datatypes as string
        enum: 'FOO',
      }
    ]);
  });

  test('too many params', async () => {
    await expect(
      driver.query(`SELECT 'foo'::TEXT;`, largeParams())
    )
      .rejects
      .toThrow('PostgreSQL protocol does not support more than 65535 parameters, but 65536 passed');
  });

  test('stream', async () => {
    await driver.uploadTable(
      'test.streaming_test',
      [
        { name: 'id', type: 'bigint' },
        { name: 'created', type: 'date' },
        { name: 'price', type: 'decimal' }
      ],
      {
        rows: [
          { id: 1, created: '2020-01-01', price: '100' },
          { id: 2, created: '2020-01-02', price: '200' },
          { id: 3, created: '2020-01-03', price: '300' }
        ]
      }
    );

    const tableData = await driver.stream('select * from test.streaming_test', [], {
      highWaterMark: 1000,
    });

    try {
      expect(await tableData.types).toEqual([
        {
          name: 'id',
          type: 'bigint'
        },
        {
          name: 'created',
          type: 'date'
        },
        {
          name: 'price',
          type: 'decimal'
        },
      ]);
      expect(await streamToArray(tableData.rowStream)).toEqual([
        { id: '1', created: '2020-01-01T00:00:00.000', price: '100' },
        { id: '2', created: '2020-01-02T00:00:00.000', price: '200' },
        { id: '3', created: '2020-01-03T00:00:00.000', price: '300' }
      ]);
    } finally {
      await (<any> tableData).release();
    }
  });

  test('stream (array-typed columns)', async () => {
    // Streaming must not fail when a query returns array-typed columns.
    // Array types are reported as `text` and node-postgres parses them into
    // JS arrays. See CORE-522.
    const tableData = await driver.stream(
      `SELECT
        ARRAY['oops', 'test']::text[] as text_array,
        ARRAY[1, 2, 3]::int[] as int_array`,
      [],
      {
        highWaterMark: 1000,
      }
    );

    try {
      expect(await tableData.types).toEqual([
        {
          name: 'text_array',
          type: 'text'
        },
        {
          name: 'int_array',
          type: 'text'
        },
      ]);
      expect(await streamToArray(tableData.rowStream)).toEqual([
        { text_array: ['oops', 'test'], int_array: [1, 2, 3] },
      ]);
    } finally {
      await (<any> tableData).release();
    }
  });

  test('stream (user defined type)', async () => {
    await driver.query('CREATE TYPE CUBEJS_TEST_POINT AS (x int, y int);', []);
    // Postgres reports the base type oid in RowDescription rather than the domain one.
    await driver.query('CREATE DOMAIN CUBEJS_TEST_INT AS int;', []);

    // A driver of its own, the shared one loaded its types before this type existed.
    const freshDriver = new PostgresDriver({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: 'test',
      password: 'test',
      database: 'test',
    });

    try {
      const tableData = await freshDriver.stream(
        `SELECT
          ARRAY[CAST(ROW(1, 2) as CUBEJS_TEST_POINT)] as points,
          CAST(5 as CUBEJS_TEST_INT) as aliased`,
        [],
        {
          highWaterMark: 1000,
        }
      );

      try {
        expect(await tableData.types).toEqual([
          {
            name: 'points',
            type: 'text'
          },
          {
            name: 'aliased',
            type: 'int'
          },
        ]);
        expect(await streamToArray(tableData.rowStream)).toEqual([
          { points: '{"(1,2)"}', aliased: 5 },
        ]);
      } finally {
        await (<any> tableData).release();
      }
    } finally {
      await freshDriver.release();
    }
  });

  test('stream (exception)', async () => {
    try {
      await driver.stream('select * from test.random_name_for_table_that_doesnot_exist_sql_must_fail', [], {
        highWaterMark: 1000,
      });

      throw new Error('stream must throw an exception');
    } catch (e: any) {
      expect(e.message).toEqual(
        'relation "test.random_name_for_table_that_doesnot_exist_sql_must_fail" does not exist'
      );
    }
  });

  test('stream (too many params)', async () => {
    try {
      await driver.stream('select * from test.streaming_test', largeParams(), {
        highWaterMark: 1000,
      });

      throw new Error('stream must throw an exception');
    } catch (e: any) {
      expect(e.message).toEqual(
        'PostgreSQL protocol does not support more than 65535 parameters, but 65536 passed'
      );
    }
  });

  test('table name check', async () => {
    const tblName = 'really-really-really-looooooooooooooooooooooooooooooooooooooooooooooooooooong-table-name';

    try {
      await driver.createTable(tblName, [{ name: 'id', type: 'bigint' }]);

      throw new Error('createTable must throw an exception');
    } catch (e: any) {
      expect(e.message).toEqual(
        'PostgreSQL can not work with table names longer than 63 symbols. ' +
        `Consider using the 'sqlAlias' attribute in your cube definition for ${tblName}.`
      );
    }
  });

  describe('schema introspection', () => {
    beforeAll(async () => {
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

    test('says whether each relation is a table or a view', async () => {
      const tables = await driver.getTablesForSpecificSchemas([{ schema_name: 'introspection' }]);

      expect(tables).toEqual(expect.arrayContaining([
        { schema_name: 'introspection', table_name: 'customers', table_type: 'BASE TABLE' },
        { schema_name: 'introspection', table_name: 'orders', table_type: 'BASE TABLE' },
        { schema_name: 'introspection', table_name: 'customer_names', table_type: 'VIEW' },
        { schema_name: 'introspection', table_name: 'orders_per_customer', table_type: 'MATERIALIZED VIEW' },
      ]));
    });

    test('gives a materialized view\'s columns, in order', async () => {
      const columns = await driver.getColumnsForSpecificTables([
        { schema_name: 'introspection', table_name: 'orders_per_customer' },
      ]);

      expect(columns.map(({ column_name: name, data_type: type }) => [name, type])).toEqual([
        ['customer_id', 'integer'],
        ['order_count', 'bigint'],
        ['refreshed_at', 'timestamp with time zone'],
      ]);
    });

    test('gives a table\'s columns in order', async () => {
      const columns = await driver.getColumnsForSpecificTables([{ schema_name: 'introspection', table_name: 'orders' }]);

      expect(columns.map(c => c.column_name)).toEqual(['id', 'customer_id']);
    });

    test('gives a column its foreign key when the referenced table isn\'t asked for', async () => {
      const columns = await driver.getColumnsForSpecificTables([{ schema_name: 'introspection', table_name: 'orders' }]);

      expect(columns.find(c => c.column_name === 'customer_id')?.foreign_keys).toEqual([
        { target_schema: 'introspection', target_table: 'customers', target_column: 'id' },
      ]);
      expect(columns.find(c => c.column_name === 'id')?.attributes).toEqual(['primaryKey']);
    });

    test('gives a referenced table\'s columns no foreign keys of the tables referencing it', async () => {
      const columns = await driver.getColumnsForSpecificTables([{ schema_name: 'introspection', table_name: 'customers' }]);

      expect(columns.find(c => c.column_name === 'id')?.foreign_keys).toEqual([]);
    });
  });

  // Note: This test MUST be the last in the list.
  test('release', async () => {
    expect(async () => {
      await driver.release();
    }).not.toThrowError(
      /Called end on pool more than once/
    );

    expect(async () => {
      await driver.release();
    }).not.toThrowError(
      /Called end on pool more than once/
    );
  });
});
