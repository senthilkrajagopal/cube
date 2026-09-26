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
  `scheduledRefreshContexts`, `contextToGroups`), set by
  `require('xcube').config()`; beyond them it deletes replaced models from
  Cube's compiler cache (a protected field) and wraps the public
  `runScheduledRefresh` and `listen`;
- gates access policies by folder in a subclass of Cube's `CompilerApi`
  (its protected `getApplicablePolicies`), verifies tokens before Cube's own
  check (the gateway's protected `createCheckAuthFn`), and grants API scopes
  by the token's role;
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
   | `overlayClaim` | `xcubeOverlay` | The claim naming the overlay a request previews |

   `contextToAppId`, `repositoryFactory` and `schemaVersion` belong to xcube;
   `config()` refuses them. `extendContext` and `scheduledRefreshContexts`
   are combined with xcube's. `contextToGroups` defaults to the security
   context's `groups`, and never yields the folder gate's reserved group.
   `allowNodeRequire` defaults to `false`, and `compilerCacheSize` to 2000.
   The query and pre-aggregation queues beat every 8 seconds unless
   `orchestratorOptions` sets their `heartBeatInterval`. Cube releases a query
   or build whose instance misses four, so a crashed instance's work is taken
   up in about 30 seconds, not Cube's 2 minutes.
3. **Run every Cube process from this image**, API instances and the refresh
   worker alike, with `XCUBE_DATABASE_URL` set. A process with the database
   set whose `cube.js` doesn't use `config()` refuses to start.

| Variable | Default | Meaning |
| --- | --- | --- |
| `XCUBE_DATABASE_URL` | unset | Turns serving on. Unset, xcube serves introspection only |
| `XCUBE_DATABASE_SCHEMA` | `xcube` | xcube's schema, and the prefix of its notification channel |
| `XCUBE_SERVICE_KEYS` | unset | The service credential's public keys: a JWK set, or PEM public keys or certificates (whose kid is their RFC 7638 thumbprint). Private keys are refused |
| `XCUBE_SERVICE_KEYS_FILE` | unset | A file holding them instead (a mounted Secret), re-read on each poll |
| `XCUBE_SERVICE_AUDIENCE` | `xcube-admin` | The `aud` of service tokens |
| `XCUBE_SERVICE_ISSUER` | unset | When set, the `iss` service tokens must carry |
| `XCUBE_TOKEN_AUDIENCE` | `xcube` | The `aud` of user tokens |
| `XCUBE_TOKEN_CLOCK_TOLERANCE_S` | `60` | Clock skew allowed on `exp`, `iat` and `nbf` |
| `XCUBE_TOKEN_MAX_LIFETIME_S` | `3600` | The longest a token may live (`exp - iat`) |
| `XCUBE_HS256` | `until-keys` | Tokens signed with `CUBEJS_API_SECRET`: taken for a model until it has keys, or `off` |
| `XCUBE_OVERLAY_TTL_S` | `86400` | How long an overlay lives when its push names no `ttlSeconds` |
| `XCUBE_OVERLAY_MAX_TTL_S` | `604800` | The longest an overlay may live; each push extends it |
| `XCUBE_MAX_OVERLAYS` | `1000` | The most overlays one model holds |
| `XCUBE_OVERLAY_IDLE_MS` | `600000` | How long an overlay's compiled modules stay once no query uses them |
| `XCUBE_MAX_ACTIVE_OVERLAYS` | `50` | The most overlays kept compiled on one instance; the least recently used makes room |
| `XCUBE_CREDENTIAL_KEY_IDS` | unset | The credential keys to load, comma-separated kids (see Connections). Unset, connections can't be used |
| `XCUBE_CREDENTIAL_ACTIVE_KID` | the only kid | The key re-wrap seals to; required when there are several |
| `XCUBE_CREDENTIAL_KEY_DIR` | `/run/secrets/xcube-credential-keys` | Where `<kid>.pem` and `<kid>.check` are (a mounted Secret) |
| `XCUBE_ADMIN_TOKENS` | unset | Static bearer tokens the admin routes also accept, comma-separated, each at least 32 characters and none equal to `CUBEJS_API_SECRET`: for bootstrap and development. With neither these nor service keys, the admin routes are off (the refresh worker) |
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

### Permissions and tokens

**The folder gate.** Cube itself refuses a folder's cubes and views to a token
holding none of the folder's allowed groups, and the model's own access
policies still apply within:

- Every cube and view xcube publishes is served to Cube with one more access
  policy, `group: xcube.folder-gate`, which matches nobody. So Cube evaluates
  policies for all of them, and one with no policy of its own is closed to a
  plain Cube.
- xcube's `CompilerApi` gates each policy check by the item's folder
  (`meta.xcube.folderId`). A context the folder doesn't admit gets no policy,
  and Cube denies it. One it admits gets the item's own policies, or all
  members and rows when it has none. The gate runs before Cube's policy
  cache, from permissions held in memory, so a permission change applies at
  once, with no compile.
- A folder admits a context holding one of its **allowed groups**, which the
  client works out and sends with the tree (granted on it, on an ancestor or
  on a descendant, plus its Super-Admin group). With **security off** (the
  default) every folder admits everyone, and only the model's own policies
  apply.
- A denied context doesn't see the item in `/v1/meta`. `/v1/load` refuses it
  (Cube's `500 You requested hidden member`), and `/v1/sql` answers its SQL
  with `1 = 0`.
- Each item is gated by its own folder only. That is sound because a folder
  allows every group its children do, as the client works the sets out; with
  security on, xcube refuses groups that break it (`invalid_permissions`).
  Otherwise Cube would list, in `/v1/meta`, a view whose cubes are closed,
  and a cube extending a closed one would read it.
- An authored policy naming `xcube.folder-gate` is refused at publish.
- **Upgrading.** An xcube before schema version 4 has no gate.
  - Security can't be turned on while one is connected (`409 older_instances`:
    connections name their schema version).
  - Turning it on raises the schema's floor, so none starts on it afterwards.
  - Folder groups live in a table older code never writes.
- A model holding a file set can't have security on, and a secured model
  takes no file set: only published items carry their folder.

**Tokens.** xcube verifies RS256 tokens itself, before Cube's own check:

| Token | Signed by | Claims | Security context |
| --- | --- | --- | --- |
| User | A key pushed for the model (`PUT …/keys`), by `kid` | `aud: xcube`, `role: user`, `exp`, `iat`, `groups`, optionally the model and revision claims, and `iss` when the key set names one | `{ <modelClaim>, groups, <revisionClaim>?, xcubeRole: "user" }`, and nothing else of the token |
| Service | `XCUBE_SERVICE_KEYS` | `aud: xcube-admin`, `role: service`, `exp`, `iat`, optionally the model claim | `{ <modelClaim>?, xcubeRole: "service" }` |

- **Token checks.**
  - `exp` and `iat` are required, and `exp - iat` may be at most `XCUBE_TOKEN_MAX_LIFETIME_S`.
  - A user token is bound to the model whose key signed it. A kid that two models share needs the model named.
  - A kid no instance knows yet makes it read the keys again, at most once a second, so a key pushed moments ago is taken.
- **Scopes by role.**
  - A user token never gets `jobs`, `introspection` or `graphql`.
  - A service token gets `jobs` and `introspection` only.
  - No context reading a model with security on gets `graphql`, whatever signed it: GraphQL's schema lists every cube.
- **A service token naming a model** (the model claim) is for that model alone:
  - its admin routes (`403 forbidden` for another);
  - the jobs it posts, whose contexts must all name it.

  One naming no model serves every model.
- **HS256 tokens** signed with `CUBEJS_API_SECRET` still go to Cube's own check. They are taken for a model only until it has keys, and a token naming no model only until no model has any. `XCUBE_HS256=off` refuses them all.
- **The SQL API.**
  - A `checkSqlAuth` from `cube.js` is held to the HS256 rules: no role, and no model that has keys.
  - Cube's default check gives a context naming no model. Keep the SQL port (`CUBEJS_PG_SQL_PORT`) off unless it is needed.
- **Websockets.** Cube checks a socket's token once, when it connects. Token expiry and key changes don't close a socket already open; folder permissions still apply to each query. Keep `CUBEJS_WEB_SOCKETS` off unless it is needed.
- **The playground secret.** `CUBEJS_PLAYGROUND_AUTH_SECRET` is ignored while xcube serves models. With it, Cube takes any security context it signs, on every route.
- **Logs.** A refused token is logged as `sha256:<16 hex>`, never the token.

### Overlays

A workspace's or a proposal's unpublished items reach Cube as an
**overlay**: a changeset xcube stores beside the published model, which a
query previews when its token names it.

- **Naming.** The client signs the overlay's id into the token
  (`overlayClaim`, e.g. `wechartOverlay`), and only for those it may show it
  to: a workspace's owner, a proposal's author and deciders. A token naming an
  overlay that expired or was dropped is answered `410`. Responses carry
  `x-xcube-overlay: <id>@<version>`.
- **Live.** An overlay is applied to whatever is published when it is
  queried, so a preview is today's model plus the overlay's changes. If a
  publish leaves it not applying (it deletes a cube the overlay uses), its
  queries answer `409`, naming the item, until a fixed overlay is pushed.
- **Names** in an overlay's items resolve among the overlay's items first,
  then along each item's folder path (its origin or target). An overlay item
  in a folder replaces the published item of that name there.
- **Only what changes compiles.** The overlay's items are grouped into
  modules as a publish would group them. A module whose files are unchanged is
  the published one, already compiled; the rest compile on the overlay's
  first query, in the compile lane, and are kept while queries use them.
- **Rollups.** Nothing builds an overlay's pre-aggregations. So the items an
  overlay changes, and every item bound to one of them, are compiled without
  theirs: their previews read the source. The rest keep their built rollups.
- **Everything else applies:** the folder gate by each item's folder, `/v1/meta`
  merged across the overlay's modules, unions for queries spanning modules.

### Connections

A model's data sources are pushed to xcube as **connections**, and served to
Cube without a restart. Their secrets are sealed by the client's browser to
xcube's credential key, so the client stores them and can't open them.

**Drivers.** `postgres`, `redshift`, `mysql`, `snowflake`, `bigquery`, `mssql`,
`oracle` and `dremio`, through Cube's own drivers:

| Driver | Auth methods | Target (what a secret is bound to) |
| --- | --- | --- |
| `postgres` | `password`, `client-certificate` | host, port |
| `redshift` | `password` (Cube's driver takes IAM from its environment only) | host, port |
| `mysql` | `password`, `client-certificate` | host, port |
| `snowflake` | `key-pair`, `oauth`, `password` | account, region, warehouse |
| `bigquery` | `service-account` | projectId |
| `mssql` | `sql-login`, `ntlm`, `entra-service-principal` | host, port |
| `oracle` | `password` | connectString, database, host, port |
| `dremio` | `token`, `password` (Software only) | host, port, url |

The fields of each are in `src/connections/drivers.ts`. xcube builds each
driver's config itself and sets every key, so nothing of Cube's own
`CUBEJS_DB_*` or libpq (`PG*`) environment reaches a connection:
- no host, user, password, token or credentials file;
- no export bucket, whose AWS keys Redshift would send to the host;
- no IAM or ambient Google credentials.

The image's CI check builds every driver under a poisoned environment
(`test/image/drivers-env.js`). It fails on any poisoned value in a driver,
and on any of the connection's own fields or secrets that doesn't reach it.
Pool sizes and timeouts still come from the environment.
- **Empty secrets are refused:** a driver would fill them from its environment.
- **BigQuery takes only a service-account key.** It is rebuilt from its
  plain fields, as Google's other credential types read files or call URLs of
  their own.
- **BigQuery's constructor checks `CUBEJS_DB_EXPORT_BUCKET_TYPE`** against
  its own types. An environment naming, say, `s3` stops BigQuery connections
  from building.

**Credential keys.**
- **The key.** xcube holds X25519 private keys, one file per key in
  `XCUBE_CREDENTIAL_KEY_DIR`: `<kid>.pem` and `<kid>.check`, its sample
  credential. The kid is the key's RFC 7638 thumbprint.
- **At start** each key must be X25519, match its kid, and open its sample,
  or xcube doesn't start. Mount the Secret into every Cube process: API
  instances and the refresh worker.
- **Making one.** `xcube-keygen <dir>` makes a key and prints the public JWK
  the client seals to; `xcube-keygen <dir> <key.pem>` makes the files for an
  existing key, e.g. one from `openssl genpkey -algorithm X25519`.
- **Losing every key** means entering every secret again.
- **Sealing, scheme v1** (the client's `research/credential-sealing.md`):
  - HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
    AES-128-GCM, with `info` `wechart/data-source-secret/v1`;
  - the AAD is `["wechart/data-source-secret/v1", driver, field, [[targetKey, value], …]]`,
    with the target keys sorted and the values as strings;
  - the plaintext is padded to 256 bytes;
  - each envelope is `{ v: 1, kid, enc, ct }`, base64url.

  xcube opens it with its own RFC 9180 code on `node:crypto`. That code is
  checked against RFC 9180's vector A.1 and against `hpke` 1.1.7, the
  client's library.
- **A secret opens only for the connection it was sealed for.** xcube computes
  the binding from the connection it is about to use, so an envelope moved to
  another host, field or driver doesn't open.

**Serving.**
- **Drivers.** Cube asks `resolveDriver` for a data source's driver.
  - A model's connection gets a stable xcube driver, with Cube's own driver
    for it behind it, once it has connected.
  - A changed connection is built and tested, then swapped in. Changes go one
    at a time and never back to an older version. Running queries finish on
    the old driver, which is released once idle. A failure keeps the old one.
  - A removed connection's driver refuses calls, and serves again if the
    connection is pushed again.
  - Errors from a connection's driver reach Cube with its secrets taken out.
  - Releasing an orchestrator releases these drivers, but `/livez` doesn't
    test them.
  - Any other data source is `cube.js`'s `driverFactory`, which must return
    configs, not drivers, or Cube's from its environment.
- **Orchestrators.** A model with connections has its own orchestrator
  (drivers, queues, caches), so models never share a data source's name.
  Models without connections share Cube's, as before.
  - Cube keeps at most 100 orchestrators, so keep the models with connections
    on one process under that.
- **Pre-aggregation schemas.** Every model has its own,
  `<schema>_<model>_<hash of the id>`, fixed whatever its connections, since a
  compiled model keeps its schema. Upgrading to this makes each model's
  rollups build once more.
- **Names and the environment.**
  - A data source is named as items are: its short name in the root,
    `<folderId>__<name>` elsewhere.
  - Keep `CUBEJS_DATASOURCES` unset: Cube refuses names it doesn't declare.
  - Of a model with connections, only `default` may be Cube's from its
    environment when it has no connection: any other name is refused.
  - A model without connections uses Cube's environment for every name, as
    before.
- **A connection's driver can't change** (`409 driver_change`): Cube fixes a
  data source's SQL dialect when it compiles.

**Binding at publish.** In a model with connections, a cube's `data_source`
names a data source by its short name, and publishing binds it to the
nearest one, from the cube's folder toward the root, never a sibling's or a
descendant's.
- The resolved file holds the full name (`data_source: fsales__warehouse`).
- A name no folder on the path holds is refused, as is a full name written
  by hand.
- A cube naming none gets the nearest `default`, or, when that is the
  root's, none: Cube's default is the root's. A cube that `extends` another
  inherits its parent's.
- As with names, a published cube keeps its binding until it is published
  again.
- A connection a published cube uses can't be dropped (`409 in_use`, naming
  the cubes). For the root's `default`, that is every cube naming none.
- In a model without connections, `data_source` is left as written.
- **Introspection** lists a model's connections, so a data source can be
  browsed before any cube uses it.

### Admin API

For the client's server alone. The routes are under
`{basePath}/v1/semantic/models/{model}` and take
`Authorization: Bearer <token>`, where the token is either:
- the service credential: an RS256 token signed by one of
  `XCUBE_SERVICE_KEYS`, with `aud: xcube-admin` and `role: service`;
- or one of `XCUBE_ADMIN_TOKENS`.

Cube's own authentication and API scopes don't apply to them, and a user's
token is refused. A model id is 1 to 63 of `a-z`, `0-9`, `_` and `-`.
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

Replaces the folder tree, with each folder's allowed groups, and sets security:

```json
{
  "security": true,
  "folders": [
    { "id": "froot", "parentId": null, "allowedGroups": ["g-sales", "g-super"] },
    { "id": "f7k2", "parentId": "froot", "allowedGroups": ["g-sales", "g-super"] }
  ]
}
```

- **The tree** changes nothing Cube serves, only how later publishes resolve
  names.
- **`allowedGroups`** is at most 10,000 group names per folder.
  - A folder sent without it keeps what it has.
  - A new folder has none, and neither has a folder that moved to another parent.
  - The same holds for the folders of an items snapshot.
  - With security on, a folder may allow no group its parent doesn't.
- **`security`**, left out, is unchanged; a new model starts with it off.
- **Permissions** apply on every instance as soon as it hears of them, by
  notification or its next poll, with no compile.

It answers `{ model, hash, permissionsVersion, security }`. `permissionsVersion`
goes up only when security or a folder's groups changed.

| Status | When |
| --- | --- |
| `400` | `invalid_folders`: a bad id, a missing root, an unknown parent or a cycle |
| `400` | `invalid_permissions`: with security on, a folder allows groups its parent doesn't (`problems`) |
| `409` | `folder_in_use`: a folder that still holds items would go |
| `409` | `mode`: security on for a model holding a file set |
| `409` | `older_instances`: security turned on while an xcube before schema version 4 is connected (`instances`) |

#### `PUT …/keys`

Replaces the public keys the model's user tokens are signed with:

```json
{ "version": 7, "issuer": "https://wechart.example", "keys": [{ "kty": "RSA", "kid": "…", "n": "…", "e": "AQAB" }] }
```

- **The set is whole.** Push the next key with the current one, and drop a
  key only after the tokens it signed have expired.
- **`version` only goes up.**
  - A lower one is refused (`409 stale_keys`, with the current `version`), so a
    replica still holding an old set can't undo a newer one.
  - The same version is taken again only as the same set (`200`,
    `applied: false`); otherwise `409 conflict`.
- **Each key** must be:
  - RSA of 2048 bits or more;
  - `alg` `RS256` or absent, `use` `sig` or absent;
  - public members only;
  - named by a unique `kid` that isn't the service credential's.

  Otherwise `400 invalid_keys` or `service_kid`. The set holds 1 to 10 keys.
- **`issuer`**, when given, is the `iss` every user token must carry.
- **From the first push on**, the model takes RS256 tokens only.

It answers `{ model, version, issuer, kids, applied }`.

#### `GET …/keys`

The stored set: `{ model, version, issuer, keys }`, public keys only. `404
no_keys` when the model has none.

#### `PUT …/overlays/{id}`

Stores a workspace's or a proposal's items as an overlay:

```json
{ "upserts": [{ "folderId": "fsales", "name": "orders", "kind": "cube", "yaml": "…" }], "deletes": [], "ttlSeconds": 86400, "baseVersion": 41 }
```

- **The id** is 1 to 64 of `A-Z`, `a-z`, `0-9`, `_` and `-`.
- **Items** are as in a changeset, at most 2,000 of each; each sits in the folder it
  comes from or targets. No two may share a short name.
- **It is taken only if it applies to what is published now and every module it
  changes compiles.** Otherwise `422 invalid_items`, with `errors`, and the
  overlay stays as it was.
- **The same content again** changes nothing but the expiry.
- **Lifetime.** `ttlSeconds` (default `XCUBE_OVERLAY_TTL_S`, at most
  `XCUBE_OVERLAY_MAX_TTL_S`) counts from this push.
- **`baseVersion`** (optional) takes the push only over that version of the
  overlay, or, as `null`, only as a new one: two saves racing, or a save racing
  a drop, can't land out of order. Otherwise `409 conflict`, with
  `currentVersion`.
- **Versions only go up,** across drops too: an id dropped and pushed again
  gets a newer version, and nothing compiled for what was dropped answers it.

It answers `201` (created) or `200` with
`{ model, id, version, created, revision, expiresAt, items }`, where
`revision` is the published revision it was checked against.

| Status | When |
| --- | --- |
| `404` | `unknown_model` |
| `409` | `mode`: a model holding a file set |
| `409` | `too_many_overlays` |

#### `GET …/overlays/{id}`

`{ model, id, version, expiresAt, validatedRevision, upserts, deletes, instance }`.

- `upserts` lists `{ folderId, name, kind }`.
- `instance` is what the answering instance makes of the overlay over its
  current revision: `serving`, `idle` (not compiled now), or `broken` with its
  `errors`.
- `404` once it expired or was dropped.

#### `DELETE …/overlays/{id}`

Drops the overlay (`204`, whether or not it was there). Its queries answer `410`
from then on: at once on this instance, and on the others as soon as they hear.

#### `POST …/pre-aggregations/partitions`

A model's pre-aggregation partitions and their build state, for the client's
Jobs view. It takes and answers what Cube's
`/cubejs-system/v1/pre-aggregations/partitions` does, which isn't served
under xcube (it takes the playground secret):
`{ "query": { "timezones": ["UTC"], "preAggregations": [{ "id": "fsales__orders.main" }], "expand": ["partitions.meta", "partitions.versions"] } }`
→ `{ "preAggregationPartitions": [{ preAggregation, partitions, timezones, errors, … }] }`.
It reads the active revision: each module owning a named pre-aggregation is
asked, or every module when none is named, and a shared cube's rollups appear
once.

#### `PUT …/connections/{name}`

Stores a model's data source:

```json
{ "folderId": "froot", "driver": "postgres", "authMethod": "password",
  "fields": { "host": "db", "port": 5432, "database": "sales", "user": "cube" },
  "sealed": { "password": { "v": 1, "kid": "…", "enc": "…", "ct": "…" } },
  "revisions": { "password": "<the client's revision id>" } }
```

- **`fields`** are the form's values, secrets excepted, exactly as the
  browser sealed with them.
- **Checks.** It is taken only when its fields are the driver's and auth
  method's, every required one is there, and every secret opens for its
  target. Nothing connects: that is the test route's job.
- **Answers.**
  - `200` with the connection, its secret fields named but never returned;
  - `400 invalid_connection` (`problems`);
  - `422 invalid_secret`;
  - `409 driver_change`.
- **After storing,** every instance swaps it in as soon as it hears.

#### `GET …/connections`, `DELETE …/connections/{name}`

The model's connections (no secrets). Dropping one answers `204`, and Cube
refuses its queries at once; a connection published cubes use can't be
dropped (`409 in_use`).

#### `GET …/connections/{name}/health`

`{ name, version, revisions, instances: [{ instance, version, state, error, reportedAt, current }] }`.
- Each instance that built a driver for the connection reports it: `live`,
  or `failed` with a redacted error.
- `current` says it serves the stored version.

#### `POST …/connections/test`

Tests a connection without storing it: `{ driver, authMethod, fields, sealed }`
→ `{ ok, checks: [{ id, status, durationMs, error? }] }`.

| Check | Does |
| --- | --- |
| `secrets` | Opens each secret for this target |
| `config` | Builds the driver's config |
| `connect` | Cube's `testConnection()` |
| `schemas` | Reads the catalog, where the driver can |

Every error has the connection's secrets taken out.

#### `GET /v1/semantic/credential-keys`, `POST /v1/semantic/credentials/rewrap`

Not per model, so a service token naming a model can't use them:
- **`credential-keys`** answers `{ keys: [{ kid, x, active }] }`: the public
  keys the client seals to.
- **`rewrap`** takes `{ items: [{ ref, driver, field, fields, envelope }] }`
  (up to 1,000) and seals each to the active key with the same binding. It
  answers `{ items: [{ ref, envelope } | { ref, error }] }`, never anything
  opened.

#### `GET …/meta`

The model's field list for the client's own reads (jobs, schedules):
- as `/v1/meta` answers, merged across modules;
- with `?extended=true`, as `/v1/meta?extended` answers;
- but filtered by no one's policies, as it asks for no one.

Its public members only. `403`/`503` as queries for an unknown or not yet
loaded model.

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

**The items hash** (`itemsHash`) is the SHA-256 of the items sorted by
`folderId + "/" + name` (byte order), as the JSON
`[{"folderId","name","kind","yaml"}, …]`; the client can compute it to know
whether xcube holds its items. Golden vector: the items
`froot/customers` (`"cubes:\n  - name: customers\n"`) and `fsales/orders`
(`"cubes:\n  - name: orders\n"`), both `kind: "cube"`, hash to
`49ef16c81790839fe68a0306e4942506ba81c09e060c18c32341864ff0ffeee4`.

**Errors from Cube's compile** name the item but carry no line: Cube reads
xcube's resolved rewrite of an item, whose lines aren't the author's. YAML
errors, found before anything is resolved, carry the author's line and
column.

#### `GET …/items`

Every item of the current revision:
`{ folderId, name, kind, fullName, bindings: { shortName: fullName } }`.

#### `POST …/resolve`

`{ "folderId": "f7k2", "names": ["orders", "customers"] }` →
`{ "names": { "orders": "f7k2__orders", "customers": "customers" } }`, or
`null` for a name nothing on the folder's path holds. With
`"overlay": "<id>"`, names resolve in the overlay's items first (a workspace's
pickers, AC-281).

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

xcube relies on parts of Cube that a release can change. Each has a check
that fails when it changes:

| What | Checked by |
| --- | --- |
| Every hook xcube overrides (server core, gateway, compiler API, server) | The typecheck: each is marked `override` (`noImplicitOverride`) |
| Protected members xcube reads (`compilerCache`, `QueryCache`'s `cachePrefix`) | The typecheck: each is read from a subclass, never through a cast |
| Deep imports (`CubePropContextTranspiler`, `transform-meta-extended`, `Python3Lexer`) | The typecheck |
| One Cube version everywhere: `peerDependencies`, `devDependencies`, what is installed, the `Dockerfile` | `test/unit/cube-contract.test.ts` |
| The environment variable names behind `getEnv` keys xcube sets or reads | `test/unit/cube-contract.test.ts` |
| The text of Cube's compile errors, which xcube places by file and line | `test/unit/errors.test.ts`, on a live compile |
| The queue options Cube builds, with xcube's heartbeat | `test/unit/config.test.ts`, through Cube's own `OptsHandler` |
| Each driver's option names: every connection field reaches the driver, and no `CUBEJS_DB_*` or `PG*` value does | `test/image/drivers-env.js`, in the image (CI) |
| Policies, routing, overlays, connections and refresh, end to end | The integration tests and `test/image/serving.sh` |

To move:

1. Set the new version in `peerDependencies`, `devDependencies` and the
   `Dockerfile`'s `CUBE_VERSION`, and `npm install`.
2. Run `npm run typecheck` and `npm test` with the integration databases
   (see Development), then build the image and run `test/image/serving.sh`
   and `test/image/drivers-env.js` in it.
3. Compare `src/scaffolding` with the new version's
   `packages/cubejs-schema-compiler/src/scaffolding`, and the queries in
   `src/catalog/views.ts` with the drivers', and carry over what changed.
