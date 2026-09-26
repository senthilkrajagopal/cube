/**
 * Wire types of the data source introspection API
 * (`/v1/introspection/data-sources`), which browses a data source's schemas,
 * tables and columns and generates cubes from its tables. The gateway
 * validates requests and shapes responses; the orchestrator API implements
 * `DataSourceIntrospectionApi` against the driver.
 */

/**
 * What a relation is. `null` in a response means the driver can't tell.
 */
export type DataSourceTableType = 'table' | 'view' | 'materialized_view' | 'external';

/**
 * The Cube type scaffolding gives a column.
 */
export type DataSourceColumnType = 'time' | 'number' | 'string' | 'boolean';

export type DataSourceTableRef = {
  schema: string;
  table: string;
};

export type DataSourceDescription = {
  dataSource: string;
  dbType: string;
};

export type DataSourceTable = {
  schema: string;
  name: string;
  type: DataSourceTableType | null;
  /** The data source's own word for it, e.g. `BASE TABLE`. */
  rawType: string | null;
};

export type DataSourceForeignKey = {
  /** `null` when the driver doesn't say which schema the target is in. */
  schema: string | null;
  table: string;
  column: string;
};

export type DataSourceColumn = {
  name: string;
  /** The data source's type, e.g. `character varying`. */
  rawType: string;
  type: DataSourceColumnType;
  primaryKey: boolean;
  foreignKeys: DataSourceForeignKey[];
};

export type DataSourceTableColumns = {
  schema: string;
  name: string;
  columns: DataSourceColumn[];
};

export type DataSourceScaffoldFormat = 'yaml' | 'js';

export type DataSourceUnmappedColumnReason =
  // Scaffolding skips columns whose name starts with `_`.
  'underscore_prefix' |
  // A number that is neither a key nor named like a measure (amount, total…).
  'numeric_not_measure' |
  'not_mapped';

export type DataSourceUnmappedColumn = {
  name: string;
  rawType: string;
  reason: DataSourceUnmappedColumnReason;
};

export type DataSourceScaffoldedCube = {
  cube: string;
  fileName: string;
  content: string;
  table: DataSourceTableRef;
  /** Columns of the table that are neither a dimension nor a measure of the cube. */
  unmappedColumns: DataSourceUnmappedColumn[];
};

export type DataSourceScaffoldOptions = {
  format: DataSourceScaffoldFormat;
};

/**
 * One data source's introspection, as the orchestrator API provides it.
 */
export interface DataSourceIntrospectionApi {
  schemas(): Promise<string[]>;
  tables(schemas: string[]): Promise<DataSourceTable[]>;
  columns(tables: DataSourceTableRef[]): Promise<DataSourceTableColumns[]>;
  scaffold(tables: DataSourceTableRef[], options: DataSourceScaffoldOptions): Promise<DataSourceScaffoldedCube[]>;
}

/**
 * A table as the catalog reads list it: upstream's, with the data source's
 * own word for what the relation is (`BASE TABLE`, `VIEW`…), when known.
 */
export type CatalogTableRow = {
  // eslint-disable-next-line camelcase
  schema_name: string;
  // eslint-disable-next-line camelcase
  table_name: string;
  // eslint-disable-next-line camelcase
  table_type?: string;
};

/** A foreign key as the catalog reads give it: upstream's, with the target's schema when known. */
export type CatalogForeignKey = {
  // eslint-disable-next-line camelcase
  target_schema?: string;
  // eslint-disable-next-line camelcase
  target_table: string;
  // eslint-disable-next-line camelcase
  target_column: string;
};
