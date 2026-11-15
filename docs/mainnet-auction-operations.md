# Bounded Mainnet candidate operations

This entry is separate from the deployed P2 playground. No live spend or deployment
is implied by a successful build or controlled acceptance.

Build the owning schema and run controlled acceptance:

```sh
python3 scripts/materialize-market-p2.py
cargo build --locked --manifest-path crates/private-market-p2/Cargo.toml --bin private-market-host-p2
python3 scripts/accept-single-seller-auction.py target/debug/private-market-host-p2 --evidence /tmp/mainnet-auction-pg.json
```

Generate a dedicated, **unfunded** merchant offline with
`scripts/prepare-mainnet-auction.mjs PRIVATE_NEW_DIRECTORY PARAMETERS_JSON`.
The parameters must supply the reviewed Mainnet origin/realm, `rpcUrl`, `fxSource`,
owner/agent/call caps, native principal/gas/storage/funding bounds, provider cost
allowance, maximum payment/provider calls (at most 32), maximum agents (at most 8),
`durationMs` (at most one day), and a `service` accepted by `freezeClass`. Service
prices must come from the current Cloud catalog. This command writes private
merchant/storage/market keys and a public plan hash; it makes no RPC or transfer.
Keep these files outside git. A plan generated for review can expire before use;
review the final exact deadline/hash before enabling it.

The runtime JSON contains `plan`, `reviewedPlanHash`, `rpcUrl` equal to the plan's
RPC, `dataDirectory: /data/mainnet-v1`, `owningStateDirectory:
/data/mainnet-v1/owning-market`, and paths under that directory for `databaseUrlFile`
(`database-url`), `merchantKeyFile`, `storageKeyFile`, `marketSecretFile`,
`nearAiKeyFile` and `fxFile`. Optional `fxObservation` has `kind:
market-usd-near-v1`, the plan's exact HTTPS `source`, positive integer
`nanoUsdPerNear`, `observedAtMs` and `expiresAtMs` no more than five minutes apart.
The runtime rereads `fxFile` every 15 seconds; stale/missing FX stops new quotes.
It does not prevent original recovery or refund.

For a Phala launch, pass public runtime JSON through
`MAINNET_AUCTION_CONFIG_JSON`. Pass one additional **sealed**
`MAINNET_AUCTION_PRIVATE_JSON` object with `merchantKey`, `storageKey` (32 bytes hex),
`marketSecret` and `nearAiKey`. The bootstrap writes private files inside the new
volume and refuses secret/plan substitution on restart. It starts loopback PG18
and Redis, initializes a fresh owning schema, and invokes the owning Rust schema
fingerprint verifier before the Node worker. There is no pre-launch script.

Build the current sources:

```sh
bash scripts/prepare-market-docker-cargo.sh
docker build --platform linux/amd64 --target mainnet \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -f deploy/agent-preview/Dockerfile -t PRIVATE_MAINNET_REVIEW_IMAGE .
```

The untargeted Dockerfile still selects the P2 preview entry. The separate
`mainnet` target packages current Rust, UI, shared browser client and Cloud SDK.
Do not relabel the historical P2 release archive as this build.

`prepare-mainnet-auction-overlay.py BEFORE_MANIFEST IMMUTABLE_GHCR_IMAGE
PUBLIC_RUNTIME_JSON OUTPUT --report REPORT` renders an additive service on port
3001 and a new `mainnet-auction-data` volume. It preserves every existing service,
volume, manifest setting and sealed environment name, and adds only one sealed
name. It rejects a pre-launch script, ephemeral storage, an existing Mainnet
service that needs inspection, mutable image tags and secrets in public config.
The renderer does not modify a CVM or upload secrets. Re-read the live manifest
before applying; reject concurrent changes. Preserve all existing sealed values
when adding the Mainnet envelope. Do not use a CLI flag that replaces the whole
environment set with only the new value.

Release acceptance still requires a reviewed funding amount, valid Cloud key,
merchant refund readiness, owner policy/funding in a real wallet, real tool/task
completion, FINAL principal/gas/refund evidence and zero extra effects on replay.
Owner exit requires a separately installed owner-only policy after original liabilities finalize; it leaves the storage/gas floor. A missing API ACK or the SDK pre-verification crash window can remain Unknown; review these limits before any public judge release.
