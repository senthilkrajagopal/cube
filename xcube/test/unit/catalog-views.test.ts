/* eslint-disable max-classes-per-file */
import { BaseDriver } from '@cubejs-backend/base-driver';

import { catalogView, driverClasses, loadsIncrementally } from '../../src';

/**
 * Stand-ins named as Cube's drivers, which the views are chosen by: each
 * answers `query` from a function the test gives it.
 */
class TestDriver extends BaseDriver {
  public queries: [string, unknown[]][] = [];

  public constructor(protected readonly answer: (sql: string) => unknown = () => []) {
    super();
  }

  public async query<R = unknown>(sql: string, values: unknown[] = []): Promise<R[]> {
    this.queries.push([sql, values]);
    return this.answer(sql) as R[];
  }

  public async testConnection() {
    return undefined;
  }

  public override readOnly() {
    return true;
  }
}

class PostgresDriver extends TestDriver {
  public override param(index: number) {
    return `$${index + 1}`;
  }

  protected override foreignKeysQuery(): string | null {
    return 'upstream postgres foreign keys';
  }
}

class RedshiftDriver extends PostgresDriver {
  protected override foreignKeysQuery(): string | null {
    return null;
  }

  public override async getTablesForSpecificSchemas(schemas: { schema_name: string }[]) {
    const tables: any[] = await super.getTablesForSpecificSchemas(schemas);
    tables.push({ schema_name: 'spectrum', table_name: 'events' });
    return tables;
  }
}

class ClickHouseDriver extends TestDriver {
  protected override getTablesForSpecificSchemasQuery() {
    return 'upstream clickhouse tables';
  }
}

class DuckDBDriver extends TestDriver {
  public constructor(answer: (sql: string) => unknown, protected readonly schema?: string) {
    super(answer);
  }
}

class PrestoDriver extends TestDriver {
}

class DatabricksDriver extends TestDriver {
  public override async getTablesForSpecificSchemas() {
    return [{ schema_name: 'upstream', table_name: 'upstream' }];
  }

  protected getSchemaFullName(schema: string) {
    return `\`${schema}\``;
  }
}

class BigQueryDriver extends TestDriver {
  public bigquery = {
    dataset: (schema: string) => ({
      getTables: async () => [[
        { id: `${schema}_table`, metadata: { type: 'TABLE' } },
        { id: `${schema}_view`, metadata: { type: 'VIEW' } },
      ]],
    }),
  };

  public override async getTablesQuery() {
    return [{ table_name: 'upstream' }];
  }

  // As upstream's: without the type.
  public override async getTablesForSpecificSchemas(schemas: { schema_name: string }[]) {
    return schemas.map(({ schema_name }) => ({ schema_name, table_name: 'upstream' }));
  }
}

class MySqlDriver extends TestDriver {
  protected override primaryKeysQuery(): string | null {
    return 'upstream mysql primary keys';
  }

  protected override foreignKeysQuery(): string | null {
    return 'upstream mysql foreign keys';
  }
}

describe('catalogView', () => {
  test('leaves Cube\'s driver as it is, and keeps its state on it', async () => {
    const driver = new PostgresDriver();
    const upstream = (driver as any).getTablesForSpecificSchemasQuery('$1');

    const view: any = catalogView(driver);
    view.lazyConnection = 'opened by a catalog read';

    expect((driver as any).lazyConnection).toEqual('opened by a catalog read');
    expect((driver as any).getTablesForSpecificSchemasQuery('$1')).toEqual(upstream);
    expect(view.getTablesForSpecificSchemasQuery('$1')).not.toEqual(upstream);
    expect(view).toBeInstanceOf(PostgresDriver);
  });

  test('lists each relation\'s type from information_schema', () => {
    const view: any = catalogView(new TestDriver());

    expect(view.getTablesForSpecificSchemasQuery('?')).toContain('table_type as "table_type"');
  });

  test('keeps each foreign key\'s target schema', async () => {
    const driver = new PostgresDriver((sql) => {
      if (sql.includes('FOREIGN KEY')) {
        return [{
          table_schema: 'public',
          table_name: 'orders',
          column_name: 'customer_id',
          target_schema: 'crm',
          target_table: 'customers',
          target_column: 'id',
        }];
      }
      if (sql.includes('column_name')) {
        return [{ schema_name: 'public', table_name: 'orders', column_name: 'customer_id', data_type: 'integer' }];
      }
      return [];
    });

    const [column] = await catalogView(driver).getColumnsForSpecificTables([{ schema_name: 'public', table_name: 'orders' }]);

    expect(column.foreign_keys).toEqual([{ target_schema: 'crm', target_table: 'customers', target_column: 'id' }]);
  });

  describe('Postgres', () => {
    test('lists materialized views and their columns, and foreign keys by the referencing table', () => {
      const view: any = catalogView(new PostgresDriver());

      expect(view.getTablesForSpecificSchemasQuery('$1')).toContain('pg_catalog.pg_matviews');
      expect(view.getColumnsForSpecificTablesQuery('true')).toContain("c.relkind = 'm'");
      expect(view.foreignKeysQuery()).toContain('target.table_schema as "target_schema"');
    });

    test('leaves drivers built on it without pg_matviews, and their own key queries, alone', () => {
      const view: any = catalogView(new RedshiftDriver());

      expect(view.getTablesForSpecificSchemasQuery('$1')).not.toContain('pg_matviews');
      expect(view.getColumnsForSpecificTablesQuery('true')).not.toContain('relkind');
      expect(view.foreignKeysQuery()).toBeNull();
    });

    test('calls Redshift\'s external tables external', async () => {
      const driver = new RedshiftDriver(() => [{ schema_name: 'public', table_name: 'orders', table_type: 'BASE TABLE' }]);

      await expect(catalogView(driver).getTablesForSpecificSchemas([{ schema_name: 'public' }])).resolves.toEqual([
        { schema_name: 'public', table_name: 'orders', table_type: 'BASE TABLE' },
        { schema_name: 'spectrum', table_name: 'events', table_type: 'EXTERNAL TABLE' },
      ]);
    });
  });

  test('MySQL: replaces the primary and foreign key queries', () => {
    const view: any = catalogView(new MySqlDriver());

    expect(view.primaryKeysQuery()).toContain('KEY_COLUMN_USAGE AS columns');
    expect(view.foreignKeysQuery()).toContain('columns.referenced_table_name as');
  });

  test('ClickHouse: says views and materialized views from the table engine', () => {
    const view: any = catalogView(new ClickHouseDriver());

    expect(view.getTablesForSpecificSchemasQuery('?')).toContain("engine = 'MaterializedView', 'MATERIALIZED VIEW'");
  });

  test('BigQuery: gives each table its type from the table metadata', async () => {
    await expect(catalogView(new BigQueryDriver()).getTablesForSpecificSchemas([{ schema_name: 'sales' }])).resolves.toEqual([
      { schema_name: 'sales', table_name: 'sales_table', table_type: 'TABLE' },
      { schema_name: 'sales', table_name: 'sales_view', table_type: 'VIEW' },
    ]);
  });

  describe('Databricks', () => {
    const tables = [
      { database: 'sales', tableName: 'orders', isTemporary: false },
      { database: 'sales', tableName: 'big_orders', isTemporary: false },
      { database: 'sales', tableName: 'orders_daily', isTemporary: false },
    ];

    test('labels views and materialized views from SHOW VIEWS, and the rest as tables', async () => {
      const driver = new DatabricksDriver((sql) => (sql.startsWith('SHOW TABLES') ? tables : [
        { namespace: 'sales', viewName: 'big_orders', isTemporary: false, isMaterialized: false },
        { namespace: 'sales', viewName: 'orders_daily', isTemporary: false, isMaterialized: true },
      ]));

      await expect(catalogView(driver).getTablesForSpecificSchemas([{ schema_name: 'sales' }])).resolves.toEqual([
        { schema_name: 'sales', table_name: 'orders', table_type: 'TABLE' },
        { schema_name: 'sales', table_name: 'big_orders', table_type: 'VIEW' },
        { schema_name: 'sales', table_name: 'orders_daily', table_type: 'MATERIALIZED VIEW' },
      ]);
      expect(driver.queries.map(([sql]) => sql)).toEqual(['SHOW TABLES IN `sales`', 'SHOW VIEWS IN `sales`']);
    });

    test('lists tables without types when SHOW VIEWS fails', async () => {
      const driver = new DatabricksDriver((sql) => {
        if (sql.startsWith('SHOW TABLES')) {
          return tables;
        }
        throw new Error('SHOW VIEWS is not supported');
      });

      await expect(catalogView(driver).getTablesForSpecificSchemas([{ schema_name: 'sales' }])).resolves.toEqual([
        { schema_name: 'sales', table_name: 'orders' },
        { schema_name: 'sales', table_name: 'big_orders' },
        { schema_name: 'sales', table_name: 'orders_daily' },
      ]);
    });
  });

  test('DuckDB: keeps to the configured catalog', () => {
    const view: any = catalogView(new DuckDBDriver(() => [], 'memory'));

    expect(view.getTablesForSpecificSchemasQuery('?')).toMatch(/table_type[\s\S]*AND table_catalog = 'memory'$/);
    expect(view.getColumnsForSpecificTablesQuery('(a) OR (b)')).toContain("WHERE ((a) OR (b)) AND columns.table_catalog = 'memory'");
  });
});

describe('loadsIncrementally', () => {
  test('as the driver declares, and for Presto, Trino and DuckDB besides', () => {
    expect(loadsIncrementally(new TestDriver())).toBe(false);
    expect(loadsIncrementally(new PrestoDriver())).toBe(true);
    expect(loadsIncrementally(new DuckDBDriver(() => []))).toBe(true);
    expect(driverClasses(new RedshiftDriver())).toEqual(['RedshiftDriver', 'PostgresDriver', 'TestDriver', 'BaseDriver']);
  });
});
