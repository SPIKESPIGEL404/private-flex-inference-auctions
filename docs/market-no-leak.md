# Market no-leak sentinel test (P2 / P3)

Sibling acceptance: `bash scripts/accept-market-no-leak.sh`.

Runs on the **local dstack stack** (same compose overlay as
`accept-market-dstack-local.sh`). It plants distinctive sentinels, exercises one
successful encrypted signed purchase plus receipt fetch and the listed failure
paths, then searches observable surfaces for those sentinels in several
encodings.

## What it covers

- Fresh sentinels: procurement caps, buyer bearer, idempotency key, buyer
  signature and nonce, a prompt marker, and the fake upstream provider API key.
- Success path on HTTPS :443, then failure paths: bad purchase signature,
  corrupted ciphertext, replayed buyer purchase nonce, replayed E2EE nonce,
  plaintext purchase with attestation on, wrong bearer.
- Buyer-two isolation: buyer one’s sentinels must not appear in status/receipt
  responses buyer two can obtain.
- Surfaces: container logs (scanned after success and again after failures),
  HTTP response bodies/headers (failures + public health/attestation), Redis
  keys/values, seller upstream capture (P3), and files under tmp / log /
  working directories (excluding carved-out paths).
- Positive control: a planted sentinel must be detected before the real scan.
- Deploy guard: rendered production `docker-compose.yml` and `allowed_envs`
  must not mention `PRIVATE_MARKET_SELLER_CAPTURE`.

## Allowed locations (explicit)

| Location | Allowed sentinels |
| --- | --- |
| Market Postgres tables | caps, idempotency (not scanned; CVM disk encryption is out of scope) |
| `/var/lib/market/secrets/` | provider key file (`seller_key`) |
| Market process environment | buyer bearer tokens, provider key |
| Seller capture file | prompt marker + provider `Authorization` only |
| Buyer one’s own success response / signed receipt | that buyer’s own fields (`idempotency_key`, caps/fees from the purchase) |

Anything else is a failure. Seller capture must also omit `bitrouter_*`, caps,
buyer bearer, buyer/E2EE headers, and the idempotency key (P3).

## Seller capture gating

`PRIVATE_MARKET_SELLER_CAPTURE` is set only in `docker-compose.local.yml`. The
host honors it **only** when attestation config uses controlled local
`dstack_http`. Production uses `dstack_socket`; if the capture env is set in
any other mode, the host refuses to start with a generic error.

## What it does not cover

- Process memory / heap dumps
- Timing or traffic-analysis side channels
- Contents of the Postgres data directory
- The operator’s view of Phala encrypted secrets on a real deployment
- Hardware attestation or the real Phala CVM path

P2 scanning is a leak check, not a substitute for attestation, key custody, or
admin boundary review (hackathon spec).
