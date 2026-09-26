#!/usr/bin/env bash
# Boots the image as xcube serves models: the database bootstrap, a cube.js
# that is require('xcube').config(), then an import through the admin API and
# a query naming the imported revision. Needs a Postgres (user, password and
# database `test`) that containers reach at $PG_HOST.
#
#   test/image/serving.sh <image>
#
# Defaults suit CI's Linux runner (host networking); locally, for example:
#   DOCKER_NETWORK=my-net PG_HOST=my-pg PUBLISH=127.0.0.1:4010:4000 CUBE_URL=http://127.0.0.1:4010 test/image/serving.sh xcube:dev
set -euo pipefail

IMAGE="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
DOCKER_NETWORK="${DOCKER_NETWORK:-host}"
PG_HOST="${PG_HOST:-127.0.0.1}"
CUBE_URL="${CUBE_URL:-http://127.0.0.1:4000}"
NAME=xcube-serving-check
ADMIN_TOKEN=serving-check-admin-token-0123456789abcdef
API_SECRET=serving-check-api-secret

conf="$(mktemp -d)"
trap 'docker logs "$NAME" 2>&1 | tail -20; docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$conf"' EXIT
mkdir -p "$conf/model"
echo "module.exports = require('xcube').config({ modelClaim: 'wechartModel', revisionClaim: 'wechartRevision' });" > "$conf/cube.js"
chmod -R a+rX "$conf"

psql() {
  docker run --rm -i --network "$DOCKER_NETWORK" -e PGPASSWORD=test postgres:18-alpine \
    psql -h "$PG_HOST" -U test -d test -v ON_ERROR_STOP=1 "$@"
}
psql -v xcube_password=serving-check < "$HERE/../../bootstrap.sql"
psql -c "DROP TABLE IF EXISTS public.serving_check;
         CREATE TABLE public.serving_check (id int PRIMARY KEY, amount numeric);
         INSERT INTO public.serving_check VALUES (1, 10), (2, 32);"

publish=()
if [ -n "${PUBLISH:-}" ]; then publish=(-p "$PUBLISH"); fi
docker run -d --name "$NAME" --network "$DOCKER_NETWORK" "${publish[@]}" --user 1000 \
  -v "$conf:/cube/conf:ro" \
  -e XCUBE_DATABASE_URL="postgres://xcube:serving-check@$PG_HOST:5432/test" \
  -e XCUBE_ADMIN_TOKENS="$ADMIN_TOKEN" \
  -e CUBEJS_DB_TYPE=postgres -e CUBEJS_DB_HOST="$PG_HOST" -e CUBEJS_DB_NAME=test \
  -e CUBEJS_DB_USER=test -e CUBEJS_DB_PASS=test \
  -e CUBEJS_API_SECRET="$API_SECRET" -e CUBEJS_DEV_MODE=false \
  -e CUBEJS_CACHE_AND_QUEUE_DRIVER=memory -e CUBEJS_TELEMETRY=false \
  "$IMAGE" >/dev/null

for _ in $(seq 1 90); do
  if docker logs "$NAME" 2>&1 | grep -q "is listening on"; then break; fi
  sleep 1
done
docker logs "$NAME" 2>&1 | grep -q "is listening on"

model='cubes:\n  - name: serving_check\n    sql_table: public.serving_check\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n'
status="$(curl -s -o /tmp/xcube-import.json -w '%{http_code}' -X PUT \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data "{\"baseRevision\": null, \"files\": [{\"path\": \"check.yml\", \"content\": \"$model\"}]}" \
  "$CUBE_URL/cubejs-api/v1/semantic/models/check/snapshot")"
cat /tmp/xcube-import.json; echo
case "$status" in 200|201) ;; *) echo "import answered $status"; exit 1 ;; esac
revision="$(sed -E 's/.*"revision":([0-9]+).*/\1/' /tmp/xcube-import.json)"

token="$(node -e '
  const crypto = require("crypto");
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ wechartModel: "check", wechartRevision: Number(process.argv[2]) })}`;
  console.log(`${body}.${crypto.createHmac("sha256", process.argv[1]).update(body).digest("base64url")}`);
' "$API_SECRET" "$revision")"

answer="$(curl -s -D /tmp/xcube-headers.txt -H "Authorization: $token" -H 'Content-Type: application/json' \
  --data '{"query": {"measures": ["serving_check.total"]}}' "$CUBE_URL/cubejs-api/v1/load")"
echo "$answer" | head -c 400; echo
grep -qi "x-xcube-revision: check@$revision" /tmp/xcube-headers.txt
echo "$answer" | grep -q '"serving_check.total":"42"'
echo "Serving check passed: revision $revision imported and queried."

# Items mode: a folder tree, a root cube and a folder's own cube bound to it.
admin() {
  curl -s -o /tmp/xcube-admin.json -w '%{http_code}' -X "$1" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
    --data "$3" "$CUBE_URL/cubejs-api/v1/semantic/models/items$2"
}
status="$(admin PUT /folders '{"folders": [{"id": "froot", "parentId": null}, {"id": "fsub", "parentId": "froot"}]}')"
[ "$status" = 200 ] || { echo "folders answered $status"; cat /tmp/xcube-admin.json; exit 1; }
root_item='{"folderId": "froot", "name": "serving_check", "kind": "cube", "yaml": "cubes:\n  - name: serving_check\n    sql_table: public.serving_check\n    dimensions:\n      - name: id\n        sql: id\n        type: number\n        primary_key: true\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n"}'
sub_item='{"folderId": "fsub", "name": "doubled", "kind": "cube", "yaml": "cubes:\n  - name: doubled\n    sql: \"SELECT id, amount * 2 AS amount FROM {serving_check.sql()}\"\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n"}'
status="$(admin PUT '/snapshot' "{\"baseRevision\": null, \"folders\": [{\"id\": \"froot\", \"parentId\": null}, {\"id\": \"fsub\", \"parentId\": \"froot\"}], \"items\": [$root_item]}")"
case "$status" in 200|201) ;; *) echo "items snapshot answered $status"; cat /tmp/xcube-admin.json; exit 1 ;; esac
base="$(sed -E 's/.*"revision":([0-9]+).*/\1/' /tmp/xcube-admin.json)"
status="$(admin POST /changesets "{\"baseRevision\": $base, \"upserts\": [$sub_item]}")"
case "$status" in 200|201) ;; *) echo "changeset answered $status"; cat /tmp/xcube-admin.json; exit 1 ;; esac
cat /tmp/xcube-admin.json; echo
revision="$(sed -E 's/.*"revision":([0-9]+).*/\1/' /tmp/xcube-admin.json)"
token="$(node -e '
  const crypto = require("crypto");
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ wechartModel: "items", wechartRevision: Number(process.argv[2]) })}`;
  console.log(`${body}.${crypto.createHmac("sha256", process.argv[1]).update(body).digest("base64url")}`);
' "$API_SECRET" "$revision")"
answer="$(curl -s -H "Authorization: $token" -H 'Content-Type: application/json' \
  --data '{"query": {"measures": ["fsub__doubled.total"]}}' "$CUBE_URL/cubejs-api/v1/load")"
echo "$answer" | head -c 300; echo
echo "$answer" | grep -q '"fsub__doubled.total":"84"'
echo "Items check passed: a folder's cube, bound to a root cube, queried by its full name."
