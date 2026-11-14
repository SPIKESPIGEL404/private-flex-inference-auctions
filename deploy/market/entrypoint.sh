#!/bin/bash
# First-boot Market entrypoint. Uses in-VM ownership secrets from the shared
# secrets volume, runs init once, waits for the TLS leaf the terminator will
# serve, then serves on loopback. Never prints tokens, passwords, caps, or
# signing material.
set -euo pipefail

STATE_ROOT="${PRIVATE_MARKET_STATE_ROOT:-/var/lib/market/state}"
SECRETS_DIR="${PRIVATE_MARKET_SECRETS_DIR:-/var/lib/market/secrets}"
TLS_DIR="${PRIVATE_MARKET_TLS_DIR:-/run/market-tls}"
LISTEN="${PRIVATE_MARKET_LISTEN:-127.0.0.1:8080}"
DOMAIN="${PRIVATE_MARKET_DOMAIN:-localhost}"
BUYERS_PUBLIC="${PRIVATE_MARKET_BUYERS_PUBLIC:-/etc/market/buyers.public.json}"
ATTESTATION_CONFIG_PATH="${PRIVATE_MARKET_ATTESTATION_PATH:-/var/lib/market/attestation.json}"
MODE="${PRIVATE_MARKET_MODE:-controlled}"
DB_NAME="${PRIVATE_MARKET_DB_NAME:-private_market_deploy}"

umask 077
# init creates STATE_ROOT itself and refuses a pre-existing directory.
mkdir -p "$(dirname "${STATE_ROOT}")" "${TLS_DIR}"

for required in bootstrap_binding cutover_token seller_key postgres_password; do
  if [ ! -f "${SECRETS_DIR}/${required}" ]; then
    echo "missing in-VM secret material" >&2
    exit 1
  fi
done

BOOTSTRAP="$(cat "${SECRETS_DIR}/bootstrap_binding")"
CUTOVER="$(cat "${SECRETS_DIR}/cutover_token")"
SELLER="$(cat "${SECRETS_DIR}/seller_key")"
PGPASSWORD="$(cat "${SECRETS_DIR}/postgres_password")"
export BITROUTER_PREVIEW_BOOTSTRAP_BINDING="${BOOTSTRAP}"
export REDIS_BALANCE_CUTOVER_TOKEN="${CUTOVER}"
export PRIVATE_MARKET_SELLER_KEY="${SELLER}"
export DATABASE_URL="postgres://market:${PGPASSWORD}@127.0.0.1:5432/${DB_NAME}"
export REDIS_URL="redis://127.0.0.1:6379"
export PRIVATE_MARKET_LISTEN="${LISTEN}"
export INFERENCE_MARKET_CONFIG_PATH="${STATE_ROOT}/catalog.json"
export DATABASE_MIN_CONNECTIONS="${DATABASE_MIN_CONNECTIONS:-1}"
export DATABASE_MAX_CONNECTIONS="${DATABASE_MAX_CONNECTIONS:-12}"

wait_tcp() {
  local host="$1" port="$2" name="$3"
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    # Avoid writing bytes that confuse Postgres' startup packet parser.
    if timeout 1 bash -c "exec 3<>/dev/tcp/${host}/${port}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "${name} not reachable on ${host}:${port}" >&2
  exit 1
}

wait_tcp 127.0.0.1 5432 postgres
wait_tcp 127.0.0.1 6379 redis

if [ ! -f "${STATE_ROOT}/state.json" ]; then
  if [ ! -f "${BUYERS_PUBLIC}" ]; then
    echo "deploy buyers public config missing" >&2
    exit 1
  fi
  for required in PRIVATE_MARKET_BUYER_TOKEN_0 PRIVATE_MARKET_BUYER_TOKEN_1 PRIVATE_MARKET_BUYER_TOKEN_2; do
    if [ -z "${!required:-}" ]; then
      echo "missing encrypted buyer token" >&2
      exit 1
    fi
  done
  /usr/local/bin/private-market-host init-deploy "${STATE_ROOT}" "${BUYERS_PUBLIC}"
fi

if [ "${MODE}" = "local" ]; then
  LEAF="${TLS_DIR}/leaf.pem"
else
  # Production tls-alpn-01: lego writes the real leaf+chain at
  # /etc/letsencrypt/lego/certificates/<domain>.crt (dstack-ingress tlsalpn.sh /
  # legoman.py). The HAProxy placeholder under /etc/haproxy/certs/ is NOT the
  # attested leaf — never point attestation at it.
  LEAF="${PRIVATE_MARKET_TLS_CERT:-/etc/letsencrypt/lego/certificates/${DOMAIN}.crt}"
fi
# DNS_SETUP_MODE=wait can block issuance for DNS_SETUP_TIMEOUT (default 1800s).
deadline=$((SECONDS + 2100))
while [ ! -f "${LEAF}" ]; do
  if (( SECONDS >= deadline )); then
    echo "TLS leaf not available before Market start" >&2
    exit 1
  fi
  sleep 1
done
# Refuse a zero-length or non-cert file so we never seal a placeholder path.
if ! grep -q "BEGIN CERTIFICATE" "${LEAF}"; then
  echo "TLS leaf file is not a PEM certificate" >&2
  exit 1
fi

if [ "${PRIVATE_MARKET_ENABLE_ATTESTATION:-0}" = "1" ]; then
  # Local controlled acceptance may mount a pre-written config (e.g. dstack_http).
  if [ ! -f "${ATTESTATION_CONFIG_PATH}" ]; then
    cat >"${ATTESTATION_CONFIG_PATH}" <<EOF
{
  "dstack_socket": "/var/run/dstack.sock",
  "tls_certificate": "${LEAF}",
  "public_domain": "${DOMAIN}",
  "keyset_lifetime_seconds": 3600
}
EOF
    chmod 0600 "${ATTESTATION_CONFIG_PATH}"
  fi
  export PRIVATE_MARKET_ATTESTATION_CONFIG="${ATTESTATION_CONFIG_PATH}"
else
  unset PRIVATE_MARKET_ATTESTATION_CONFIG || true
fi

exec /usr/local/bin/private-market-host serve "${STATE_ROOT}"
