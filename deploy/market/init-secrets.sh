#!/bin/bash
# Generate in-VM ownership secrets once onto the persistent volume.
# Optional local self-signed TLS material for the non-Phala acceptance path.
# No secrets are printed. Buyer tokens and Cloudflare credentials are NOT
# created here; those arrive only as Phala encrypted secrets / local .env.
set -euo pipefail
SECRETS_DIR="${PRIVATE_MARKET_SECRETS_DIR:-/var/lib/market/secrets}"
TLS_DIR="${PRIVATE_MARKET_TLS_DIR:-}"
DOMAIN="${PRIVATE_MARKET_DOMAIN:-localhost}"
MARKET_UID="${PRIVATE_MARKET_UID:-10001}"
POSTGRES_UID="${PRIVATE_MARKET_POSTGRES_UID:-999}"
umask 077
mkdir -p "${SECRETS_DIR}"
if ! command -v openssl >/dev/null 2>&1; then
  apt-get update >/dev/null
  apt-get install -y --no-install-recommends openssl ca-certificates >/dev/null
fi
rand_hex() { openssl rand -hex 32; }
for name in bootstrap_binding cutover_token seller_key postgres_password; do
  path="${SECRETS_DIR}/${name}"
  if [ ! -f "${path}" ]; then
    printf '%s' "$(rand_hex)" >"${path}"
  fi
done
# Market process (uid 10001) reads all secrets. Postgres (uid 999) only needs a
# dedicated password file copy for POSTGRES_PASSWORD_FILE.
chown -R "${MARKET_UID}:${MARKET_UID}" "${SECRETS_DIR}"
chmod 0700 "${SECRETS_DIR}"
chmod 0400 "${SECRETS_DIR}/"*
cp "${SECRETS_DIR}/postgres_password" "${SECRETS_DIR}/postgres_password.pg"
chown "${POSTGRES_UID}:${POSTGRES_UID}" "${SECRETS_DIR}/postgres_password.pg"
chmod 0400 "${SECRETS_DIR}/postgres_password.pg"

if [ -n "${TLS_DIR}" ]; then
  mkdir -p "${TLS_DIR}"
  if [ ! -f "${TLS_DIR}/leaf.pem" ] || [ ! -f "${TLS_DIR}/leaf.key" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "${TLS_DIR}/leaf.key" -out "${TLS_DIR}/leaf.pem" -days 1 \
      -subj "/CN=${DOMAIN}" \
      -addext "subjectAltName=DNS:${DOMAIN},IP:127.0.0.1" >/dev/null 2>&1
  fi
  chown -R "${MARKET_UID}:${MARKET_UID}" "${TLS_DIR}"
  chmod 0400 "${TLS_DIR}/leaf.key" "${TLS_DIR}/leaf.pem"
fi
