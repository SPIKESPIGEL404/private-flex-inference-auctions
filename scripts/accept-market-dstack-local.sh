#!/usr/bin/env bash
# Local dstack-shaped stack acceptance without Phala. Builds the Market image,
# starts Postgres/Redis/Market/Caddy with host networking, checks HTTPS on 443,
# proves a signed purchase against the golden catalog (frozen clock ≥24h past),
# regenerates the golden bytes from committed constants, refuses a mutated
# catalog on restart, and fails if stack ports listen on a non-loopback address.
set -euo pipefail
cd "$(dirname "$0")/.."

# Prefer docker.exe on WSL when the Desktop CLI shim is broken (I/O error).
if command -v docker.exe >/dev/null 2>&1; then
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    docker() { docker.exe "$@"; }
  fi
fi
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

ROOT="$PWD"
DEPLOY="$ROOT/deploy/market"
# Keep WORK under the repo so Docker Desktop can bind-mount it ( /tmp is not shared ).
mkdir -p "$ROOT/.accept-work"
WORK="$(mktemp -d "$ROOT/.accept-work/market-dstack-local.XXXXXX")"
BUYERS_BAK=""
if [ -f "$DEPLOY/buyers.public.json" ]; then
  BUYERS_BAK="$WORK/buyers.public.json.bak"
  cp "$DEPLOY/buyers.public.json" "$BUYERS_BAK"
fi

cleanup() {
  docker compose --project-directory "$DEPLOY" \
    -f "$DEPLOY/docker-compose.yml" -f "$DEPLOY/docker-compose.local.yml" \
    --env-file "$WORK/local.env" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f market-catalog-golden-regen-pg market-catalog-golden-regen-redis >/dev/null 2>&1 || true
  if [ -n "$BUYERS_BAK" ]; then
    cp "$BUYERS_BAK" "$DEPLOY/buyers.public.json"
  else
    rm -f "$DEPLOY/buyers.public.json"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

umask 077
node --input-type=module <<JS
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { generateBuyerKeypair } from './clients/market-buyer/purchase-sign.mjs';
const buyers = [0, 1, 2].map((i) => {
  const pair = generateBuyerKeypair();
  writeFileSync('$WORK/buyer-' + i + '.secret', pair.secretKey + '\n', { mode: 0o600 });
  return pair;
});
writeFileSync(
  'deploy/market/buyers.public.json',
  JSON.stringify({ public_keys: buyers.map((b) => b.publicKey) }, null, 2) + '\n',
);
const tokens = buyers.map(() => {
  const id = randomUUID().replaceAll('-', '');
  return 'brk_' + id + '.' + id + id;
});
writeFileSync('$WORK/tokens.json', JSON.stringify(tokens) + '\n', { mode: 0o600 });
writeFileSync(
  '$WORK/local.env',
  [
    'BUYER_0_TOKEN=' + tokens[0],
    'BUYER_1_TOKEN=' + tokens[1],
    'BUYER_2_TOKEN=' + tokens[2],
    'PRIVATE_MARKET_DOMAIN=localhost',
  ].join('\n') + '\n',
);
JS

python3 "$ROOT/scripts/render-market-compose-hash.py" \
  --market-image "private-market-host@sha256:$(python3 -c 'print("ab"*32)')" \
  --domain localhost \
  --buyers-public "$DEPLOY/buyers.public.json" \
  --out-dir "$WORK/rendered" >/dev/null

bash "$ROOT/scripts/prepare-market-docker-cargo.sh"

docker compose --project-directory "$DEPLOY" \
  -f "$DEPLOY/docker-compose.yml" -f "$DEPLOY/docker-compose.local.yml" \
  --env-file "$WORK/local.env" build

# Regen golden from committed constants via the image binary; must match repo bytes.
GOLDEN_COMMITTED="$DEPLOY/catalog.json"
test -f "$GOLDEN_COMMITTED"
docker rm -f market-catalog-golden-regen-pg market-catalog-golden-regen-redis >/dev/null 2>&1 || true
docker run -d --name market-catalog-golden-regen-pg --network host \
  -e POSTGRES_USER=market -e POSTGRES_PASSWORD=regen -e POSTGRES_DB=private_market_golden_regen \
  postgres@sha256:ece55f7868da684e400f82f1030a050718adbdd65c23aa500c486f6e2950dc0f \
  postgres -c listen_addresses=127.0.0.1 -c port=55433
docker run -d --name market-catalog-golden-regen-redis --network host \
  redis@sha256:2e3eb11462c4e3759e6972678dd051d150ff54b1e60714b3c33b701260172a90 \
  redis-server --bind 127.0.0.1 --port 56379 --protected-mode yes --save '' --appendonly no
for i in $(seq 1 60); do
  if docker run --rm --network host --entrypoint bash \
    debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc \
    -c 'timeout 1 bash -c "echo >/dev/tcp/127.0.0.1/55433" && timeout 1 bash -c "echo >/dev/tcp/127.0.0.1/56379"' \
    >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
cid="$(docker create --network host --user 0 \
  --entrypoint /usr/local/bin/private-market-host \
  -e DATABASE_URL='postgres://market:regen@127.0.0.1:55433/private_market_golden_regen' \
  -e REDIS_URL='redis://127.0.0.1:56379' \
  -e BITROUTER_PREVIEW_BOOTSTRAP_BINDING='golden-regen' \
  -e REDIS_BALANCE_CUTOVER_TOKEN='golden-regen' \
  -e DATABASE_MIN_CONNECTIONS=1 \
  -e DATABASE_MAX_CONNECTIONS=4 \
  private-market-host:local \
  emit-deploy-catalog /tmp/catalog.regen.json)"
docker start -a "$cid"
docker cp "$cid":/tmp/catalog.regen.json "$WORK/catalog.regen.json"
docker rm -f "$cid" >/dev/null
docker rm -f market-catalog-golden-regen-pg market-catalog-golden-regen-redis >/dev/null 2>&1 || true
cmp -s "$GOLDEN_COMMITTED" "$WORK/catalog.regen.json"
cmp -s <(docker run --rm --entrypoint cat private-market-host:local /etc/market/catalog.json) \
  "$GOLDEN_COMMITTED"

# Frozen clock must be ≥24h older than wall clock (deploy catalog policy).
python3 - <<'PY'
import json, time, pathlib
at = 1_700_000_000_000
now_ms = int(time.time() * 1000)
assert now_ms - at >= 24 * 60 * 60 * 1000, (now_ms, at)
catalog = json.loads(pathlib.Path("deploy/market/catalog.json").read_bytes())
text = json.dumps(catalog)
assert "127.0.0.1:18080" in text
assert str(at) in text
assert "4102444800000" in text
print("frozen_clock_ok")
PY

docker compose --project-directory "$DEPLOY" \
  -f "$DEPLOY/docker-compose.yml" -f "$DEPLOY/docker-compose.local.yml" \
  --env-file "$WORK/local.env" up -d

# Docker Desktop host networking lives in the Linux VM, not WSL/Windows
# localhost. Probe and listen-check from a container on that network namespace.
CURL_IMAGE="curlimages/curl@sha256:08e466006f0860e54fc299378de998935333e0e130a15f6f98482e9f8dab3058"
DEBIAN_IMAGE="debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc"
host_curl() {
  docker run --rm --network host "$CURL_IMAGE" "$@"
}

deadline=$((SECONDS + 240))
ok=0
health=""
while (( SECONDS < deadline )); do
  if health="$(host_curl -skf --connect-timeout 2 https://127.0.0.1/healthz 2>/dev/null)" \
    && echo "$health" | grep -q '"ready":true'; then
    ok=1
    break
  fi
  sleep 2
done
if [ "$ok" != 1 ]; then
  docker compose --project-directory "$DEPLOY" \
    -f "$DEPLOY/docker-compose.yml" -f "$DEPLOY/docker-compose.local.yml" \
    --env-file "$WORK/local.env" logs >&2 || true
  echo "Market was not reachable on https://127.0.0.1/healthz" >&2
  exit 1
fi

DIGEST="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["catalog_policy_digest"])' "$health")"
EXPECTED="$(python3 -c 'import hashlib,pathlib; print("sha256:"+hashlib.sha256(pathlib.Path("deploy/market/catalog.json").read_bytes()).hexdigest())')"
test "$DIGEST" = "$EXPECTED"

# Fail closed if any stack port other than 443 listens on a non-loopback
# address. Parse /proc/net/tcp* from the host network namespace (no extra pkgs).
# Includes fixture 18080 (loopback-only seller published in the golden catalog).
bad="$(docker run --rm --network host --entrypoint bash "$DEBIAN_IMAGE" -c '
set -euo pipefail
check_proc() {
  local file="$1" loopback_ip="$2" label="$3"
  [ -f "$file" ] || return 0
  local _sl local_addr _rem st _rest ip port_hex port
  while read -r _sl local_addr _rem st _rest; do
    [ "$st" = "0A" ] || continue
    ip="${local_addr%:*}"
    port_hex="${local_addr##*:}"
    port=$((16#$port_hex))
    # Stack + fixture + tls-alpn-01 internals (9443 lego ACME, 9444 HAProxy TLS).
    case "$port" in
      5432|6379|8080|18080|9443|9444) ;;
      *) continue ;;
    esac
    if [ "$ip" != "$loopback_ip" ]; then
      printf "%s %s:%s\n" "$label" "$ip" "$port"
    fi
  done < <(tail -n +2 "$file")
}
check_proc /proc/net/tcp 0100007F tcp4
check_proc /proc/net/tcp6 00000000000000000000000000000001 tcp6
')"
if [ -n "${bad}" ]; then
  echo "non-loopback listeners for stack ports are forbidden (only 443 may bind non-loopback):" >&2
  echo "${bad}" >&2
  exit 1
fi

# Fixture 18080 must be listening on loopback during serve.
docker run --rm --network host --entrypoint bash "$DEBIAN_IMAGE" -c '
set -euo pipefail
found=0
while read -r _sl local_addr _rem st _rest; do
  [ "$st" = "0A" ] || continue
  ip="${local_addr%:*}"; port=$((16#${local_addr##*:}))
  if [ "$port" = "18080" ]; then
    found=1
    [ "$ip" = "0100007F" ] || { echo "fixture 18080 not loopback: $ip" >&2; exit 1; }
  fi
done < <(tail -n +2 /proc/net/tcp)
[ "$found" = 1 ] || { echo "fixture 18080 is not listening" >&2; exit 1; }
'

host_curl -sf --connect-timeout 2 http://127.0.0.1:8080/healthz | grep -q '"ready":true'

# Signed purchase end-to-end through 443 against the golden catalog.
# Must run on the Docker host network (WSL/Windows localhost cannot reach it).
TOKEN0="$(python3 -c 'import json; print(json.load(open("'"$WORK"'/tokens.json"))[0])')"
cat >"$WORK/purchase.json" <<EOF
{
  "marketUrl": "https://127.0.0.1",
  "token": "$TOKEN0",
  "keyset": "$DIGEST",
  "signingKeyFile": "/work/buyer-0.secret",
  "idempotencyKey": "dstack-local-signed-1",
  "body": {
    "model": "m/external",
    "messages": [{"role": "user", "content": "Batch A public synthetic prompt"}],
    "max_completion_tokens": 64,
    "stream": true,
    "background": true,
    "stream_options": {"include_usage": true},
    "bitrouter_purchase": {
      "service_type": "on_demand",
      "provider_cap_micro_usd": 4500,
      "total_cap_micro_usd": 4510
    },
    "bitrouter_delivery": {"auto_fallback": "off"}
  }
}
EOF
# Run the signed purchase on the Docker host network without bind mounts
# (Docker Desktop WSL bind mounts are brittle). Copy inputs via docker cp.
NODE_IMAGE="node:20-bookworm"
pcid="$(docker create --network host \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  --entrypoint sleep \
  "$NODE_IMAGE" 3600)"
docker start "$pcid" >/dev/null
docker exec "$pcid" mkdir -p /work /clients/test
docker cp "$WORK/purchase.json" "${pcid}:/work/purchase.json"
docker cp "$WORK/buyer-0.secret" "${pcid}:/work/buyer-0.secret"
docker cp "$ROOT/clients/market-buyer/purchase-sign.mjs" "${pcid}:/clients/purchase-sign.mjs"
docker cp "$ROOT/clients/market-buyer/test/signed-purchase.mjs" \
  "${pcid}:/clients/test/signed-purchase.mjs"
set +e
docker exec -e NODE_TLS_REJECT_UNAUTHORIZED=0 -w /clients "$pcid" \
  node /clients/test/signed-purchase.mjs /work/purchase.json ok
purchase_rc=$?
set -e
docker rm -f "$pcid" >/dev/null
test "$purchase_rc" -eq 0

# Mutating the state catalog must refuse the next serve (fail closed).
docker compose --project-directory "$DEPLOY" \
  -f "$DEPLOY/docker-compose.yml" -f "$DEPLOY/docker-compose.local.yml" \
  --env-file "$WORK/local.env" exec -T market \
  bash -c 'printf "\n" >>/var/lib/market/state/catalog.json'
docker compose --project-directory "$DEPLOY" \
  -f "$DEPLOY/docker-compose.yml" -f "$DEPLOY/docker-compose.local.yml" \
  --env-file "$WORK/local.env" restart market
sleep 3
refused=0
for i in $(seq 1 30); do
  if ! host_curl -skf --connect-timeout 2 https://127.0.0.1/healthz >/dev/null 2>&1; then
    # Market process should have exited; container may be restarting.
    status="$(docker compose --project-directory "$DEPLOY" \
      -f "$DEPLOY/docker-compose.yml" -f "$DEPLOY/docker-compose.local.yml" \
      --env-file "$WORK/local.env" ps market --format '{{.Status}}' 2>/dev/null || true)"
    if echo "$status" | grep -qiE 'exit|restarting|unhealthy|dead'; then
      refused=1
      break
    fi
    # Also accept continuous healthz failure after restart window.
    if (( i > 10 )); then
      refused=1
      break
    fi
  fi
  sleep 1
done
if [ "$refused" != 1 ]; then
  echo "mutated catalog must refuse serve / healthz" >&2
  docker compose --project-directory "$DEPLOY" \
    -f "$DEPLOY/docker-compose.yml" -f "$DEPLOY/docker-compose.local.yml" \
    --env-file "$WORK/local.env" logs market >&2 || true
  exit 1
fi

echo "{\"market_dstack_local\":\"pass\",\"attested\":false,\"https_443\":true,\"signed_purchase\":true,\"catalog_policy_digest\":\"$DIGEST\",\"golden_regen\":true,\"catalog_mutate_refused\":true,\"fixture_18080_loopback\":true,\"non_loopback_stack_ports\":false,\"frozen_clock_ge_24h\":true}"
