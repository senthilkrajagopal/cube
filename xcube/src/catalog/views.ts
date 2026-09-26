/* eslint-disable camelcase, func-names */
import type {
  BaseDriver,
  QueryColumnsResult,
  QuerySchemasResult,
  QueryTablesResult,
} from '@cubejs-backend/base-driver';

import type { CatalogTableRow } from '../types';

/**
 * A driver as the introspection reads its catalog: the same instance Cube
 * queries through, seen through a proxy that swaps in the catalog queries
 * this package needs — table types, materialized views, foreign keys with
 * their target's schema, and the key queries some drivers get wrong. Reads
 * and writes of every other property reach the driver itself, so the proxy
 * shares its connection pool and lazy state, and Cube's own queries are
 * untouched.
 *
 * A query is replaced only where the driver's class is the one that defined
 * it upstream: a driver that overrides it keeps its own.
 */
export type CatalogDriver = BaseDriver;

type Method = (this: any, ...args: any[]) => any;

/** Class names on the driver's prototype chain, the driver's own first. */
export function driverClasses(driver: object): string[] {
  const names: string[] = [];

  for (let proto = Object.getPrototypeOf(driver); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    names.push(proto.constructor.name);
  }

  return names;
}

/** The class on the driver's prototype chain that defines `method`. */
function definerOf(driver: object, method: string): string | undefined {
  for (let proto = Object.getPrototypeOf(driver); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    if (Object.prototype.hasOwnProperty.call(proto, method)) {
      return proto.constructor.name;
    }
  }

  return undefined;
}

/**
 * Whether the driver lists schemas, tables and columns a level at a time.
 * Presto, Trino and DuckDB can, although upstream doesn't declare it.
 */
export function loadsIncrementally(driver: BaseDriver): boolean {
  const classes = driverClasses(driver);

  return Boolean(driver.capabilities().incrementalSchemaLoading) ||
    classes.includes('PrestoDriver') ||
    classes.includes('DuckDBDriver');
}

const IGNORED_SCHEMAS = "('pg_catalog', 'information_schema', 'mysql', 'performance_schema', 'sys', 'INFORMATION_SCHEMA')";

/** information_schema.tables with each relation's type. */
const baseTablesQuery: Method = function (schemasPlaceholders: string) {
  return `
      SELECT table_schema as ${this.quoteIdentifier('schema_name')},
            table_name as ${this.quoteIdentifier('table_name')},
            table_type as ${this.quoteIdentifier('table_type')}
      FROM information_schema.tables as columns
      WHERE table_schema IN (${schemasPlaceholders})
    `;
};

/** BaseDriver's, keeping each foreign key's target schema. */
const baseColumnsForSpecificTables: Method = async function (tables: QueryTablesResult[]): Promise<QueryColumnsResult[]> {
  const groupedBySchema: Record<string, string[]> = {};
  tables.forEach((t) => {
    if (!groupedBySchema[t.schema_name]) {
      groupedBySchema[t.schema_name] = [];
    }
    groupedBySchema[t.schema_name].push(t.table_name);
  });

  const conditions: string[] = [];
  const parameters: any[] = [];

  for (const [schema, tableNames] of Object.entries(groupedBySchema)) {
    const schemaPlaceholder = this.param(parameters.length);
    parameters.push(schema);

    const tablePlaceholders = tableNames.map((_, idx) => this.param(parameters.length + idx)).join(', ');
    parameters.push(...tableNames);

    conditions.push(`(${this.getColumnNameForSchemaName()} = ${schemaPlaceholder} AND ${this.getColumnNameForTableName()} IN (${tablePlaceholders}))`);
  }

  const conditionString = conditions.join(' OR ');
  const query = this.getColumnsForSpecificTablesQuery(conditionString);

  const [primaryKeys, foreignKeys] = await Promise.all([
    this.primaryKeys(conditionString, parameters),
    this.foreignKeys(conditionString, parameters),
  ]);

  const columns: QueryColumnsResult[] = await this.query(query, parameters);

  for (const column of columns) {
    if (primaryKeys.some(pk => pk.table_schema === column.schema_name && pk.table_name === column.table_name && pk.column_name === column.column_name)) {
      column.attributes = ['primaryKey'];
    }

    column.foreign_keys = foreignKeys
      .filter(fk => fk.table_schema === column.schema_name && fk.table_name === column.table_name && fk.column_name === column.column_name)
      .map(fk => ({
        ...(fk.target_schema ? { target_schema: fk.target_schema } : {}),
        target_table: fk.target_table,
        target_column: fk.target_column,
      }));
  }

  return columns;
};

/** Postgres lists materialized views in pg_matviews, not information_schema. */
const postgresTablesQuery: Method = function (schemasPlaceholders: string) {
  return `${baseTablesQuery.call(this, schemasPlaceholders)}
      UNION ALL
      SELECT schemaname as ${this.quoteIdentifier('schema_name')},
            matviewname as ${this.quoteIdentifier('table_name')},
            'MATERIALIZED VIEW' as ${this.quoteIdentifier('table_type')}
      FROM pg_catalog.pg_matviews
      WHERE schemaname IN (${schemasPlaceholders})
    `;
};

const postgresColumnsQuery: Method = function (conditionString: string) {
  // `conditionString` names `columns.table_schema` and `columns.table_name`,
  // so both sources are read as one relation of that name.
  return `
      SELECT columns.column_name as ${this.quoteIdentifier('column_name')},
             columns.table_name as ${this.quoteIdentifier('table_name')},
             columns.table_schema as ${this.quoteIdentifier('schema_name')},
             columns.data_type as ${this.quoteIdentifier('data_type')}
      FROM (
        SELECT column_name, table_name, table_schema, data_type, ordinal_position
        FROM information_schema.columns
        UNION ALL
        SELECT a.attname, c.relname, n.nspname, format_type(a.atttypid, NULL), a.attnum
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'm' AND a.attnum > 0 AND NOT a.attisdropped
      ) AS columns
      WHERE ${conditionString}
      ORDER BY columns.table_schema, columns.table_name, columns.ordinal_position
    `;
};

/**
 * Upstream filters on the referenced table (`columns` there is
 * constraint_column_usage), so a column's foreign key is found only when its
 * target is asked for too. Here `columns` is the referencing side.
 */
const postgresForeignKeysQuery: Method = function (conditionString?: string) {
  return `SELECT
        columns.table_schema as ${this.quoteIdentifier('table_schema')},
        columns.table_name as ${this.quoteIdentifier('table_name')},
        columns.column_name as ${this.quoteIdentifier('column_name')},
        target.table_schema as ${this.quoteIdentifier('target_schema')},
        target.table_name as ${this.quoteIdentifier('target_table')},
        target.column_name as ${this.quoteIdentifier('target_column')}
      FROM
        information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS columns
        ON columns.constraint_schema = tc.constraint_schema
        AND columns.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage AS target
        ON target.constraint_schema = tc.constraint_schema
        AND target.constraint_name = tc.constraint_name
      WHERE
         constraint_type = 'FOREIGN KEY'
         AND columns.table_schema NOT IN ${IGNORED_SCHEMAS}
         ${conditionString ? ` AND (${conditionString})` : ''}
    `;
};

/** Upstream's has no `columns` alias for `conditionString` to name, so it always fails. */
const mysqlPrimaryKeysQuery: Method = function (conditionString?: string) {
  return `SELECT
      TABLE_SCHEMA as ${this.quoteIdentifier('table_schema')},
      TABLE_NAME as ${this.quoteIdentifier('table_name')},
      COLUMN_NAME as ${this.quoteIdentifier('column_name')}
  FROM
      information_schema.KEY_COLUMN_USAGE AS columns
  WHERE
      CONSTRAINT_NAME = 'PRIMARY'
      AND TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ${conditionString ? ` AND (${conditionString})` : ''}
  ORDER BY
      TABLE_SCHEMA,
      TABLE_NAME,
      ORDINAL_POSITION;`;
};

/** Upstream names the referencing column as its own target. */
const mysqlForeignKeysQuery: Method = function (conditionString?: string) {
  return `SELECT
        columns.table_schema as ${this.quoteIdentifier('table_schema')},
        columns.table_name as ${this.quoteIdentifier('table_name')},
        columns.column_name as ${this.quoteIdentifier('column_name')},
        columns.referenced_table_schema as ${this.quoteIdentifier('target_schema')},
        columns.referenced_table_name as ${this.quoteIdentifier('target_table')},
        columns.referenced_column_name as ${this.quoteIdentifier('target_column')}
    FROM
        information_schema.key_column_usage AS columns
    WHERE
        columns.referenced_table_name IS NOT NULL
        AND columns.table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')${conditionString ? ` AND (${conditionString})` : ''};`;
};

const prestoTablesQuery: Method = function (schemasPlaceholders: string) {
  const catalogPrefix = this.catalog ? `${this.catalog}.` : '';

  return `
      SELECT table_schema as ${this.quoteIdentifier('schema_name')},
            table_name as ${this.quoteIdentifier('table_name')},
            table_type as ${this.quoteIdentifier('table_type')}
      FROM ${catalogPrefix}information_schema.tables as columns
      WHERE table_schema IN (${schemasPlaceholders})
    `;
};

const clickHouseTablesQuery: Method = function (schemasPlaceholders: string) {
  return `
      SELECT database as schema_name,
            name as table_name,
            multiIf(
              engine = 'View', 'VIEW',
              engine = 'MaterializedView', 'MATERIALIZED VIEW',
              'BASE TABLE'
            ) as table_type
      FROM system.tables
      WHERE database IN (${schemasPlaceholders})
    `;
};

const bigQueryTablesQuery: Method = async function (schemaName: string) {
  try {
    const dataSet = await this.bigquery.dataset(schemaName);
    if (!dataSet) {
      return [];
    }
    const [tables] = await this.bigquery.dataset(schemaName).getTables();
    // `metadata.type` is TABLE, VIEW, MATERIALIZED_VIEW, EXTERNAL or SNAPSHOT.
    return tables.map((t: any) => ({ table_name: t.id, table_type: t.metadata?.type }));
  } catch (e) {
    if ((<any>e).toString().indexOf('Not found')) {
      return [];
    }
    throw e;
  }
};

const bigQueryTables: Method = async function (schemas: QuerySchemasResult[]): Promise<QueryTablesResult[]> {
  const tables = await Promise.all(schemas.map(async (schema) => {
    const rows = await this.getTablesQuery(schema.schema_name);
    return rows
      .filter((table: any) => table.table_name)
      .map((table: any) => ({
        schema_name: schema.schema_name,
        table_name: table.table_name,
        ...(table.table_type ? { table_type: table.table_type } : {}),
      }));
  }));

  return tables.flat();
};

/**
 * SHOW TABLES lists views too but doesn't say which rows are views, so SHOW
 * VIEWS names them. When it fails the tables are listed without types.
 */
const databricksTables: Method = async function (schemas: QuerySchemasResult[]): Promise<QueryTablesResult[]> {
  const viewTypesIn = async (schemaName: string): Promise<Map<string, string> | null> => {
    try {
      const views = await this.query(`SHOW VIEWS IN ${this.getSchemaFullName(schemaName)}`, []);

      return new Map(views.map(({ viewName, isMaterialized }: any) => [
        viewName,
        isMaterialized ? 'MATERIALIZED VIEW' : 'VIEW',
      ]));
    } catch (e: any) {
      this.logger?.('Databricks SHOW VIEWS failed. Tables will be listed without types', {
        schema: schemaName,
        error: (e.stack || e).toString(),
      });

      return null;
    }
  };

  const tables = await Promise.all(schemas.map(async ({ schema_name }) => {
    const [rows, viewTypes] = await Promise.all([
      this.query(`SHOW TABLES IN ${this.getSchemaFullName(schema_name)}`, []),
      viewTypesIn(schema_name),
    ]);

    return rows.map(({ database, tableName }: any) => ({
      table_name: tableName,
      schema_name: database,
      ...(viewTypes ? { table_type: viewTypes.get(tableName) || 'TABLE' } : {}),
    }));
  }));

  return tables.flat();
};

export function catalogView(driver: BaseDriver): CatalogDriver {
  const classes = driverClasses(driver);
  const overrides: Record<string, Method> = {};
  const replace = (definer: string, method: string, impl: Method) => {
    if (definerOf(driver, method) === definer) {
      overrides[method] = impl;
    }
  };
  const original = (method: string): Method => (driver as any)[method];

  replace('BaseDriver', 'getTablesForSpecificSchemasQuery', baseTablesQuery);
  replace('BaseDriver', 'getColumnsForSpecificTables', baseColumnsForSpecificTables);

  // Redshift, Crate and Materialize speak Postgres but have no pg_matviews.
  if (classes.includes('PostgresDriver') &&
    !['RedshiftDriver', 'CrateDriver', 'MaterializeDriver'].some(name => classes.includes(name))) {
    overrides.getTablesForSpecificSchemasQuery = postgresTablesQuery;
    overrides.getColumnsForSpecificTablesQuery = postgresColumnsQuery;
  }
  replace('PostgresDriver', 'foreignKeysQuery', postgresForeignKeysQuery);

  replace('MySqlDriver', 'primaryKeysQuery', mysqlPrimaryKeysQuery);
  replace('MySqlDriver', 'foreignKeysQuery', mysqlForeignKeysQuery);

  replace('PrestoDriver', 'getTablesForSpecificSchemasQuery', prestoTablesQuery);
  replace('ClickHouseDriver', 'getTablesForSpecificSchemasQuery', clickHouseTablesQuery);

  replace('BigQueryDriver', 'getTablesQuery', bigQueryTablesQuery);
  replace('BigQueryDriver', 'getTablesForSpecificSchemas', bigQueryTables);

  replace('DatabricksDriver', 'getTablesForSpecificSchemas', databricksTables);

  // Its tables of external schemas, listed apart, are the ones without a type.
  if (definerOf(driver, 'getTablesForSpecificSchemas') === 'RedshiftDriver') {
    const tables = original('getTablesForSpecificSchemas');
    overrides.getTablesForSpecificSchemas = async function (schemas: QuerySchemasResult[]) {
      const rows: CatalogTableRow[] = await tables.call(this, schemas);
      return rows.map(row => (row.table_type ? row : { ...row, table_type: 'EXTERNAL TABLE' }));
    };
  }

  // DuckDB keeps to its configured catalog, as its schemas query does.
  if (classes.includes('DuckDBDriver')) {
    const tablesQuery = overrides.getTablesForSpecificSchemasQuery || original('getTablesForSpecificSchemasQuery');
    const columnsQuery = original('getColumnsForSpecificTablesQuery');
    overrides.getTablesForSpecificSchemasQuery = function (schemasPlaceholders: string) {
      const query = tablesQuery.call(this, schemasPlaceholders);
      return this.schema ? `${query} AND table_catalog = '${this.schema}'` : query;
    };
    overrides.getColumnsForSpecificTablesQuery = function (conditionString: string) {
      return columnsQuery.call(
        this,
        this.schema ? `(${conditionString}) AND columns.table_catalog = '${this.schema}'` : conditionString
      );
    };
  }

  return new Proxy(driver, {
    get: (target, prop, receiver) => (
      typeof prop === 'string' && Object.prototype.hasOwnProperty.call(overrides, prop)
        ? overrides[prop]
        : Reflect.get(target, prop, receiver)
    ),
    // Lazy state a method keeps, such as a connection, belongs to the driver.
    set: (target, prop, value) => Reflect.set(target, prop, value),
  });
}
