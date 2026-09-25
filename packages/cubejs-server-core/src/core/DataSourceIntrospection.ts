import type {
  BaseDriver,
  DatabaseStructure,
  QueryColumnsResult,
  QueryTablesResult,
} from '@cubejs-backend/base-driver';
import type { QueryOrchestrator } from '@cubejs-backend/query-orchestrator';
import {
  CubejsHandlerError,
  type DataSourceColumn,
  type DataSourceIntrospectionApi,
  type DataSourceScaffoldedCube,
  type DataSourceScaffoldOptions,
  type DataSourceTable,
  type DataSourceTableColumns,
  type DataSourceTableRef,
  type DataSourceTableType,
  type DataSourceUnmappedColumn,
} from '@cubejs-backend/api-gateway';
import {
  columnTypeOf,
  DatabaseSchema,
  ScaffoldingSchema,
  ScaffoldingTemplate,
  SchemaFormat,
  TableSchema,
  toSnakeCase,
} from '@cubejs-backend/schema-compiler';

/**
 * What a relation is, from the word its data source's catalog uses for it:
 * `BASE TABLE`, `VIEW`, `SYSTEM VIEW`, `MATERIALIZED VIEW`, `MATERIALIZED_VIEW`,
 * `EXTERNAL TABLE`, `FOREIGN` and so on.
 */
export function tableTypeOf(rawType: string | null | undefined): DataSourceTableType | null {
  if (!rawType) {
    return null;
  }

  const type = rawType.toUpperCase();
  if (type.includes('MATERIALIZED')) {
    return 'materialized_view';
  } else if (type.includes('VIEW')) {
    return 'view';
  } else if (type.includes('EXTERNAL') || type.includes('FOREIGN')) {
    return 'external';
  }

  return 'table';
}

const byName = (a: string, b: string) => {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
};

const tableKey = (schema: string, table: string) => JSON.stringify([schema, table]);

const describeTable = ({ schema, table }: DataSourceTableRef) => `${schema}.${table}`;

function toColumn(row: QueryColumnsResult): DataSourceColumn {
  return {
    name: row.column_name,
    rawType: row.data_type,
    type: columnTypeOf(row.data_type),
    primaryKey: Boolean(row.attributes?.includes('primaryKey')),
    foreignKeys: (row.foreign_keys || []).map(fk => ({
      schema: fk.target_schema ?? null,
      table: fk.target_table,
      column: fk.target_column,
    })),
  };
}

/**
 * Browses one data source through its driver and generates cubes from its
 * tables. Every call to the data source goes through the orchestrator's queue
 * for that data source, so it shares the queue's concurrency, timeouts and
 * `Continue wait` handling with data queries, and nothing is cached: each
 * call answers from the data source's catalog as it is now.
 *
 * Drivers without incremental schema loading can't list a level at a time,
 * so for those each call reads the whole catalog, and tables have no type.
 */
export class DataSourceIntrospection implements DataSourceIntrospectionApi {
  public constructor(
    protected readonly orchestrator: QueryOrchestrator,
    protected readonly driverFactory: () => Promise<BaseDriver> | BaseDriver,
    protected readonly dataSource: string,
    protected readonly requestId?: string,
  ) {
  }

  public async schemas(): Promise<string[]> {
    const names = await this.isIncremental()
      ? (await this.orchestrator.queryDataSourceSchemas(this.dataSource, this.queryOptions()))
        .map(({ schema_name: schema }) => schema)
      : Object.keys(await this.tablesSchema());

    return [...new Set(names.filter(Boolean))].sort(byName);
  }

  public async tables(schemas: string[]): Promise<DataSourceTable[]> {
    const wanted = [...new Set(schemas)];
    if (!wanted.length) {
      return [];
    }

    let rows: QueryTablesResult[];
    if (await this.isIncremental()) {
      rows = await this.orchestrator.queryTablesForSchemas(
        wanted.map(schema => ({ schema_name: schema })),
        this.dataSource,
        this.queryOptions(),
      );
    } else {
      const structure = await this.tablesSchema();
      rows = wanted.flatMap(schema => Object.keys(structure[schema] || {})
        .map(table => ({ schema_name: schema, table_name: table })));
    }

    const seen = new Set<string>();
    return rows
      .filter(row => row.table_name)
      .filter(row => {
        const key = tableKey(row.schema_name, row.table_name);
        return seen.has(key) ? false : Boolean(seen.add(key));
      })
      .map(row => ({
        schema: row.schema_name,
        name: row.table_name,
        type: tableTypeOf(row.table_type),
        rawType: row.table_type || null,
      }))
      .sort((a, b) => byName(a.schema, b.schema) || byName(a.name, b.name));
  }

  /**
   * The columns of each table, in the order asked for.
   *
   * @throws CubejsHandlerError 404 naming every table the data source doesn't have
   */
  public async columns(tables: DataSourceTableRef[]): Promise<DataSourceTableColumns[]> {
    const wanted = this.distinct(tables);
    if (!wanted.length) {
      return [];
    }

    let rows: QueryColumnsResult[];
    if (await this.isIncremental()) {
      rows = await this.orchestrator.queryColumnsForTables(
        wanted.map(({ schema, table }) => ({ schema_name: schema, table_name: table })),
        this.dataSource,
        this.queryOptions(),
      );
    } else {
      const structure = await this.tablesSchema();
      rows = wanted.flatMap(({ schema, table }) => (structure[schema]?.[table] || []).map(column => ({
        schema_name: schema,
        table_name: table,
        column_name: column.name,
        data_type: column.type,
        attributes: column.attributes,
      })));
    }

    const byTable = new Map<string, DataSourceColumn[]>();

    for (const row of rows) {
      const key = tableKey(row.schema_name, row.table_name);
      byTable.set(key, [...(byTable.get(key) || []), toColumn(row)]);
    }

    const missing = wanted.filter(({ schema, table }) => !byTable.has(tableKey(schema, table)));
    if (missing.length) {
      throw new CubejsHandlerError(
        404,
        'Not Found',
        `The '${this.dataSource}' data source has no table ${missing.map(describeTable).join(', ')}`,
      );
    }

    return wanted.map(({ schema, table }) => ({
      schema,
      name: table,
      columns: byTable.get(tableKey(schema, table)) as DataSourceColumn[],
    }));
  }

  /**
   * A cube per table, as the Playground generates them: snake_case names,
   * `sql_table`, a dimension per string, boolean, time and key column, a sum
   * for each number named like a measure, a `count`, and joins between the
   * given tables where foreign keys or `<table>_id` columns connect them. The
   * cubes are returned, not written anywhere.
   *
   * A cube is named after its table. Tables of the same name in different
   * schemas are named after their schema and table instead, `sales_orders`,
   * and joins between the given tables follow those names.
   *
   * @throws CubejsHandlerError 404 naming every table the data source doesn't have
   */
  public async scaffold(
    tables: DataSourceTableRef[],
    { format }: DataSourceScaffoldOptions
  ): Promise<DataSourceScaffoldedCube[]> {
    const tableColumns = await this.columns(tables);
    if (!tableColumns.length) {
      return [];
    }

    const dbSchema: DatabaseSchema = {};

    for (const { schema, name, columns } of tableColumns) {
      dbSchema[schema] = dbSchema[schema] || {};
      dbSchema[schema][name] = columns.map(column => ({
        name: column.name,
        type: column.rawType,
        attributes: column.primaryKey ? ['primaryKey'] : [],
        foreign_keys: column.foreignKeys.map(fk => ({
          ...(fk.schema !== null ? { target_schema: fk.schema } : {}),
          target_table: fk.table,
          target_column: fk.column,
        })),
      }));
    }

    const tableNames = tableColumns.map<[string, string]>(({ schema, name }) => [schema, name]);
    const cubeNameFor = this.distinctCubeNames(
      new ScaffoldingSchema(dbSchema, { snakeCase: true }).generateForTables(tableNames)
    );
    const tableSchemas = new ScaffoldingSchema(dbSchema, { snakeCase: true, cubeNameFor })
      .generateForTables(tableNames);

    const template = new ScaffoldingTemplate(dbSchema, await this.driverFactory(), {
      format: format === 'js' ? SchemaFormat.JavaScript : SchemaFormat.Yaml,
      snakeCase: true,
      cubeNameFor,
    });
    const files = template.generateFilesByTableNames(
      tableNames,
      this.dataSource === 'default' ? {} : { dataSource: this.dataSource },
    );

    return files.map((file, i) => ({
      cube: tableSchemas[i].cube,
      fileName: file.fileName,
      content: file.content,
      table: { schema: tableColumns[i].schema, table: tableColumns[i].name },
      unmappedColumns: this.unmappedColumns(tableColumns[i].columns, tableSchemas[i]),
    }));
  }

  protected unmappedColumns(columns: DataSourceColumn[], tableSchema: TableSchema): DataSourceUnmappedColumn[] {
    const mapped = new Set([
      ...tableSchema.dimensions.map(d => d.name),
      ...tableSchema.measures.map(m => m.name),
    ]);

    return columns
      .filter(column => !mapped.has(column.name))
      .map(column => {
        let reason: DataSourceUnmappedColumn['reason'] = 'not_mapped';
        if (column.name.startsWith('_')) {
          reason = 'underscore_prefix';
        } else if (column.type === 'number') {
          reason = 'numeric_not_measure';
        }

        return { name: column.name, rawType: column.rawType, reason };
      });
  }

  /**
   * A cube name for each table that no other table's cube has: the name
   * scaffolding gives it where that is unique, `<schema>_<table>` where tables
   * of the same name in different schemas would share it, and a numbered one
   * should even that be taken.
   */
  protected distinctCubeNames(defaultNamed: TableSchema[]): (schema: string, table: string) => string {
    const counts = new Map<string, number>();
    defaultNamed.forEach(({ cube }) => counts.set(cube, (counts.get(cube) || 0) + 1));

    const taken = new Set<string>(defaultNamed.map(({ cube }) => cube).filter(cube => counts.get(cube) === 1));
    const names = new Map<string, string>();

    for (const { cube, schema, table } of defaultNamed) {
      let name = cube;
      if (counts.get(cube) !== 1) {
        const qualified = toSnakeCase(`${schema}_${table}`);

        name = qualified;

        for (let n = 2; taken.has(name); n++) {
          name = `${qualified}_${n}`;
        }
        taken.add(name);
      }
      names.set(tableKey(schema, table), name);
    }

    return (schema, table) => names.get(tableKey(schema, table)) as string;
  }

  protected distinct(tables: DataSourceTableRef[]): DataSourceTableRef[] {
    const seen = new Set<string>();
    return tables.filter(({ schema, table }) => {
      const key = tableKey(schema, table);
      return seen.has(key) ? false : Boolean(seen.add(key));
    });
  }

  protected async isIncremental(): Promise<boolean> {
    const driver = await this.driverFactory();
    return Boolean(driver.capabilities().incrementalSchemaLoading);
  }

  protected tablesSchema(): Promise<DatabaseStructure> {
    return this.orchestrator.queryDataSourceTablesSchema(this.dataSource, this.queryOptions());
  }

  protected queryOptions() {
    return { requestId: this.requestId };
  }
}
