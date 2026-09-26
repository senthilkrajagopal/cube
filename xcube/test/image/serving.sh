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
keys="$(mktemp -d)"
trap 'docker logs "$NAME" 2>&1 | tail -20; docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$conf" "$keys"' EXIT

# Slice 4's keys, on the host only: the service credential's and the model's
# signing key. The container is given the service credential's public key.
cat > "$keys/tokens.js" <<'JS'
const crypto = require('crypto');
const fs = require('fs');
const dir = __dirname;
const [,, what, ...args] = process.argv;
const keyFile = (name) => `${dir}/${name}.pem`;
if (what === 'init') {
  for (const name of ['service', 'user']) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(keyFile(name), privateKey.export({ format: 'pem', type: 'pkcs8' }));
  }
  process.exit(0);
}
const jwk = (name, kid) => ({ ...crypto.createPublicKey(fs.readFileSync(keyFile(name))).export({ format: 'jwk' }), kid });
if (what === 'jwk' || what === 'jwks') {
  console.log(JSON.stringify(what === 'jwk' ? jwk(args[0], args[1]) : { keys: [jwk(args[0], args[1])] }));
  process.exit(0);
}
const now = Math.floor(Date.now() / 1000);
const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (name, kid, payload) => {
  const body = `${part({ alg: 'RS256', typ: 'JWT', kid })}.${part({ iat: now, exp: now + 300, ...payload })}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), fs.readFileSync(keyFile(name))).toString('base64url')}`;
};
if (what === 'service') {
  console.log(sign('service', 'svc', { aud: 'xcube-admin', role: 'service' }));
} else {
  console.log(sign('user', 'user-1', {
    aud: 'xcube', role: 'user', groups: args[0].split(','), wechartRevision: Number(args[1]), ...(args[2] ? { wechartOverlay: args[2] } : {}),
  }));
}
JS
node "$keys/tokens.js" init

# Slice 6's credential key, made by the image's own tool, mounted into the server.
mkdir -p "$keys/credential"
chmod 777 "$keys/credential"
docker run --rm --user 1000 -v "$keys/credential:/keys" --entrypoint node "$IMAGE" \
  /cube/node_modules/xcube/dist/src/bin/keygen.js /keys > "$keys/credential.jwk"
credential_kid="$(sed -E 's/.*"kid":"([^"]+)".*/\1/' "$keys/credential.jwk")"
# The files are uid 1000's, as the server is: on Linux the host user can't chmod them, and needn't.
mkdir -p "$conf/model"
echo "module.exports = require('xcube').config({ modelClaim: 'wechartModel', revisionClaim: 'wechartRevision', overlayClaim: 'wechartOverlay' });" > "$conf/cube.js"
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
  -e XCUBE_SERVICE_KEYS="$(node "$keys/tokens.js" jwks service svc)" \
  -v "$keys/credential:/run/secrets/xcube-credential-keys:ro" \
  -e XCUBE_CREDENTIAL_KEY_IDS="$credential_kid" \
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

# Slice 4: the model's keys and folder groups pushed with the service
# credential, then RS256 user tokens through the folder gate.
service="$(node "$keys/tokens.js" service)"
signed() {
  curl -s -o /tmp/xcube-admin.json -w '%{http_code}' -X "$1" \
    -H "Authorization: Bearer $service" -H 'Content-Type: application/json' \
    ${3:+--data "$3"} "$CUBE_URL/cubejs-api/v1/semantic/models/items$2"
}
status="$(signed PUT /keys "{\"version\": 1, \"keys\": [$(node "$keys/tokens.js" jwk user user-1)]}")"
[ "$status" = 200 ] || { echo "keys answered $status"; cat /tmp/xcube-admin.json; exit 1; }
status="$(signed PUT /folders '{"security": true, "folders": [{"id": "froot", "parentId": null, "allowedGroups": ["g_sub", "sa"]}, {"id": "fsub", "parentId": "froot", "allowedGroups": ["g_sub", "sa"]}]}')"
[ "$status" = 200 ] || { echo "folders answered $status"; cat /tmp/xcube-admin.json; exit 1; }

query() {
  curl -s -o /tmp/xcube-query.json -w '%{http_code}' -H "Authorization: $1" -H 'Content-Type: application/json' \
    --data '{"query": {"measures": ["fsub__doubled.total"]}}' "$CUBE_URL/cubejs-api/v1/load"
}
status="$(query "$(node "$keys/tokens.js" user g_sub "$revision")")"
[ "$status" = 200 ] && grep -q '"fsub__doubled.total":"84"' /tmp/xcube-query.json || { echo "a user of g_sub got $status"; cat /tmp/xcube-query.json; exit 1; }
status="$(query "$(node "$keys/tokens.js" user nobody "$revision")")"
[ "$status" != 200 ] || { echo "a user of no allowed group was answered"; cat /tmp/xcube-query.json; exit 1; }
meta="$(curl -s -H "Authorization: $(node "$keys/tokens.js" user nobody "$revision")" "$CUBE_URL/cubejs-api/v1/meta")"
[ "$meta" = '{"cubes":[]}' ] || { echo "a user of no allowed group sees: $meta"; exit 1; }
status="$(query "$token")"
[ "$status" = 403 ] || { echo "an HS256 token for a model with keys got $status"; exit 1; }
status="$(signed GET /meta)"
[ "$status" = 200 ] && grep -q '"name":"fsub__doubled"' /tmp/xcube-admin.json || { echo "the admin field list answered $status"; exit 1; }
echo "Security check passed: keys and folder groups pushed with the service credential; the gate admits g_sub and refuses the rest."

# Slice 5: a workspace's change pushed as an overlay, previewed by a token naming it.
tripled_item='{"folderId": "fsub", "name": "doubled", "kind": "cube", "yaml": "cubes:\n  - name: doubled\n    sql: \"SELECT id, amount * 3 AS amount FROM {serving_check.sql()}\"\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n"}'
status="$(signed PUT /overlays/ws-check "{\"upserts\": [$tripled_item]}")"
[ "$status" = 201 ] || { echo "overlay answered $status"; cat /tmp/xcube-admin.json; exit 1; }
status="$(query "$(node "$keys/tokens.js" user g_sub "$revision" ws-check)")"
[ "$status" = 200 ] && grep -q '"fsub__doubled.total":"126"' /tmp/xcube-query.json || { echo "the overlay's preview got $status"; cat /tmp/xcube-query.json; exit 1; }
status="$(query "$(node "$keys/tokens.js" user g_sub "$revision")")"
[ "$status" = 200 ] && grep -q '"fsub__doubled.total":"84"' /tmp/xcube-query.json || { echo "the published model got $status"; exit 1; }
status="$(signed DELETE /overlays/ws-check)"
[ "$status" = 204 ] || { echo "dropping the overlay answered $status"; exit 1; }
status="$(query "$(node "$keys/tokens.js" user g_sub "$revision" ws-check)")"
[ "$status" = 410 ] || { echo "a dropped overlay's preview got $status"; exit 1; }
echo "Overlay check passed: a workspace's change previewed through its overlay, then dropped."

# Slice 6: a model whose default data source is a connection, its password
# sealed (by the image's own code, as the client's browser would) to the key.
target='{"host": "'"$PG_HOST"'", "port": 5432, "database": "test", "ssl": false}'
sealed="$(docker run --rm --network "$DOCKER_NETWORK" --entrypoint node "$IMAGE" -e '
  const { sealSecretV1 } = require("/cube/node_modules/xcube/dist/src/credentials/credentials");
  const [x, kid, target] = process.argv.slice(1);
  console.log(JSON.stringify(sealSecretV1(x, kid, "postgres", "password", JSON.parse(target), "test")));
' "$(sed -E 's/.*"x":"([^"]+)".*/\1/' "$keys/credential.jwk")" "$credential_kid" "$target")"
conn() {
  curl -s -o /tmp/xcube-admin.json -w '%{http_code}' -X "$1" \
    -H "Authorization: Bearer $service" -H 'Content-Type: application/json' \
    ${3:+--data "$3"} "$CUBE_URL/cubejs-api/v1/semantic/models/conn$2"
}
connection="{\"folderId\": \"froot\", \"driver\": \"postgres\", \"authMethod\": \"password\", \"fields\": $(echo "$target" | sed 's/}$/, "user": "test"}/'), \"sealed\": {\"password\": $sealed}}"
status="$(conn PUT /connections/default "$connection")"
[ "$status" = 200 ] || { echo "the connection answered $status"; cat /tmp/xcube-admin.json; exit 1; }
status="$(conn PUT /snapshot '{"baseRevision": null, "folders": [{"id": "froot", "parentId": null}], "items": [{"folderId": "froot", "name": "via_connection", "kind": "cube", "yaml": "cubes:\n  - name: via_connection\n    sql_table: public.serving_check\n    measures:\n      - name: total\n        sql: amount\n        type: sum\n"}]}')"
case "$status" in 200|201) ;; *) echo "the connection model's snapshot answered $status"; cat /tmp/xcube-admin.json; exit 1 ;; esac
conn_revision="$(sed -E 's/.*"revision":([0-9]+).*/\1/' /tmp/xcube-admin.json)"
conn_token="$(node -e '
  const crypto = require("crypto");
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ wechartModel: "conn", wechartRevision: Number(process.argv[2]) })}`;
  console.log(`${body}.${crypto.createHmac("sha256", process.argv[1]).update(body).digest("base64url")}`);
' "$API_SECRET" "$conn_revision")"
answer="$(curl -s -H "Authorization: $conn_token" -H 'Content-Type: application/json' \
  --data '{"query": {"measures": ["via_connection.total"]}}' "$CUBE_URL/cubejs-api/v1/load")"
echo "$answer" | grep -q '"via_connection.total":"42"' || { echo "a query through the connection got: $(echo "$answer" | head -c 300)"; exit 1; }
status="$(conn GET /connections/default/health)"
grep -q '"state":"live"' /tmp/xcube-admin.json || { echo "the connection's health: $(cat /tmp/xcube-admin.json)"; exit 1; }
echo "Connection check passed: a model's data source served from a connection whose password was sealed to xcube's key."
