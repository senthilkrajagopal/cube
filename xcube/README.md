# xcube

The Cube side of the wechart integration, as a package over an unmodified
Cube. It runs inside every Cube instance and the refresh worker and does only
what needs Cube's runtime or code; wechart remains the system of record. The
shared plan (ownership, names, modules, contract, slices) is the
"wechart ↔ Cube integration plan" doc.

It does two things:

- **Serves models from xcube's own schema.** wechart pushes each model to
  xcube; every Cube process follows each model's current revision in
  Postgres, compiles a revision before switching to it, and never calls
  wechart. See [Serving models](#serving-models).
- **Introspects data sources.** It browses a data source's schemas, tables
  and columns and generates cubes from its tables, as Superset and Metabase
  do when creating a dataset. See [Introspection API](#introspection-api).

## How it plugs into Cube

Cube's own code is unchanged. The package:

- subclasses Cube's server container, server, server core and API gateway,
  through their protected factory methods, to add the introspection routes
  in a new `introspection` API scope and the admin routes;
- serves models through Cube's public configuration hooks
  (`contextToAppId`, `repositoryFactory`, `extendContext`,
  `scheduledRefreshContexts`), set by `require('xcube').config()`; beyond
  them it deletes replaced models from Cube's compiler cache (a protected
  field) and wraps the public `runScheduledRefresh` and `listen`;
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
docker build -t xcube:v1.7.45-$(git rev-parse --short=10 HEAD) .
```

It takes the same configuration, environment and mounts as `cubejs/cube`
(`/cube/conf/cube.js`, the data model, `CUBEJS_*`), plus `XCUBE_*` when it
serves models. Run the refresh worker from the same image: when xcube serves
models, the worker's `cube.js` needs it too.

## Serving models

### How it works

A model is served in one of two modes:

- **Files** (slice 2): the client sends the model's whole file set, and xcube
  serves it as it is.
- **Items** (slice 3): the client sends its folder tree and its items (one
  cube or view each, in a folder) as changesets, and xcube resolves their
  names (see [Folders and names](#folders-and-names)). A model moves from
  files to items with its first items snapshot, and doesn't move back.

In both modes:

- **A model** is one wechart instance's whole data model (`dev`, `demo`, a
  Helm release name). Each import makes an immutable **revision**, numbered
  per model; the model's current revision is what every Cube process
  serves.
- **Storage.** Schema `xcube` in wechart's metadata database, owned by its
  own role. xcube creates and migrates its tables itself, on start, under an
  advisory lock. Each distinct file content is stored once per model, and the
  newest `XCUBE_KEEP_REVISIONS` revisions are kept.
- **Following.** Every process (API instances and the refresh worker)
  listens for `NOTIFY xcube_revision`, re-reads on each reconnect, and polls
  as a backstop. It compiles a new revision before switching to it; until
  then it serves the previous one. A revision that doesn't compile on a
  process is retried with backoff, and the previous one keeps serving.
- **Serving.** `extendContext` pins each request to one compiled revision
  (app id `xcube:<model>:<revision>:<hash>`), so a switch never splits a
  request. Replaced revisions stay compiled for `XCUBE_RETIRE_GRACE_MS`, and
  while a refresh run uses them, then are deleted from Cube's compiler cache.
  Nothing on the query path reads the database: with Postgres down, Cube
  keeps answering from memory.
- **Read your writes.** An import answers with the new revision number. A
  token that names a revision (the revision claim) is answered from that
  revision or a newer one: a process that hasn't switched yet catches up
  first, for up to `XCUBE_CATCH_UP_MS`, and otherwise answers `503` with
  `Retry-After`. Responses carry `x-xcube-revision: <model>@<revision>` (or
  `disk`) and `x-xcube-generation`.
- **Without a model.** A token that names no model is served Cube's own data
  model directory (`schemaPath`), unless `withoutModel: 'refuse'`.

### Setting it up

1. **Bootstrap the database once**, as its admin, with
   [`bootstrap.sql`](bootstrap.sql): a login role `xcube` owning a schema
   `xcube`, and nothing else.

   ```sh
   psql -v ON_ERROR_STOP=1 -v xcube_password=… -d wechart_meta -f bootstrap.sql
   ```

2. **Use xcube's configuration** in `cube.js`, with the claims the client's
   tokens carry, and the rest of the configuration beside them:

   ```js
   module.exports = require('xcube').config(
     { modelClaim: 'wechartModel', revisionClaim: 'wechartRevision' },
     { contextToApiScopes: …, contextToGroups: … },
   );
   ```

   | Option | Default | Meaning |
   | --- | --- | --- |
   | `modelClaim` | `xcubeModel` | The security-context claim naming the model |
   | `revisionClaim` | `xcubeRevision` | The claim naming the oldest revision the request may be answered from |
   | `withoutModel` | `disk` | A context naming no model: Cube's own `schemaPath`, or `refuse` (403) |

   `contextToAppId`, `repositoryFactory` and `schemaVersion` belong to xcube;
   `config()` refuses them. `extendContext` and `scheduledRefreshContexts`
   are combined with xcube's. `allowNodeRequire` defaults to `false`.
3. **Run every Cube process from this image**, API instances and the refresh
   worker alike, with `XCUBE_DATABASE_URL` set. A process with the database
   set whose `cube.js` doesn't use `config()` refuses to start.

| Variable | Default | Meaning |
| --- | --- | --- |
| `XCUBE_DATABASE_URL` | unset | Turns serving on. Unset, xcube serves introspection only |
| `XCUBE_DATABASE_SCHEMA` | `xcube` | xcube's schema, and the prefix of its notification channel |
| `XCUBE_ADMIN_TOKENS` | unset | Bearer tokens the admin routes accept, comma-separated, each at least 32 characters and none equal to `CUBEJS_API_SECRET`. Unset, the admin routes are off (the refresh worker) |
| `XCUBE_MIGRATE` | `true` | `false` only checks the schema is up to date |
| `XCUBE_POLL_INTERVAL_MS` | `60000` | How often each model's current revision is re-read |
| `XCUBE_POLL_INTERVAL_DOWN_MS` | `10000` | The same, while notifications are down |
| `XCUBE_RETIRE_GRACE_MS` | `300000` | How long a replaced revision stays compiled |
| `XCUBE_KEEP_REVISIONS` | `50` | Revisions kept per model |
| `XCUBE_MAX_SNAPSHOT_BYTES` | `33554432` | The most content one snapshot may hold (also bounded by `CUBEJS_MAX_REQUEST_SIZE`) |
| `XCUBE_FILE_TYPES` | `yaml` | `yaml` takes plain YAML only; `all` also takes JavaScript, Jinja and Python, which Cube runs as code in its own process, so that whoever may import may run code in Cube |
| `XCUBE_MAX_MODELS` | `1000` | The most models one process follows |
| `XCUBE_MODULE_PACK_MIN` | `50` | Groups smaller than this are packed together into modules |
| `XCUBE_MODULE_PACK_MAX` | `300` | The most items a packed module holds |
| `XCUBE_COMPILE_QUEUE` | `4` | Imports and checks that may wait to compile; more answer `503` |
| `XCUBE_COMPILE_WAIT_MS` | `120000` | How long one may wait |
| `XCUBE_CATCH_UP_MS` | `10000` | How long a request naming a newer revision waits for it |
| `CUBEJS_TRANSPILATION_WORKER_THREADS_COUNT` | `2` | Cube's; the image sets it when unset, as unset a compile can take gigabytes |

### Folders and names

- **One flat namespace.** Every item's cube or view is named by its short
  name in the root folder (`orders`), and `<folderId>__<shortName>` in any
  other folder (`f7k2__orders`). Short names are lower-case words joined by
  single underscores, so they never hold `__`, and the two kinds can't
  collide. A folder id is `f` and 1 to 40 lower-case letters and digits; the
  root is `froot`.
- **Resolution at publish.** A short name an item uses (a join, `{orders.id}`,
  `extends`, a view's `join_path`, `FILTER_PARAMS.orders…`, a
  pre-aggregation's `rollups`…) means the nearest item of that name, from the
  item's own folder up to the root. xcube rewrites it to the full name and
  records the binding, which stays until the item is published again: a
  nearer item of the same name doesn't rebind items published before it.
- **Removal.** An item another item is bound to can't be deleted or renamed;
  the refusal names the items that refer to it.
- **What people see.** An item in a folder gets `title` from its short name
  (`Orders`, as Cube would title `orders`) and a `sql_alias` (its full name,
  or a stable hash when that is longer than 20 characters), so SQL and
  rollup table names stay short. xcube adds `meta.xcube = { folderId,
  shortName }` to every item, for pickers. Root items keep their names,
  titles and SQL as they were.
- **Expressions** are read with Cube's own lexer, so names in string
  literals, lambda parameters and keyword arguments are never rewritten.

### Modules

An items model compiles in **modules**, so a change recompiles only the
modules it touches.

- **Grouping.**
  - Items that refer to each other (the bindings above) share a module, so
    a module holds everything its items use.
  - A cube used by items in two or more *zones* (the first folder under the
    root on their paths) is **shared**. It groups nothing: every module
    using it compiles a copy of it and of what it references. The shared
    cubes also form the `commons` module.
  - Groups under `XCUBE_MODULE_PACK_MIN` items (50) are packed into modules
    of at most `XCUBE_MODULE_PACK_MAX` (300), same zone first.
- **Versions.**
  - A module's version is the hash of its files. A module that didn't
    change keeps its compiled model from one revision to the next, and
    publishes compile and validate only the modules that changed.
  - A module keeps its id across revisions: the new group that overlaps it
    most takes it.
- **Routing.** Clients send the same requests as before.
  - `/v1/load`, `/v1/sql`, `/v1/dry-run` and `/v1/subscribe` are answered
    from the module holding every cube the query names: the first cube's
    owner, else `commons`, else the smallest.
  - A query no one module holds (two facts joined through a shared cube) is
    answered from a union of the modules owning its cubes. The union is
    compiled in the compile lane on first use (a full lane answers `503`),
    kept with the revision, and retired when idle; a revision keeps at most
    16. Modules sharing no cube get no union: Cube answers that their cubes
    don't join.
  - `/v1/meta` and `?extended` are each module's own answer, merged. Cube
    computes visibility per cube, so the result is what one model would
    answer.
  - The jobs API builds each selector context in every module holding the
    pre-aggregations it names; the module travels in the jobs' security
    context.
  - The refresh worker runs one context per module.
  - Requests that name no query (the SQL API, GraphQL) are answered from
    the whole model, compiled on first use.
- **`queryRewrite`** in cube.js runs in the query's module, so it may add
  only cubes the query already reaches; anything else is refused with a
  message. Access policies are the way to add filters on other members.
- **Cube's compiler cache** holds 2,000 compiled models by default under
  xcube (`compilerCacheSize`), since modules, unions and replaced revisions
  in their grace period all count; xcube retires them itself.
- **Status.** `GET …/revision` lists the modules:
  `{ id, version, cubes, copies }`.

### Admin API

For the client's server alone. The routes are under
`{basePath}/v1/semantic/models/{model}` and take
`Authorization: Bearer <one of XCUBE_ADMIN_TOKENS>`; Cube's own
authentication and API scopes don't apply to them, and an admin token is no
token for Cube's routes. A model id is 1 to 63 of `a-z`, `0-9`, `_` and `-`.
Errors are `{ "error": "…", "code": "…" }`.

#### `PUT …/snapshot`

Makes the files the model's new current revision, once they compile.

```json
{
  "baseRevision": 41,
  "files": [{ "path": "cubes/orders.yml", "content": "cubes:\n  - name: orders\n…" }],
  "source": { "reason": "publish", "actor": "user:5f2c" }
}
```

- `baseRevision` is the revision the files were based on, `null` for a model
  with none yet.
- A path is ASCII segments ending in `.yml` or `.yaml` (with
  `XCUBE_FILE_TYPES=all`, also `.js`, `.jinja` or `.py`), without `..`. A
  YAML file holding Jinja tags (`{{`, `{%`) is refused unless
  `XCUBE_FILE_TYPES=all`. At most 10,000 files, 4 MiB each.
- The content hash is the SHA-256 of the files sorted by path, as the JSON
  `[{"fileName": path, "content": content}, …]`.

| Status | When |
| --- | --- |
| `201` | Stored as the new current revision: `{ model, generation, revision, created: true, contentHash }` |
| `200` | The same content as the current revision, whatever the base: nothing changes, `created: false` |
| `409` | `conflict`: the base isn't the current revision (`currentRevision`, `currentContentHash`) |
| `422` | `invalid_snapshot`: it doesn't compile (`errors`, `cubeMessage`); nothing is stored |
| `400`, `413` | The request, a path or kind of file (`invalid_path`, `invalid_file_type`, `duplicate_path`), or a limit |
| `503` | `busy` (the compile queue is full; `retryAfterMs`) or `unavailable` (the database) |

Each error is `{ path, line?, column?, kind: "yaml" | "compile", message }`.
Every YAML file's syntax errors are found, with their lines, before
compiling. Cube's own errors are placed in the file defining the cube or view
they name; errors Cube names no file for have `path: null`. `cubeMessage` is
Cube's error as `/v1/meta` would answer it.

#### `PUT …/snapshot?dryRun=true`

Checks the files as an import would, and stores nothing. It can also run
probes: queries whose SQL Cube generates through its own `/v1/sql` code
(scopes, rewrite, access policies), under `securityContext` with the model
claim set.

```json
{
  "files": […],
  "securityContext": { "groups": ["sales"] },
  "probes": [{ "id": "orders", "query": { "measures": ["orders.count"] }, "compare": true }]
}
```

It answers `200` with `{ model, contentHash, currentRevision, sameAsCurrent,
valid, errors, cubeMessage, probes, durationMs }`. Each probe is
`{ id, candidate: { status, error? }, current? }`: `status` `400` is Cube
refusing the query. With `compare`, a probe the candidate refuses is also run
against the current revision (`current`, with its `revision`), to tell a new
refusal from one that already existed. Probes run only when the files are
valid.

#### `PUT …/folders`

Replaces the folder tree: `{ "folders": [{ "id": "froot", "parentId": null }, { "id": "f7k2", "parentId": "froot" }] }`.
It changes nothing Cube serves, only how later publishes resolve names.
`400 invalid_folders` for a bad id, a missing root, an unknown parent or a
cycle; `409 folder_in_use` when a folder that still holds items would go.

#### `POST …/changesets`

```json
{
  "baseRevision": 41,
  "upserts": [{ "folderId": "f7k2", "name": "orders", "kind": "cube", "yaml": "cubes:\n  - name: orders\n…" }],
  "deletes": [{ "folderId": "froot", "name": "old_orders" }],
  "source": { "reason": "publish" }
}
```

It applies the changes to the current items, resolves the changed ones,
compiles the result and stores it as the new current revision. It answers
like the snapshot import: `201` created, `200` the same items as now (a
retry), `409 conflict` on a stale base, `409 mode` for a model still in
files mode, `422 invalid_items` with `errors` of the form
`{ folderId, name, line?, column?, kind, message }`. Each changed item comes
back with its full name in `items`.

With `?dryRun=true` it only checks, and takes slice 2's `securityContext`
and `probes` (queries use full names); it answers `200` with `{ valid,
errors, probes, items, itemsHash, currentRevision }`.

#### `PUT …/snapshot` with items

`{ baseRevision, folders, items, source }` replaces the whole folder tree and
item set, resolving every item afresh: the first import, and a recovery. A
model in items mode refuses a file set (`409 mode`).

**The items hash** (`itemsHash`) is the SHA-256 of the items sorted by folder
id then name, as the JSON `[{"folderId","name","kind","yaml"}, …]`; the client
can compute it to know whether xcube holds its items.

#### `GET …/items`

Every item of the current revision:
`{ folderId, name, kind, fullName, bindings: { shortName: fullName } }`.

#### `POST …/resolve`

`{ "folderId": "f7k2", "names": ["orders", "customers"] }` →
`{ "names": { "orders": "f7k2__orders", "customers": "customers" } }`, or
`null` for a name nothing on the folder's path holds.

#### `GET …/revision`

```json
{
  "model": "dev",
  "generation": "8f0c6f0e-…",
  "current": { "revision": 42, "contentHash": "…", "files": 7, "bytes": 18234,
               "createdAt": "2026-09-26T10:00:00.000Z", "source": { "reason": "publish" } },
  "instance": { "revision": 42, "state": "active" }
}
```

`instance` is what the answering process serves: `active`, `activating`,
`failed` (with `error`) or `none`. `404` when there is no such model.

## Introspection API

### Configuration

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

### Routes

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

#### `GET …/data-sources`

The data sources that can be browsed.

```json
{ "dataSources": [{ "dataSource": "default", "dbType": "postgres" }] }
```

#### `GET …/data-sources/{dataSource}/schemas`

The data source's schemas, sorted by name. `search` keeps those whose name
contains it, ignoring case.

```json
{ "schemas": [{ "name": "public" }, { "name": "sales" }] }
```

#### `GET …/data-sources/{dataSource}/tables`

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

#### `POST …/data-sources/{dataSource}/columns`

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

#### `POST …/data-sources/{dataSource}/scaffold`

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
when these name a database to use: `XCUBE_TEST_DATABASE_URL` (a Postgres URL,
for xcube's schema; each suite uses a schema of its own), `INTROSPECTION_TEST_POSTGRES=host:port`
(user, password and database `test`), `INTROSPECTION_TEST_MYSQL=host:port`
(user `root`, password `test`, database `test`) and
`INTROSPECTION_TEST_TRINO=host:port` (its `tpch` catalog; run as
`USER=presto`).

`test/image/serving.sh <image>` boots an image serving models against a
Postgres, imports a snapshot and queries it; CI runs it on every build.

## Moving to another Cube version

1. Set the new version in `peerDependencies`, `devDependencies` and the
   `Dockerfile`'s `CUBE_VERSION`, and `npm install`.
2. Run `npm run typecheck` and `npm test`: a protected method Cube changed
   fails there.
3. Compare `src/scaffolding` with the new version's
   `packages/cubejs-schema-compiler/src/scaffolding`, and the queries in
   `src/catalog/views.ts` with the drivers', and carry over what changed.
