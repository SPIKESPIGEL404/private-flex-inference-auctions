# Batch A: isolated controlled Market

This batch composes the fixed Cloud Market into an independent local executable.
The source boundary is recorded in [SOURCES.md](../crates/private-market-host/upstream/SOURCES.md).
It retains the whole Cloud library dependency while exposing only a local Market
host. The historical scheduler is not linked.

## Automated acceptance

From the repository root, with Rust 1.93+, Python 3, PostgreSQL and Redis tools:

```bash
bash scripts/accept-market-a.sh
```

The harness owns a new temporary PG cluster, a new Redis process with
`maxmemory-policy noeviction`, one new `private_market_*` database and a private
state directory. It never uses a running database or flushes an existing Redis.
Cleanup stops only these processes. PostgreSQL `initdb` requires a non-root user.
No Docker, Core executable, Cloud checkout, model credential or GPU is required.
Cargo fetches the two pinned Git repositories and registry packages.

To write a sanitized evidence summary:

```bash
bash scripts/accept-market-a.sh --evidence /tmp/market-a-evidence.json
```

The report includes fees and assertions, without buyer credentials, user IDs,
database URLs, prompts or request IDs. Each buyer begins with 25,000 microUSD of
isolated test credits. The seller's rates give 35 microUSD for the synthetic
two-input/three-output-token result. The source contract determines the platform
fee and total cash charge. Test credits are not purchased funds or chain assets.

## Host commands

The acceptance harness is the reproducible entry point. For manual runs, create
fresh loopback PostgreSQL and Redis services, and configure:

```bash
export DATABASE_URL='postgres://YOUR_USER@127.0.0.1:55432/private_market_demo'
export REDIS_URL='redis://127.0.0.1:56379'
export BITROUTER_PREVIEW_BOOTSTRAP_BINDING='your-unique-local-market'
export REDIS_BALANCE_CUTOVER_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export PRIVATE_MARKET_SELLER_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export DATABASE_MIN_CONNECTIONS=1 DATABASE_MAX_CONNECTIONS=12
mkdir -p .market-runs
state="$PWD/.market-runs/demo"
export INFERENCE_MARKET_CONFIG_PATH="$state/catalog.json"
cargo build --locked --manifest-path crates/private-market-host/Cargo.toml
host=crates/private-market-host/target/debug/private-market-host
"$host" init "$state"
"$host" serve "$state"
```

`init` requires a new state directory and empty database. It runs the source's
isolated bootstrap, installs its fixed cash schemas, seeds three test accounts
and auditable test-credit ledger entries in one transaction, and provisions three one-use Offers from one
controlled seller and one shared active execution slot. It saves state as 0600
inside a 0700 directory. A failed initialization is not automatically adopted;
create a new isolated database/Redis/state set. Existing markets cannot be topped
up by repeating `init`.

`serve` verifies that service URLs and ownership match the saved state, checks
the source schema/cache gates, opens the fenced writer, then starts a loopback
test identity authority, synthetic tokenizer, controlled native seller and
Market HTTP listener. `PRIVATE_MARKET_LISTEN` optionally fixes the loopback
address; the default chooses an available port and prints its URL. SIGINT drains
owned workers and releases the writer session. Unexpected worker exits stop the
host. Startup verifies existing schema; it does not migrate or replenish funds.

The test authority uses random full opaque bearer credentials and Cloud's
actual `RemoteIntrospectionResolver` with a fixed source realm. Request bodies
cannot select the authenticated user. This local credential authority is solely
for the controlled demo; no production credential issuer is configured.

The only qualified product is Chat Completions SSE, On-demand, model
`m/external`, native seller model `native-a`, output limit 64. The source router
retains other native paths, but no products qualify for those protocols.
Offers and qualification evidence expire thirty minutes after initialization.
Start a fresh isolated run after expiry; do not edit persisted financial state.

## Request and receipt

The harness uses an authenticated POST to `/market/v1/chat/completions` with
`Idempotency-Key` and this public body:

```json
{
  "model": "m/external",
  "messages": [{"role": "user", "content": "Batch A public synthetic prompt"}],
  "max_completion_tokens": 64,
  "stream": true,
  "stream_options": {"include_usage": true},
  "background": true,
  "bitrouter_purchase": {
    "service_type": "on_demand",
    "provider_cap_micro_usd": 4500,
    "total_cap_micro_usd": 4510
  },
  "bitrouter_delivery": {"auto_fallback": "off"}
}
```

The tokenizer only accepts this fixture prompt and returns IDs `[42,43]`.
The seller emits `verified`, original finish reason, usage and `[DONE]`.
It rejects leaked Market controls, unexpected model/limits and incorrect seller
credentials. These are controlled HTTP calls through the real native SDK,
coordinator, PostgreSQL transactions and cash/Redis authority.

Owners can GET `/market/v1/requests/{request_id}` for delivery, settlement and
fee status, and GET the `/events` suffix to replay original persisted output.
Other buyers receive 404, including for cancellation. The acceptance harness
uses direct database reads only as an independent operator-side oracle; it does
not expose such reads through the buyer API.

## Acceptance boundary

Batch A establishes controlled native execution and a test financial loop. The
complete source regression suite, concurrent cap checks, Unknown/restart/fault
injection and lost-commit recovery remain batch B. Real model/tokenizer/seller
authorization is batch C; TEE, encrypted storage, attested channels and snapshot
freshness are batch D. Local HTTP and test-authority behavior do not establish
privacy against infrastructure operators. No auto-bidder or NEAR integration is
included in this batch.
