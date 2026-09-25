# cube-introspection

A data source introspection and cube scaffolding API for Cube, as a package
over an unmodified Cube. It browses a data source's schemas, tables and
columns and generates cubes from its tables, as Superset and Metabase do when
creating a dataset.

## How it plugs into Cube

Cube's own code is unchanged. The package:

- subclasses Cube's server container, server, server core and API gateway,
  through their protected factory methods, to add five routes in a new
  `introspection` API scope;
- reads catalogs through each data source's own driver instance, through a
  proxy that swaps in its catalog queries (table types, materialized views,
  foreign keys with their target's schema), in a queue beside Cube's for
  that data source;
- generates cubes with a copy of Cube's scaffolder (`src/scaffolding`, see
  `NOTICE`).

Everything is built for one Cube version, the one `peerDependencies` names,
and the server refuses to start on any other: the protected methods it uses
may change in any release.

## Running it

The `Dockerfile` builds Cube's published image with the package added and
started in place of `cubejs server`:

```sh
docker build -t cube:v1.7.45-introspection .
```

It takes the same configuration, environment and mounts as `cubejs/cube`
(`/cube/conf/cube.js`, the data model, `CUBEJS_*`). Run the refresh worker
from the same image or from `cubejs/cube`; it serves no introspection routes.

## Configuration

- **The `introspection` scope.** It is not among Cube's default scopes, so
  grant it with `contextToApiScopes` only to contexts that may see the data
  source's catalog. Cube refuses scopes it doesn't know; the package takes
  `introspection` out before Cube checks the rest.

  ```js
  // cube.js
  module.exports = {
    contextToApiScopes: async (securityContext, defaultScopes) =>
      securityContext.introspect ? ['introspection'] : defaultScopes,
  };
  ```

- **`CUBEJS_INTROSPECTION_MAX_TABLES`** (default `100`): the most tables one
  `/columns` or `/scaffold` request may name.

## API

All routes are under `{basePath}/v1/introspection/data-sources` (`basePath`
is `/cubejs-api` by default) and answer as Cube's other routes do: JSON,
`{ "error": … }` on failure.

Each request reads the data source's catalog as it is now. A request that
takes longer than the queue's wait timeout answers
`{ "error": "Continue wait" }` with status `200`, as `/v1/load` does, and
should be retried.

A data source can be browsed when it is declared in `CUBEJS_DATASOURCES` (or
is `default` when none are), or when the data model names it. An unknown data
source answers `404`.

Data sources whose driver doesn't load schemas incrementally (Druid, Dremio,
Firebolt, Hive, ksqlDB, MongoBI, Oracle, Pinot, QuestDB, SQLite, Vertica and
the generic JDBC driver) are read in full for each request, and their tables
have no `type`.

### `GET …/data-sources`

The data sources that can be browsed.

```json
{ "dataSources": [{ "dataSource": "default", "dbType": "postgres" }] }
```

### `GET …/data-sources/{dataSource}/schemas`

The data source's schemas, sorted by name. `search` keeps those whose name
contains it, ignoring case.

```json
{ "schemas": [{ "name": "public" }, { "name": "sales" }] }
```

### `GET …/data-sources/{dataSource}/tables`

The tables and views in one or more schemas, sorted by schema and name.

| Parameter | Description | Required |
| --- | --- | --- |
| `schema` | A schema to list. Repeat it to list several | Yes |
| `search` | Keep tables whose name contains this, ignoring case | No |
| `type` | Keep tables of this type: `table`, `view`, `materialized_view` or `external`. Repeat it to keep several | No |
| `limit` | Most tables to return. By default, all | No |
| `offset` | Tables to skip. Defaults to `0` | No |

`type` is `null` when the driver can't tell, and `rawType` is the data
source's own word for it. `total` counts every table that matches, before
`limit` and `offset`.

```json
{
  "tables": [
    { "schema": "public", "name": "orders", "type": "table", "rawType": "BASE TABLE" },
    { "schema": "public", "name": "paid_orders", "type": "view", "rawType": "VIEW" }
  ],
  "total": 2
}
```

### `POST …/data-sources/{dataSource}/columns`

The columns of up to `CUBEJS_INTROSPECTION_MAX_TABLES` tables, in the order
asked for. `schema` may be `""` for data sources without schemas. `type` is
the Cube type scaffolding gives the column, and a foreign key's `schema` is
`null` when the driver doesn't say. A table the data source doesn't have
answers `404`, naming it.

```json
{ "tables": [{ "schema": "public", "table": "orders" }] }
```

```json
{
  "tables": [{
    "schema": "public",
    "name": "orders",
    "columns": [
      { "name": "id", "rawType": "integer", "type": "number", "primaryKey": true, "foreignKeys": [] },
      { "name": "customer_id", "rawType": "integer", "type": "number", "primaryKey": false,
        "foreignKeys": [{ "schema": "public", "table": "customers", "column": "id" }] },
      { "name": "created_at", "rawType": "timestamp with time zone", "type": "time", "primaryKey": false, "foreignKeys": [] }
    ]
  }]
}
```

### `POST …/data-sources/{dataSource}/scaffold`

A cube for each of the tables, as for `/columns`, returned and not saved.
`format` is `yaml` (the default) or `js`.

Each cube has a dimension per string, boolean, time and key column, a `sum`
for each number named like a measure (`amount`, `total`, `price`…), a
`count`, and joins to the other given tables that foreign keys or
`<table>_id` columns connect it to. `unmappedColumns` lists the table's
columns the cube leaves out, and why: `underscore_prefix`,
`numeric_not_measure` or `not_mapped`.

A cube is named after its table. Tables of the same name in different
schemas, such as `public.orders` and `sales.orders`, are named after both
instead (`public_orders`, `sales_orders`), and joins use those names.

A foreign key that names its target's schema joins the table in that schema,
and nothing when that table isn't given. A foreign key that names no schema,
and a `<table>_id` column, prefer a table in their own schema. Failing that,
such a foreign key joins the first given table of that name in another
schema, and a `<table>_id` column joins a table in another schema only when
it is the one table its name could mean.

Each member is named after its column, in snake_case. Where two members would
share a name, as for the columns `Amount` and `amount`, the first keeps it and
the other gets the lowest free numbered name (`amount_2`), never the
unnumbered name of another column's member. Dimensions are named before
measures, and `count` is kept for the count measure. A key column is one
dimension with `primary_key: true`, whatever its type.

```json
{
  "cubes": [{
    "cube": "orders",
    "fileName": "orders.yml",
    "content": "cubes:\n  - name: orders\n    sql_table: public.orders\n…",
    "table": { "schema": "public", "table": "orders" },
    "unmappedColumns": [
      { "name": "_etl_loaded_at", "rawType": "timestamp without time zone", "reason": "underscore_prefix" }
    ]
  }]
}
```

## Development

```sh
npm ci
npm run typecheck
npm test
```

The integration tests run DuckDB in process, and Postgres, MySQL and Trino
when these name a database to use: `INTROSPECTION_TEST_POSTGRES=host:port`
(user, password and database `test`), `INTROSPECTION_TEST_MYSQL=host:port`
(user `root`, password `test`, database `test`) and
`INTROSPECTION_TEST_TRINO=host:port` (its `tpch` catalog; run as
`USER=presto`).

## Moving to another Cube version

1. Set the new version in `peerDependencies`, `devDependencies` and the
   `Dockerfile`'s `CUBE_VERSION`, and `npm install`.
2. Run `npm run typecheck` and `npm test`: a protected method Cube changed
   fails there.
3. Compare `src/scaffolding` with the new version's
   `packages/cubejs-schema-compiler/src/scaffolding`, and the queries in
   `src/catalog/views.ts` with the drivers', and carry over what changed.
