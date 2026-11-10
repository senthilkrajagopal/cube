# syntax=docker/dockerfile:1.7
# Cube's published image with the xcube package added. Cube itself is
# unchanged: the package is laid beside Cube's own packages, so it uses the very
# modules the image runs, and the image starts it instead of `cubejs server`.
# DuckDB alone is swapped: @duckdb/node-api is the package's (its lock's, set
# by its `overrides`), in place of the one Cube's image ships.
#
# Build from this directory:
#
#   docker build -t xcube:v1.8.21-$(git rev-parse --short=10 HEAD) .
#
# CUBE_VERSION must be the version the package's peerDependencies name; the
# server refuses to start on any other.

ARG CUBE_VERSION=v1.8.21

# The build only compiles TypeScript, so it runs once, on the builder's own
# platform; the image for each platform is Cube's with the output copied in.
FROM --platform=$BUILDPLATFORM node:24.22.1-trixie-slim AS build

WORKDIR /package

COPY package.json package-lock.json ./
# Scripts build or download native binaries; compiling needs none of them.
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN npm run build

# DuckDB's extensions, for the platform the image is built for, not the
# builder's: fetched on the builder, they are only files. The pods never
# download one (`autoinstall_known_extensions` is off), and DuckDB checks each
# one's signature as it loads it. The version is the DuckDB of the package's
# @duckdb/node-api, the image's (`duckdb-node`).
FROM --platform=$BUILDPLATFORM node:24.22.1-trixie-slim AS duckdb-extensions

ARG TARGETARCH
COPY package-lock.json /package/
RUN <<'SH'
set -eu
case "$TARGETARCH" in
  amd64|arm64) ;;
  *) echo "No DuckDB extensions for $TARGETARCH" >&2; exit 1 ;;
esac
node - <<'JS'
const fs = require('fs');
const zlib = require('zlib');
const lock = require('/package/package-lock.json');
const version = `v${lock.packages['node_modules/@duckdb/node-api'].version.split('-')[0]}`;
const platform = `linux_${process.env.TARGETARCH}`;
const dir = `/duckdb-extensions/${version}/${platform}`;
fs.mkdirSync(dir, { recursive: true });
(async () => {
  // iceberg loads avro.
  for (const name of ['httpfs', 'aws', 'iceberg', 'avro', 'motherduck']) {
    const url = `https://extensions.duckdb.org/${version}/${platform}/${name}.duckdb_extension.gz`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`${url}: ${res.status}`);
    }
    fs.writeFileSync(`${dir}/${name}.duckdb_extension`, zlib.gunzipSync(Buffer.from(await res.arrayBuffer())));
    console.log(`${dir}/${name}.duckdb_extension`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
JS
SH

# The package's @duckdb/node-api and its bindings, for the platform the image
# is built for, as the lock has them: fetched from its URLs and checked
# against its integrity, as `npm ci` would.
FROM --platform=$BUILDPLATFORM node:24.22.1-trixie-slim AS duckdb-node

ARG TARGETARCH
COPY package-lock.json /package/
RUN <<'SH'
set -eu
case "$TARGETARCH" in
  amd64|arm64) ;;
  *) echo "No DuckDB bindings for $TARGETARCH" >&2; exit 1 ;;
esac
node - <<'JS'
const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');
const lock = require('/package/package-lock.json');
const arch = process.env.TARGETARCH === 'amd64' ? 'x64' : 'arm64';
(async () => {
  for (const name of ['node-api', 'node-bindings', `node-bindings-linux-${arch}`]) {
    const { version, resolved, integrity } = lock.packages[`node_modules/@duckdb/${name}`];
    const res = await fetch(resolved);
    if (!res.ok) {
      throw new Error(`${resolved}: ${res.status}`);
    }
    const tgz = Buffer.from(await res.arrayBuffer());
    const [algorithm, digest] = integrity.split(/-(.*)/s);
    if (crypto.createHash(algorithm).update(tgz).digest('base64') !== digest) {
      throw new Error(`${resolved}: not the lock's ${integrity}`);
    }
    const dir = `/duckdb-node/@duckdb/${name}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync('/tmp/package.tgz', tgz);
    execFileSync('tar', ['-xzf', '/tmp/package.tgz', '--strip-components=1', '--no-same-owner', '-C', dir]);
    console.log(`${dir} ${version}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
JS
SH

FROM cubejs/cube:${CUBE_VERSION}

# The fork's commit the package was built from, the image's version (its tag's, `v<cube>-<commit>`)
# and when it was built: CI passes them, in place of Cube's image's own.
ARG REVISION=unknown
ARG VERSION=unknown
ARG CREATED=unknown

LABEL org.opencontainers.image.title="xcube" \
      org.opencontainers.image.source="https://github.com/senthilkrajagopal/cube" \
      org.opencontainers.image.url="https://github.com/senthilkrajagopal/cube/tree/feat/xcube/xcube" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.description="Cube with the xcube package: models served from xcube's schema, and data source introspection" \
      org.opencontainers.image.licenses="Apache-2.0"

COPY --from=build /package/dist/src /cube/node_modules/xcube/dist/src
COPY package.json NOTICE README.md /cube/node_modules/xcube/
RUN rm -rf /cube/node_modules/@duckdb
COPY --from=duckdb-node /duckdb-node/@duckdb /cube/node_modules/@duckdb
COPY --from=duckdb-extensions /duckdb-extensions /cube/duckdb-extensions
ENV XCUBE_DUCKDB_EXTENSION_DIRECTORY=/cube/duckdb-extensions

CMD ["node", "/cube/node_modules/xcube/dist/src/bin/server.js"]
