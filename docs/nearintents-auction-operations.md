# NEAR Intents auction profile operations

This profile uses the existing Market auction and playground with ordinary
Arbitrum agent wallets. It requires a **fresh, dedicated** PG database and
persistent private volume. Do not point it at funded native-auction state or
erase original state to make a failed startup pass. The native profile remains
the default.

## Local acceptance

Use Node 24+, PostgreSQL/Redis tools and the repository's existing owning P2
binary. Install dependencies in `services/mpp-near-direct`,
`services/mpp-nearintents`, `services/inference-comparison`,
`clients/buyer-gateway` and `clients/market-playground`. Build the UI with
`npm run build --prefix clients/market-playground`. From the repository root:

```sh
node --test services/mpp-nearintents/auction/test/*.test.mjs
python3 scripts/accept-nearintents-auction.py PATH_TO_PRIVATE_MARKET_HOST_P2 \
  --evidence /tmp/nearintents-auction.json
python3 scripts/accept-nearintents-auction.py PATH_TO_PRIVATE_MARKET_HOST_P2 --serve
```

The Python helper creates and owns isolated PG/Redis instances, initializes the
original auction schema, and invokes the Rust schema verifier before/after
tests. `--serve` exposes the controlled playground at `http://127.0.0.1:4518`.
Its owner auth, source funding RPC and model responses are fixtures; an injected
EIP-1193 wallet fixture is needed for automated browser funding. This helper
cannot be used to enable real broadcasts. There is no external provider cost.

## Offline live-plan preparation

Copy [the example parameters](examples/nearintents-auction-parameters.json).
All rates, service identity, merchant, origin, RPC, duration and spending caps
require review. Example rates are **illustrative**, not current Cloud prices or
an approved spend allowance. The example's `.invalid` hosts cannot run a live
service. Refresh the Cloud catalog and verify quote minimums before selecting
real request bundles.

```sh
node scripts/prepare-nearintents-auction.mjs PRIVATE_NEW_DIRECTORY PARAMETERS_JSON
```

This offline command freezes the service and deadline, calculates the reviewed
plan fingerprint, and creates private storage/market keys. It creates no funded
agent or merchant and performs no HTTP request. Supply an existing reviewed
merchant account; automatic merchant refunds are not enabled by this profile.
Keep generated files outside git.

The runtime JSON merges `review-plan.json` with these fields (the paths below
are in-container):

```json
{
  "paymentMethod": "nearintents",
  "dataDirectory": "/data/nearintents-v1",
  "owningStateDirectory": "/data/nearintents-v1/owning-market",
  "databaseUrlFile": "/data/nearintents-v1/database-url",
  "storageKeyFile": "/data/nearintents-v1/storage-key",
  "marketSecretFile": "/data/nearintents-v1/market-secret",
  "nearAiKeyFile": "/data/nearintents-v1/near-ai-key",
  "port": 3000,
  "backendPort": 4180
}
```

`plan` and `reviewedPlanHash` remain the exact offline output. Optional
`oneClickJwtFile` must also be in that directory. The sealed private object has
`storageKey` (32-byte hex), `marketSecret`, `nearAiKey`, and optional `oneClickJwt`.
There is no `merchantKey` in this runtime. Provider key probing can incur one
bounded paid inference and is part of the explicitly reviewed allowance.

## In-image startup

Both the full `Dockerfile --target mainnet` and the existing
`Dockerfile.mainnet-runtime` overlay package this profile. The latter reuses a
reviewed owning Rust binary only when Rust/schema inputs are unchanged.
No Phala pre-launch script is used. Set:

```text
AUCTION_PAYMENT_PROFILE=nearintents
NEARINTENTS_AUCTION_CONFIG_JSON=<public runtime JSON>
NEARINTENTS_AUCTION_PRIVATE_JSON=<sealed private JSON>
ENABLE_NEARINTENTS_AUCTION=<exact reviewedPlanHash>
```

The deployed page and wallets can start without buying a Cloud probe. Until
the operator also sets `ENABLE_NEARINTENTS_PAID_PROBE` to the same exact plan
hash, supply stays unavailable and no paid readiness probe is started. Enable
that flag only within the approved provider allowance. The probe consumes one
of the immutable provider call slots; restarting never grants another allowance.

The bootstrap uses database `private_market_auction_nearintents_v1`; the native
database name is unchanged. The original Rust schema layout still uses
`PRIVATE_MARKET_AUCTION=bounded-mainnet-v1`; the JS payment profile separately
requires its own hash gate, schema/instance binding and exclusive runtime lease.
The overlay renderer now selects a distinct Intents service, volume, network and
sealed name from `paymentMethod: nearintents`. Its default leaves the paid probe
off; `--enable-paid-probe` explicitly enables it. It refuses an occupied canary
port and preserves the existing services, volumes and settings. All existing
sealed values must be preserved when supplying the combined environment file.
The publisher verifies both native bootstrap and Intents fresh-volume/restart
bootstrap for an artifact carrying `paymentMethod: nearintents`. The renderer
alone does not deploy or push an image.

Live preflight on 2026-11-15 found that the original 1× request ($0.001993 at
that tariff) was below 1Click's then-current bridge minimum (about $0.00529).
The user selected a finite 3× / 3.2× bid canary while preserving the original
pricing formula. Dry quotes were about 0.006042 / 0.006444 USDC with a 27-second
settlement estimate. These observations are not a standing quote or measured
latency. Default 1× orders are not accepted as a working live path; recheck exact
amounts before funding. No minimum-price surcharge is silently added.

The UI declares the active profile explicitly. Owner NEAR login must be on
Mainnet; funding is USDC and ETH on Arbitrum. Successful fixed bundles have no
usage rebates. Full merchant-asset refund liabilities for failed paid delivery
remain unresolved until operator reconciliation; they block new sales. Unspent
source-token exits are available after agent freeze and have separate exit-gas
limits. Never remove the journal to retry an Unknown operation.

Real acceptance still needs approved aggregate source/provider spending,
executable quotes for the exact winning amounts, funded agent gas, actual
source/destination evidence, attested Cloud task completion, replay checks and
observed cross-chain latency. No such funds are spent by local acceptance.
