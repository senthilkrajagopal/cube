# The published Cube image with this checkout's TypeScript packages laid over
# it: only their compiled `dist` changes, so no native (Rust) build is needed.
#
# The base image must be the release this checkout's packages are versioned
# at (see packages/cubejs-api-gateway/package.json), or the overlaid packages
# and the rest of the image drift apart.
#
# Build from the repository root:
#
#   docker build -f packages/cubejs-docker/overlay.Dockerfile -t cube:v1.7.45-introspection .

ARG CUBE_VERSION=v1.7.45

FROM node:24.21.0-trixie-slim AS build

WORKDIR /cubejs

COPY . .

# Scripts are skipped: they build or download native binaries, and compiling
# TypeScript needs none of them.
RUN yarn install --frozen-lockfile --ignore-scripts --network-timeout 600000

RUN yarn tsc --build \
    packages/cubejs-backend-shared \
    packages/cubejs-api-gateway \
    packages/cubejs-server-core \
    packages/cubejs-query-orchestrator \
    packages/cubejs-base-driver \
    packages/cubejs-schema-compiler \
    packages/cubejs-postgres-driver \
    packages/cubejs-redshift-driver \
    packages/cubejs-crate-driver \
    packages/cubejs-materialize-driver \
    packages/cubejs-mysql-driver \
    packages/cubejs-bigquery-driver \
    packages/cubejs-clickhouse-driver \
    packages/cubejs-prestodb-driver \
    packages/cubejs-duckdb-driver \
    packages/cubejs-databricks-jdbc-driver

FROM cubejs/cube:${CUBE_VERSION}

COPY --from=build /cubejs/packages/cubejs-backend-shared/dist /cube/node_modules/@cubejs-backend/shared/dist
COPY --from=build /cubejs/packages/cubejs-api-gateway/dist /cube/node_modules/@cubejs-backend/api-gateway/dist
COPY --from=build /cubejs/packages/cubejs-server-core/dist /cube/node_modules/@cubejs-backend/server-core/dist
COPY --from=build /cubejs/packages/cubejs-query-orchestrator/dist /cube/node_modules/@cubejs-backend/query-orchestrator/dist
COPY --from=build /cubejs/packages/cubejs-base-driver/dist /cube/node_modules/@cubejs-backend/base-driver/dist
COPY --from=build /cubejs/packages/cubejs-schema-compiler/dist /cube/node_modules/@cubejs-backend/schema-compiler/dist
COPY --from=build /cubejs/packages/cubejs-postgres-driver/dist /cube/node_modules/@cubejs-backend/postgres-driver/dist
COPY --from=build /cubejs/packages/cubejs-redshift-driver/dist /cube/node_modules/@cubejs-backend/redshift-driver/dist
COPY --from=build /cubejs/packages/cubejs-crate-driver/dist /cube/node_modules/@cubejs-backend/crate-driver/dist
COPY --from=build /cubejs/packages/cubejs-materialize-driver/dist /cube/node_modules/@cubejs-backend/materialize-driver/dist
COPY --from=build /cubejs/packages/cubejs-mysql-driver/dist /cube/node_modules/@cubejs-backend/mysql-driver/dist
COPY --from=build /cubejs/packages/cubejs-bigquery-driver/dist /cube/node_modules/@cubejs-backend/bigquery-driver/dist
COPY --from=build /cubejs/packages/cubejs-clickhouse-driver/dist /cube/node_modules/@cubejs-backend/clickhouse-driver/dist
COPY --from=build /cubejs/packages/cubejs-prestodb-driver/dist /cube/node_modules/@cubejs-backend/prestodb-driver/dist
COPY --from=build /cubejs/packages/cubejs-duckdb-driver/dist /cube/node_modules/@cubejs-backend/duckdb-driver/dist
COPY --from=build /cubejs/packages/cubejs-databricks-jdbc-driver/dist /cube/node_modules/@cubejs-backend/databricks-jdbc-driver/dist
