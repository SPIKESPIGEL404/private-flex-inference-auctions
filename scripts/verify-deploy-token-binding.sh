#!/usr/bin/env bash
# Verify Task 5 deploy token binding: empty-state tokens, bearer 401s, restart.
# Assumes the local dstack stack is already up (accept-market-dstack-local path).
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$PWD"
DEPLOY="$ROOT/deploy/market"
WORK="${1:?usage: verify-deploy-token-binding.sh WORK_DIR}"
ENV_FILE="$WORK/local.env"
test -f "$ENV_FILE"
test -f "$WORK/tokens.json"
test -f "$WORK/buyer-0.secret"

if command -v docker.exe >/dev/null 2>&1; then
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    docker() { docker.exe "$@"; }
  fi
fi

COMPOSE=(docker compose --project-directory "$DEPLOY"
  -f "$DEPLOY/docker-compose.yml" -f "$DEPLOY/docker-compose.local.yml"
  --env-file "$ENV_FILE")
CURL_IMAGE="curlimages/curl@sha256:08e466006f0860e54fc299378de998935333e0e130a15f6f98482e9f8dab3058"
NODE_IMAGE="node:20-bookworm"
DEBIAN_IMAGE="debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc"

host_curl() { docker run --rm --network host "$CURL_IMAGE" "$@"; }

TOKEN0="$(python3 -c "import json; print(json.load(open('$WORK/tokens.json'))[0])")"

# --- Point 2 prelude: state.json must have empty token fields ---
"${COMPOSE[@]}" exec -T market cat /var/lib/market/state/state.json >"$WORK/state.before.json"
python3 -c "
import json
buyers=json.load(open('$WORK/state.before.json'))['buyers']
tokens=[b.get('token','') for b in buyers]
assert tokens==['','',''], tokens
print('state_tokens_empty: pass')
"

# --- Point 3: golden catalog bytes + policy digest ---
COMMITTED="$(python3 -c 'import hashlib,pathlib; print("sha256:"+hashlib.sha256(pathlib.Path("deploy/market/catalog.json").read_bytes()).hexdigest())')"
LIVE="$("${COMPOSE[@]}" exec -T market sha256sum /var/lib/market/state/catalog.json | awk '{print "sha256:"$1}')"
GOLDEN="$("${COMPOSE[@]}" exec -T market sha256sum /etc/market/catalog.json | awk '{print "sha256:"$1}')"
HEALTH="$(host_curl -skf --connect-timeout 5 https://127.0.0.1/healthz)"
HEALTH_DIGEST="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['catalog_policy_digest'])" "$HEALTH")"
test "$COMMITTED" = "$LIVE"
test "$COMMITTED" = "$GOLDEN"
test "$COMMITTED" = "$HEALTH_DIGEST"
echo "{\"catalog_policy_digest\":\"$COMMITTED\",\"golden_unchanged\":true,\"live_matches_golden\":true}"

# Fetch attestation for signed purchase helpers
ATTEST_NONCE="$(python3 -c 'print("11"*32)')"
REPORT="$(host_curl -skf --connect-timeout 5 \
  "https://127.0.0.1/market/v1/aci/attestation?nonce=${ATTEST_NONCE}")"
KEYSET_DIGEST="$(printf '%s' "$REPORT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["workload_keyset_digest"])')"
printf '%s' "$REPORT" | python3 -c \
  'import json,sys; k=json.load(sys.stdin)["attestation"]["workload_keyset"]; json.dump(k, open(sys.argv[1],"w"))' \
  "$WORK/verified-keyset.json"

BODY='{"model":"m/external","messages":[{"role":"user","content":"Batch A public synthetic prompt"}],"max_completion_tokens":64,"stream":true,"background":true,"stream_options":{"include_usage":true},"bitrouter_purchase":{"service_type":"on_demand","provider_cap_micro_usd":4500,"total_cap_micro_usd":4510},"bitrouter_delivery":{"auto_fallback":"off"}}'

# Node helper for signed requests with controllable Authorization
pcid="$(docker create --network host -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  --entrypoint sleep "$NODE_IMAGE" 1800)"
docker start "$pcid" >/dev/null
docker exec "$pcid" mkdir -p /work /clients
docker cp "$WORK/buyer-0.secret" "${pcid}:/work/buyer-0.secret"
docker cp "$WORK/verified-keyset.json" "${pcid}:/work/verified-keyset.json"
docker cp "$ROOT/clients/market-buyer/purchase-sign.mjs" "${pcid}:/clients/purchase-sign.mjs"
docker cp "$ROOT/clients/market-buyer/purchase-e2ee.mjs" "${pcid}:/clients/purchase-e2ee.mjs"

cat >"$WORK/auth-cases.mjs" <<'JS'
import { readFile } from 'node:fs/promises';
import { freshNonce, readSigningKey, signPurchase } from './purchase-sign.mjs';
import { sealPurchaseRequest } from './purchase-e2ee.mjs';

const cfg = JSON.parse(await readFile('/work/auth-config.json', 'utf8'));
const signing = await readSigningKey(cfg.signingKeyFile);
const sealed = sealPurchaseRequest(cfg.body, cfg.verifiedKeyset);
const signed = signPurchase({
  seed: signing.seed,
  publicKey: signing.publicKey,
  body: sealed.body,
  idempotencyKey: cfg.idempotencyKey,
  keyset: cfg.keyset,
  nonce: freshNonce(),
  ts: Math.floor(Date.now() / 1000),
});
const url = cfg.marketUrl + '/market/v1/chat/completions';
const cases = [
  { name: 'no-authorization', headers: { ...signed.headers, ...sealed.headers,
    'content-type': 'application/json', 'idempotency-key': cfg.idempotencyKey } },
  { name: 'bearer-empty', headers: { ...signed.headers, ...sealed.headers,
    'content-type': 'application/json', 'idempotency-key': cfg.idempotencyKey,
    authorization: 'Bearer ' } },
  { name: 'bearer-spaces', headers: { ...signed.headers, ...sealed.headers,
    'content-type': 'application/json', 'idempotency-key': cfg.idempotencyKey,
    authorization: 'Bearer    ' } },
  { name: 'bearer-only', headers: { ...signed.headers, ...sealed.headers,
    'content-type': 'application/json', 'idempotency-key': cfg.idempotencyKey,
    authorization: 'Bearer' } },
];
const results = [];
for (const c of cases) {
  const response = await fetch(url, { method: 'POST', redirect: 'error',
    headers: c.headers, body: sealed.body });
  const text = await response.text();
  results.push({ name: c.name, status: response.status, text });
}
// Valid token control — fresh signature (idempotency key is in the signed statement).
const okIdem = cfg.idempotencyKey + '-ok';
const okSealed = sealPurchaseRequest(cfg.body, cfg.verifiedKeyset);
const okSigned = signPurchase({
  seed: signing.seed,
  publicKey: signing.publicKey,
  body: okSealed.body,
  idempotencyKey: okIdem,
  keyset: cfg.keyset,
  nonce: freshNonce(),
  ts: Math.floor(Date.now() / 1000),
});
const ok = await fetch(url, { method: 'POST', redirect: 'error',
  headers: {
    ...okSigned.headers, ...okSealed.headers,
    'content-type': 'application/json',
    'idempotency-key': okIdem,
    authorization: 'Bearer ' + cfg.token,
  },
  body: okSealed.body });
results.push({ name: 'valid-bearer', status: ok.status, text: (await ok.text()).slice(0, 80) });
console.log(JSON.stringify(results));
JS

cat >"$WORK/auth-config.json" <<EOF
{
  "marketUrl": "https://127.0.0.1",
  "token": "$TOKEN0",
  "keyset": "$KEYSET_DIGEST",
  "verifiedKeyset": $(cat "$WORK/verified-keyset.json"),
  "signingKeyFile": "/work/buyer-0.secret",
  "idempotencyKey": "verify-token-bind-1",
  "body": $BODY
}
EOF
docker cp "$WORK/auth-cases.mjs" "${pcid}:/clients/auth-cases.mjs"
docker cp "$WORK/auth-config.json" "${pcid}:/work/auth-config.json"
AUTH_JSON="$(docker exec -e NODE_TLS_REJECT_UNAUTHORIZED=0 -w /clients "$pcid" \
  node /clients/auth-cases.mjs)"
python3 -c "
import json,sys
rows=json.loads(sys.argv[1])
by={r['name']:r for r in rows}
for name in ['no-authorization','bearer-empty','bearer-spaces','bearer-only']:
  r=by[name]
  assert r['status']==401, (name,r)
  assert r['text']=='purchase_signature_invalid', (name,r)
assert by['valid-bearer']['status']==200, by['valid-bearer']
print('bearer_401_cases: pass')
print('valid_bearer_before_restart: pass')
" "$AUTH_JSON"

# --- Point 2: restart market; token still works; state still empty ---
"${COMPOSE[@]}" restart market
ok=0
for i in $(seq 1 60); do
  if host_curl -skf --connect-timeout 2 https://127.0.0.1/healthz >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
test "$ok" = 1

state_tokens2="$("${COMPOSE[@]}" exec -T market cat /var/lib/market/state/state.json \
  | python3 -c 'import json,sys; s=json.load(sys.stdin); print(json.dumps([b.get("token","") for b in s["buyers"]]))')"
python3 -c "
import json,sys
tokens=json.loads(sys.argv[1])
assert tokens==['','',''], tokens
print('state_tokens_empty_after_restart: pass')
" "$state_tokens2"

# Re-fetch keyset (may rotate on restart) and buy again
REPORT2="$(host_curl -skf --connect-timeout 5 \
  "https://127.0.0.1/market/v1/aci/attestation?nonce=${ATTEST_NONCE}")"
KEYSET2="$(printf '%s' "$REPORT2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["workload_keyset_digest"])')"
printf '%s' "$REPORT2" | python3 -c \
  'import json,sys; k=json.load(sys.stdin)["attestation"]["workload_keyset"]; json.dump(k, open(sys.argv[1],"w"))' \
  "$WORK/verified-keyset.json"
python3 -c "
import json
cfg=json.load(open('$WORK/auth-config.json'))
cfg['keyset']='''$KEYSET2'''
cfg['verifiedKeyset']=json.load(open('$WORK/verified-keyset.json'))
cfg['idempotencyKey']='verify-token-bind-restart'
json.dump(cfg, open('$WORK/auth-config.json','w'))
"
docker cp "$WORK/auth-config.json" "${pcid}:/work/auth-config.json"
docker cp "$WORK/verified-keyset.json" "${pcid}:/work/verified-keyset.json"
AUTH2="$(docker exec -e NODE_TLS_REJECT_UNAUTHORIZED=0 -w /clients "$pcid" \
  node /clients/auth-cases.mjs)"
python3 -c "
import json,sys
rows=json.loads(sys.argv[1])
by={r['name']:r for r in rows}
assert by['valid-bearer']['status']==200, by['valid-bearer']
for name in ['no-authorization','bearer-empty','bearer-spaces','bearer-only']:
  assert by[name]['status']==401, (name, by[name])
print('valid_bearer_after_restart: pass')
print('bearer_401_after_restart: pass')
" "$AUTH2"

docker rm -f "$pcid" >/dev/null

# --- Empty buyer token env must refuse serve (fail closed) ---
"${COMPOSE[@]}" stop market >/dev/null
# Start market with TOKEN_0 cleared via override env file
python3 -c "
from pathlib import Path
src=Path('$ENV_FILE').read_text().splitlines()
out=[]
for line in src:
  if line.startswith('BUYER_0_TOKEN='):
    out.append('BUYER_0_TOKEN=')
  else:
    out.append(line)
Path('$WORK/local.empty0.env').write_text('\\n'.join(out)+'\\n')
"
COMPOSE_EMPTY=(docker compose --project-directory "$DEPLOY"
  -f "$DEPLOY/docker-compose.yml" -f "$DEPLOY/docker-compose.local.yml"
  --env-file "$WORK/local.empty0.env")
set +e
"${COMPOSE_EMPTY[@]}" up -d market >/dev/null 2>&1
# Market should crash-loop / exit; healthz must stay down for the market process.
refused=0
for i in $(seq 1 20); do
  status="$("${COMPOSE_EMPTY[@]}" ps market --format '{{.Status}}' 2>/dev/null || true)"
  if echo "$status" | grep -qiE 'exit|restarting|dead'; then
    refused=1
    break
  fi
  sleep 1
done
set -e
# Restore good env and market
"${COMPOSE[@]}" up -d market >/dev/null
for i in $(seq 1 60); do
  if host_curl -skf --connect-timeout 2 https://127.0.0.1/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
test "$refused" = 1
echo 'empty_buyer_token_refuses_serve: pass'

echo '{"verify_deploy_token_binding":"pass"}'
