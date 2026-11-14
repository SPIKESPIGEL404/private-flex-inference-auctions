#!/usr/bin/env bash
# Sentinel no-leak acceptance on the local dstack stack (P2/P3). Sibling of
# accept-market-dstack-local.sh. Scans logs, HTTP, Redis, seller capture, and
# non-Postgres files. Never prints sentinel values in the summary line.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v docker.exe >/dev/null 2>&1; then
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    docker() { docker.exe "$@"; }
  fi
fi
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
command -v redis-cli >/dev/null 2>&1 || { echo "redis-cli is required" >&2; exit 1; }

ROOT="$PWD"
DEPLOY="$ROOT/deploy/market"
SCRIPTS="$ROOT/scripts"
mkdir -p "$ROOT/.accept-work"
WORK="$(mktemp -d "$ROOT/.accept-work/market-no-leak.XXXXXX")"
BUYERS_BAK=""
if [ -f "$DEPLOY/buyers.public.json" ]; then
  BUYERS_BAK="$WORK/buyers.public.json.bak"
  cp "$DEPLOY/buyers.public.json" "$BUYERS_BAK"
fi

COMPOSE=(docker compose --project-directory "$DEPLOY"
  -f "$DEPLOY/docker-compose.yml" -f "$DEPLOY/docker-compose.local.yml"
  --env-file "$WORK/local.env")

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f market-controlled-dstack market-no-leak-node >/dev/null 2>&1 || true
  if [ -n "$BUYERS_BAK" ]; then
    cp "$BUYERS_BAK" "$DEPLOY/buyers.public.json"
  else
    rm -f "$DEPLOY/buyers.public.json"
  fi
  rm -f "$DEPLOY/attestation.local.json"
  rm -rf "$WORK"
}
trap cleanup EXIT

umask 077

python3 "$SCRIPTS/market_no_leak.py" check-deploy-compose --root "$ROOT"

python3 "$SCRIPTS/market_no_leak.py" mint --out "$WORK/sentinels.json"
PROVIDER_CAP="$(python3 -c "import json;print(json.load(open('$WORK/sentinels.json'))['provider_cap'])")"
TOTAL_CAP="$(python3 -c "import json;print(json.load(open('$WORK/sentinels.json'))['total_cap'])")"
TOKEN0="$(python3 -c "import json;print(json.load(open('$WORK/sentinels.json'))['buyer_bearer'])")"
IDEMPOTENCY="$(python3 -c "import json;print(json.load(open('$WORK/sentinels.json'))['idempotency_key'])")"
PROMPT="$(python3 -c "import json;print(json.load(open('$WORK/sentinels.json'))['prompt_marker'])")"
PROVIDER_KEY="$(python3 -c "import json;print(json.load(open('$WORK/sentinels.json'))['provider_key'])")"

# Buyer 1 uses sentinel bearer; buyers 1/2 get distinct non-sentinel lab tokens.
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
const token1 = 'brk_' + randomUUID().replaceAll('-', '') + '.' + randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
const token2 = 'brk_' + randomUUID().replaceAll('-', '') + '.' + randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
writeFileSync('$WORK/tokens.json', JSON.stringify(['$TOKEN0', token1, token2]) + '\n', { mode: 0o600 });
writeFileSync(
  '$WORK/local.env',
  [
    'BUYER_0_TOKEN=$TOKEN0',
    'BUYER_1_TOKEN=' + token1,
    'BUYER_2_TOKEN=' + token2,
    'PRIVATE_MARKET_DOMAIN=localhost',
  ].join('\n') + '\n',
);
JS
TOKEN1="$(python3 -c "import json;print(json.load(open('$WORK/tokens.json'))[1])")"

bash "$ROOT/scripts/prepare-market-docker-cargo.sh"

# Controlled dstack RPC
docker rm -f market-controlled-dstack >/dev/null 2>&1 || true
PY_IMAGE="python:3.12-slim-bookworm"
dcid="$(docker create --network host --name market-controlled-dstack \
  --entrypoint sleep "$PY_IMAGE" 3600)"
docker cp "$ROOT/scripts/controlled_dstack_rpc.py" "${dcid}:/controlled_dstack_rpc.py"
docker start "$dcid" >/dev/null
docker exec -d "$dcid" python /controlled_dstack_rpc.py 19527
DEBIAN_IMAGE="debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc"
CURL_IMAGE="curlimages/curl@sha256:08e466006f0860e54fc299378de998935333e0e130a15f6f98482e9f8dab3058"
for i in $(seq 1 30); do
  if docker run --rm --network host --entrypoint bash "$DEBIAN_IMAGE" \
    -c 'timeout 1 bash -c "echo >/dev/tcp/127.0.0.1/19527"' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
cat >"$DEPLOY/attestation.local.json" <<'EOF'
{
  "dstack_http": "http://127.0.0.1:19527/",
  "tls_certificate": "/run/market-tls/leaf.pem",
  "public_domain": "localhost",
  "keyset_lifetime_seconds": 300
}
EOF
chmod 0644 "$DEPLOY/attestation.local.json"

"${COMPOSE[@]}" build

host_curl() {
  docker run --rm --network host "$CURL_IMAGE" "$@"
}

# Init secrets first, plant sentinel provider key, then start the stack.
"${COMPOSE[@]}" up -d init-secrets
# Wait until secrets exist on the named volume (project name = compose dir "market").
VOL_MARKET=""
for i in $(seq 1 60); do
  VOL_MARKET="$(docker volume ls -q | grep -E '(^|_)market-data$' | head -1 || true)"
  if [ -n "$VOL_MARKET" ]; then
    if docker run --rm -v "${VOL_MARKET}:/var/lib/market" --entrypoint bash "$DEBIAN_IMAGE" \
      -c 'test -f /var/lib/market/secrets/seller_key' 2>/dev/null; then
      break
    fi
  fi
  VOL_MARKET=""
  sleep 1
done
test -n "$VOL_MARKET"
docker run --rm -v "${VOL_MARKET}:/var/lib/market" --entrypoint bash "$DEBIAN_IMAGE" -c "
set -euo pipefail
printf '%s' '$PROVIDER_KEY' > /var/lib/market/secrets/seller_key
# Root volume writes must not leave /var/lib/market unwritable by uid 10001.
chown 10001:10001 /var/lib/market
chmod 0755 /var/lib/market
chown -R 10001:10001 /var/lib/market/secrets
chmod 0700 /var/lib/market/secrets
chmod 0400 /var/lib/market/secrets/*
# Postgres-only password copy keeps uid 999.
if [ -f /var/lib/market/secrets/postgres_password.pg ]; then
  chown 999:999 /var/lib/market/secrets/postgres_password.pg
  chmod 0400 /var/lib/market/secrets/postgres_password.pg
fi
"

"${COMPOSE[@]}" up -d

# Wait for HTTPS health
ok=0
for i in $(seq 1 120); do
  if host_curl -skf --connect-timeout 2 https://127.0.0.1/healthz >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
if [ "$ok" != 1 ]; then
  "${COMPOSE[@]}" logs >&2 || true
  echo "Market was not reachable on https://127.0.0.1/healthz" >&2
  exit 1
fi

# Raise lab balances so distinctive 9-digit caps succeed.
LAB_BALANCE="$(python3 -c "import sys; sys.path.insert(0,'$SCRIPTS'); from market_no_leak import LAB_BALANCE_MICRO_USD; print(LAB_BALANCE_MICRO_USD)")"
"${COMPOSE[@]}" exec -T postgres bash -c "
export PGPASSWORD=\"\$(cat /run/pg-password/postgres_password.pg)\"
psql -U market -d private_market_deploy -h 127.0.0.1 -X -v ON_ERROR_STOP=1 \
  -c \"UPDATE credit_accounts SET balance_micro_usd = ${LAB_BALANCE}\"
"
sleep 2

# Positive control: plant one sentinel in a scratch log and require detection.
PROBE_SENTINEL="$PROMPT"
"${COMPOSE[@]}" exec -T market bash -c "printf '%s\n' '$PROBE_SENTINEL' > /tmp/no-leak-probe.log"
"${COMPOSE[@]}" exec -T market cat /tmp/no-leak-probe.log >"$WORK/probe.log"
python3 "$SCRIPTS/market_no_leak.py" positive-control \
  --sentinel "$PROBE_SENTINEL" --probe-file "$WORK/probe.log"
"${COMPOSE[@]}" exec -T market rm -f /tmp/no-leak-probe.log

: >"$WORK/findings.json"
echo '[]' >"$WORK/findings.json"
SURFACES=0
bump_surface() { SURFACES=$((SURFACES + 1)); }

# Node helper container
NODE_IMAGE="node:20-bookworm"
docker rm -f market-no-leak-node >/dev/null 2>&1 || true
pcid="$(docker create --name market-no-leak-node --network host \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  --entrypoint sleep "$NODE_IMAGE" 7200)"
docker start "$pcid" >/dev/null
docker exec "$pcid" mkdir -p /work /clients/test
docker cp "$WORK/buyer-0.secret" "${pcid}:/work/buyer-0.secret"
docker cp "$WORK/buyer-1.secret" "${pcid}:/work/buyer-1.secret"
docker cp "$ROOT/clients/market-buyer/purchase-sign.mjs" "${pcid}:/clients/purchase-sign.mjs"
docker cp "$ROOT/clients/market-buyer/purchase-e2ee.mjs" "${pcid}:/clients/purchase-e2ee.mjs"
docker cp "$ROOT/clients/market-buyer/receipt-verify.mjs" "${pcid}:/clients/receipt-verify.mjs"
docker cp "$ROOT/clients/market-buyer/test/no-leak-purchase.mjs" \
  "${pcid}:/clients/test/no-leak-purchase.mjs"

ATTEST_NONCE="$(python3 -c 'print("11"*32)')"
REPORT="$(host_curl -skf --connect-timeout 5 \
  "https://127.0.0.1/market/v1/aci/attestation?nonce=${ATTEST_NONCE}")"
KEYSET_DIGEST="$(printf '%s' "$REPORT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["workload_keyset_digest"])')"
printf '%s' "$REPORT" | python3 -c \
  'import json,sys; k=json.load(sys.stdin)["attestation"]["workload_keyset"]; assert k.get("e2ee_public_keys"), k; json.dump(k, open(sys.argv[1],"w"))' \
  "$WORK/verified-keyset.json"

BODY_JSON="$(python3 -c "
import json
print(json.dumps({
  'model': 'm/external',
  'messages': [{'role': 'user', 'content': '''$PROMPT'''}],
  'max_completion_tokens': 64,
  'stream': True,
  'background': True,
  'stream_options': {'include_usage': True},
  'bitrouter_purchase': {
    'service_type': 'on_demand',
    'provider_cap_micro_usd': int('$PROVIDER_CAP'),
    'total_cap_micro_usd': int('$TOTAL_CAP'),
  },
  'bitrouter_delivery': {'auto_fallback': 'off'},
}))
")"

: >"$WORK/http.jsonl"
cat >"$WORK/purchase.json" <<EOF
{
  "marketUrl": "https://127.0.0.1",
  "token": "$TOKEN0",
  "keyset": "$KEYSET_DIGEST",
  "verifiedKeyset": $(cat "$WORK/verified-keyset.json"),
  "signingKeyFile": "/work/buyer-0.secret",
  "idempotencyKey": "$IDEMPOTENCY",
  "body": $BODY_JSON,
  "httpLogFile": "/work/http.jsonl",
  "captureOut": "/work/capture.json"
}
EOF
docker cp "$WORK/purchase.json" "${pcid}:/work/purchase.json"
docker exec "$pcid" sh -c ': > /work/http.jsonl'

run_scenario() {
  local scenario="$1"
  local cfg="${2:-/work/purchase.json}"
  docker exec -e NODE_TLS_REJECT_UNAUTHORIZED=0 -w /clients "$pcid" \
    node /clients/test/no-leak-purchase.mjs "$cfg" "$scenario"
}

# --- Success path ---
run_scenario ok >/dev/null
docker cp "${pcid}:/work/capture.json" "$WORK/capture.json"
SIG="$(python3 -c "import json;print(json.load(open('$WORK/capture.json'))['buyer']['x-buyer-signature'])")"
NONCE="$(python3 -c "import json;print(json.load(open('$WORK/capture.json'))['buyer']['x-buyer-nonce'])")"
python3 -c "
import json
p='$WORK/sentinels.json'
d=json.load(open(p))
d['buyer_signature']='$SIG'
d['buyer_nonce']='$NONCE'
json.dump(d, open(p,'w'), indent=2)
print()
"

REQUEST_ID=""
for i in $(seq 1 60); do
  REQUEST_ID="$("${COMPOSE[@]}" exec -T postgres bash -c "
export PGPASSWORD=\"\$(cat /run/pg-password/postgres_password.pg)\"
psql -U market -d private_market_deploy -h 127.0.0.1 -X -A -t -v ON_ERROR_STOP=1 \
  -c \"SELECT coalesce((SELECT s.request_id FROM market_inference_requests s JOIN market_inference_receipts r USING(request_id,revision) WHERE s.idempotency_key='${IDEMPOTENCY}' AND r.receipt->>'settlement'='committed'),'')\"
")"
  REQUEST_ID="$(printf '%s' "$REQUEST_ID" | tr -d '[:space:]')"
  if [ -n "$REQUEST_ID" ]; then
    break
  fi
  sleep 1
done
test -n "$REQUEST_ID"

cat >"$WORK/receipt.json" <<EOF
{
  "marketUrl": "https://127.0.0.1",
  "token": "$TOKEN0",
  "requestId": "$REQUEST_ID",
  "keyset": "$KEYSET_DIGEST",
  "verifiedKeyset": $(cat "$WORK/verified-keyset.json"),
  "httpLogFile": "/work/http.jsonl"
}
EOF
docker cp "$WORK/receipt.json" "${pcid}:/work/receipt.json"
run_scenario receipt-ok /work/receipt.json >/dev/null

scan_phase() {
  local phase="$1"
  # Container logs
  for svc in init-secrets postgres redis market tls-terminator; do
    "${COMPOSE[@]}" logs --no-color "$svc" >"$WORK/logs-${phase}-${svc}.txt" 2>&1 || true
    bump_surface
    python3 "$SCRIPTS/market_no_leak.py" scan-file \
      --sentinels "$WORK/sentinels.json" --phase "$phase" --surface logs \
      --container "$svc" --path "$WORK/logs-${phase}-${svc}.txt" \
      --findings-out "$WORK/findings.json" >/dev/null
  done
  docker logs market-controlled-dstack >"$WORK/logs-${phase}-dstack.txt" 2>&1 || true
  bump_surface
  python3 "$SCRIPTS/market_no_leak.py" scan-file \
    --sentinels "$WORK/sentinels.json" --phase "$phase" --surface logs \
    --container market-controlled-dstack --path "$WORK/logs-${phase}-dstack.txt" \
    --findings-out "$WORK/findings.json" >/dev/null

  # HTTP log from node driver
  docker cp "${pcid}:/work/http.jsonl" "$WORK/http-${phase}.jsonl" || true
  if [ -f "$WORK/http-${phase}.jsonl" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      label="$(printf '%s' "$line" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("label",""))')"
      printf '%s\n' "$line" >"$WORK/http-one.json"
      bump_surface
      python3 "$SCRIPTS/market_no_leak.py" scan-file \
        --sentinels "$WORK/sentinels.json" --phase "$phase" --surface http \
        --http-label "$label" --path "$WORK/http-one.json" \
        --findings-out "$WORK/findings.json" >/dev/null
    done <"$WORK/http-${phase}.jsonl"
  fi

  # Redis DUMP-ish: all keys and values
  redis-cli -h 127.0.0.1 -p 6379 --scan >"$WORK/redis-keys-${phase}.txt" || true
  : >"$WORK/redis-${phase}.txt"
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    printf 'KEY %s\n' "$key" >>"$WORK/redis-${phase}.txt"
    redis-cli -h 127.0.0.1 -p 6379 --raw DUMP "$key" 2>/dev/null | base64 >>"$WORK/redis-${phase}.txt" || true
    redis-cli -h 127.0.0.1 -p 6379 --raw GET "$key" >>"$WORK/redis-${phase}.txt" 2>/dev/null || true
    redis-cli -h 127.0.0.1 -p 6379 --raw HGETALL "$key" >>"$WORK/redis-${phase}.txt" 2>/dev/null || true
  done <"$WORK/redis-keys-${phase}.txt"
  bump_surface
  python3 "$SCRIPTS/market_no_leak.py" scan-file \
    --sentinels "$WORK/sentinels.json" --phase "$phase" --surface redis \
    --path "$WORK/redis-${phase}.txt" --findings-out "$WORK/findings.json" >/dev/null

  # Seller capture (P3) — success phase only expected to have content
  if "${COMPOSE[@]}" exec -T market test -f /var/lib/market/state/seller-capture.jsonl; then
    "${COMPOSE[@]}" exec -T market cat /var/lib/market/state/seller-capture.jsonl \
      >"$WORK/seller-capture-${phase}.jsonl"
    bump_surface
    python3 "$SCRIPTS/market_no_leak.py" p3-capture \
      --sentinels "$WORK/sentinels.json" \
      --capture "$WORK/seller-capture-${phase}.jsonl" \
      --findings-out "$WORK/findings.json" >/dev/null
  fi

  # Files: tmp, log dirs, and each service working directory (not whole rootfs).
  for svc in market postgres redis tls-terminator; do
    "${COMPOSE[@]}" exec -T "$svc" sh -c '
set +e
dirs="/tmp /var/tmp /var/log"
case "'"$svc"'" in
  market) dirs="$dirs /var/lib/market" ;;
  postgres) dirs="$dirs /var/lib/postgresql" ;;
  redis) dirs="$dirs /data" ;;
  tls-terminator) dirs="$dirs /etc/caddy /config /data" ;;
esac
for d in $dirs; do
  [ -d "$d" ] || continue
  find "$d" -xdev -type f -print 2>/dev/null
done
' >"$WORK/filelist-${phase}-${svc}.txt" || true
    : >"$WORK/files-${phase}-${svc}.bin"
    while IFS= read -r fpath; do
      [ -n "$fpath" ] || continue
      case "$fpath" in
        /var/lib/postgresql|/var/lib/postgresql/*) continue ;;
      esac
      if [ "$svc" = "market" ]; then
        case "$fpath" in
          /var/lib/market/secrets|/var/lib/market/secrets/*) continue ;;
          /var/lib/market/state/seller-capture.jsonl) continue ;;
        esac
      fi
      "${COMPOSE[@]}" exec -T "$svc" head -c 1048576 "$fpath" 2>/dev/null >>"$WORK/files-${phase}-${svc}.bin" || true
      printf '\n' >>"$WORK/files-${phase}-${svc}.bin"
    done <"$WORK/filelist-${phase}-${svc}.txt"
    bump_surface
    python3 "$SCRIPTS/market_no_leak.py" scan-file \
      --sentinels "$WORK/sentinels.json" --phase "$phase" --surface file \
      --container "$svc" --path "$WORK/files-${phase}-${svc}.bin" \
      --findings-out "$WORK/findings.json" >/dev/null

    "${COMPOSE[@]}" exec -T "$svc" sh -c 'tr "\0" "\n" </proc/1/environ' \
      >"$WORK/environ-${phase}-${svc}.txt" 2>/dev/null || true
    bump_surface
    if [ "$svc" = "market" ]; then
      python3 "$SCRIPTS/market_no_leak.py" scan-file \
        --sentinels "$WORK/sentinels.json" --phase "$phase" --surface market_environ \
        --container market --path "$WORK/environ-${phase}-${svc}.txt" \
        --findings-out "$WORK/findings.json" >/dev/null
    else
      python3 "$SCRIPTS/market_no_leak.py" scan-file \
        --sentinels "$WORK/sentinels.json" --phase "$phase" --surface environ \
        --container "$svc" --path "$WORK/environ-${phase}-${svc}.txt" \
        --findings-out "$WORK/findings.json" >/dev/null
    fi
  done
}

# Public surfaces during success phase
run_scenario public-surfaces >/dev/null
scan_phase success

# Truncate http log so failure-phase attribution is clean
docker exec "$pcid" sh -c ': > /work/http.jsonl'

# --- Failure paths ---
# Inject capture into purchase config for replay scenarios
python3 -c "
import json
cfg=json.load(open('$WORK/purchase.json'))
cfg['capture']=json.load(open('$WORK/capture.json'))
cfg['wrongToken']='brk_'+('a'*32)+'.'+('b'*64)
json.dump(cfg, open('$WORK/purchase-fail.json','w'))
"
docker cp "$WORK/purchase-fail.json" "${pcid}:/work/purchase-fail.json"

run_scenario bad-signature /work/purchase-fail.json >/dev/null
run_scenario tampered-ciphertext /work/purchase-fail.json >/dev/null
run_scenario replay-buyer-nonce /work/purchase-fail.json >/dev/null
run_scenario replay-e2ee-nonce /work/purchase-fail.json >/dev/null
run_scenario plaintext-caps /work/purchase-fail.json >/dev/null
run_scenario wrong-bearer /work/purchase-fail.json >/dev/null

cat >"$WORK/buyer2.json" <<EOF
{
  "marketUrl": "https://127.0.0.1",
  "token": "$TOKEN1",
  "requestId": "$REQUEST_ID",
  "keyset": "$KEYSET_DIGEST",
  "verifiedKeyset": $(cat "$WORK/verified-keyset.json"),
  "httpLogFile": "/work/http.jsonl",
  "signingKeyFile": "/work/buyer-1.secret",
  "idempotencyKey": "buyer2-unused",
  "body": $BODY_JSON
}
EOF
docker cp "$WORK/buyer2.json" "${pcid}:/work/buyer2.json"
run_scenario buyer2-status /work/buyer2.json >/dev/null
run_scenario buyer2-receipt /work/buyer2.json >/dev/null

scan_phase failure

# Encoding count for summary (representative)
ENCODINGS="$(python3 -c "
import json,sys
sys.path.insert(0,'$SCRIPTS')
from market_no_leak import encodings_for, SENTINEL_NAMES
s=json.load(open('$WORK/sentinels.json'))
# Count unique encoding names used across types
enc=set()
for n in SENTINEL_NAMES:
  v=s.get(n)
  if v is None: continue
  enc.update(encodings_for(n,v))
print(len(enc))
")"
SENTINEL_COUNT="$(python3 -c "
import json
s=json.load(open('$WORK/sentinels.json'))
print(sum(1 for k,v in s.items() if v not in (None,'')))
")"

set +e
python3 "$SCRIPTS/market_no_leak.py" summary \
  --findings "$WORK/findings.json" \
  --surfaces "$SURFACES" \
  --sentinels "$SENTINEL_COUNT" \
  --encodings "$ENCODINGS" \
  --phases success,failure
rc=$?
set -e
exit "$rc"
