#!/usr/bin/env bash
# Runs test/image/duckdb.js in the image, on a docker network of its own with
# no way out (`--internal`) and an S3 store on it: the image's DuckDB
# extensions must load with nothing downloaded, and an S3 connection must read
# its own location only. The network and the store are removed after.
#
#   test/image/duckdb.sh <image>
set -euo pipefail

IMAGE="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
NETWORK=xcube-duckdb-check
STORE=xcube-duckdb-check-store
# An S3 store that serves minioadmin/minioadmin: MinIO's server, as wechart's compose pins it.
STORE_IMAGE="${STORE_IMAGE:-docker.io/pgsty/silo:RELEASE.2026-10-26T00-00-00Z@sha256:7bb2aff6b89efe1cb1303c10fc21d579447434ed06649ac9ec05a5e2dbf30ad7}"

trap 'docker rm -f "$STORE" >/dev/null 2>&1 || true; docker network rm "$NETWORK" >/dev/null 2>&1 || true' EXIT

docker network create --internal "$NETWORK" >/dev/null
docker run --rm -d --name "$STORE" --network "$NETWORK" --network-alias store \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  "$STORE_IMAGE" server /data >/dev/null

docker run --rm --network "$NETWORK" -v "$HERE:/t:ro" --entrypoint node "$IMAGE" /t/duckdb.js
