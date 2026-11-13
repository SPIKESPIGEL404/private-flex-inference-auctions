#!/usr/bin/env bash
# Local dstack-shaped stack acceptance without Phala. Builds the Market image,
# starts Postgres/Redis/Market/Caddy with host networking, checks HTTPS on 443,
# and fails if stack ports listen on a non-loopback address.
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
WORK="$(mktemp -d "${TMPDIR:-/tmp}/market-dstack-local.XXXXXX")"
BUYERS_BAK=""
if [ -f "$DEPLOY/buyers.public.json" ]; then
  BUYERS_BAK="$WORK/buyers.public.json.bak"
  cp "$DEPLOY/buyers.public.json" "$BUYERS_BAK"
fi

cleanup() {
  docker compose --project-directory "$DEPLOY" \
    -f "$DEPLOY/docker-compose.yml" -f "$DEPLOY/docker-compose.local.yml" \
    --env-file "$WORK/local.env" down -v --remove-orphans >/dev/null 2>&1 || true
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
const buyers = [0, 1, 2].map(() => generateBuyerKeypair());
writeFileSync(
  'deploy/market/buyers.public.json',
  JSON.stringify({ public_keys: buyers.map((b) => b.publicKey) }, null, 2) + '\n',
);
const tokens = buyers.map(() => {
  const id = randomUUID().replaceAll('-', '');
  return 'brk_' + id + '.' + id + id;
});
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
while (( SECONDS < deadline )); do
  if host_curl -skf --connect-timeout 2 https://127.0.0.1/healthz 2>/dev/null | grep -q '"ready":true'; then
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

# Fail closed if any stack port other than 443 listens on a non-loopback
# address. Parse /proc/net/tcp* from the host network namespace (no extra pkgs).
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
    # Stack + tls-alpn-01 internals (9443 lego ACME, 9444 HAProxy TLS frontend).
    case "$port" in
      5432|6379|8080|9443|9444) ;;
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

host_curl -sf --connect-timeout 2 http://127.0.0.1:8080/healthz | grep -q '"ready":true'

echo "{\"market_dstack_local\":\"pass\",\"attested\":false,\"https_443\":true,\"non_loopback_stack_ports\":false}"
