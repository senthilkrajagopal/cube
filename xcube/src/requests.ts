import Joi from 'joi';

import type { DataSourceTable, DataSourceTableRef, DataSourceTableType } from './types';

/**
 * Most tables one columns or scaffold request may name:
 * `CUBEJS_INTROSPECTION_MAX_TABLES`, 100 when unset.
 */
export function maxTablesPerRequest(): number {
  const value = process.env.CUBEJS_INTROSPECTION_MAX_TABLES;
  if (value === undefined || value === '') {
    return 100;
  }

  const max = Number(value);
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`CUBEJS_INTROSPECTION_MAX_TABLES must be a positive integer, not '${value}'`);
  }

  return max;
}

const TABLE_TYPES: DataSourceTableType[] = ['table', 'view', 'materialized_view', 'external'];

// A query parameter given once is a string, given again an array.
const oneOrMany = (item: Joi.Schema) => Joi.array()
  .items(item)
  .single()
  .min(1);

const searchSchema = Joi.string().allow('').max(256);

// Each table named is a condition in one catalog query, and scaffolding holds
// all of them in memory at once, so their number is capped by
// CUBEJS_INTROSPECTION_MAX_TABLES, read per request.
const tableRefsSchema = () => Joi.array().items(Joi.object({
  // Some data sources have no schemas; their tables list with an empty one.
  schema: Joi.string().allow('').required(),
  table: Joi.string().required(),
}))
  .min(1)
  .max(maxTablesPerRequest())
  .required();

export const dataSourceSchemasRequestSchema = Joi.object({
  search: searchSchema,
});

export const dataSourceTablesRequestSchema = Joi.object({
  schema: oneOrMany(Joi.string().allow('')).required(),
  search: searchSchema,
  type: oneOrMany(Joi.string().valid(...TABLE_TYPES)),
  limit: Joi.number().integer().min(1),
  offset: Joi.number().integer().min(0).default(0),
});

export const dataSourceColumnsRequestSchema = () => Joi.object({
  tables: tableRefsSchema(),
});

export const dataSourceScaffoldRequestSchema = () => Joi.object({
  tables: tableRefsSchema(),
  format: Joi.string().valid('yaml', 'js').default('yaml'),
});

export type DataSourceTablesRequest = {
  schema: string[];
  search?: string;
  type?: DataSourceTableType[];
  limit?: number;
  offset: number;
};

export type DataSourceTableRefsRequest = {
  tables: DataSourceTableRef[];
};

export type DataSourceScaffoldRequest = DataSourceTableRefsRequest & {
  format: 'yaml' | 'js';
};

/**
 * Whether a name contains the search, ignoring case. An empty search matches
 * every name.
 */
export const matchesSearch = (name: string, search?: string) => !search ||
  name.toLowerCase().includes(search.toLowerCase());

/**
 * One page of the tables that match the request, and how many match in all.
 */
export function pageOfTables(
  tables: DataSourceTable[],
  { search, type, limit, offset }: Omit<DataSourceTablesRequest, 'schema'>
): { tables: DataSourceTable[], total: number } {
  const matching = tables.filter(
    table => matchesSearch(table.name, search) && (!type || (table.type !== null && type.includes(table.type)))
  );

  return {
    tables: matching.slice(offset, limit === undefined ? undefined : offset + limit),
    total: matching.length,
  };
}
