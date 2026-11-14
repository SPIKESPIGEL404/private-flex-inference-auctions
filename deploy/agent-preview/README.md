# Controlled agent preview on an existing CVM

This sidecar publishes P2's browser, local scripted seller/wallet, native Market,
PostgreSQL 18 (required by the current billing audit migration) and Redis. Its inference and settlement make no real provider or payment calls. Ordinary
wallet login and transfer verification use read-only mainnet RPC; no Agent API
credentials or real signing keys enter the server. The existing Chutes/NEAR gateway image, ports, mounted data,
pre-launch prefix and sealed secret names are preserved by the release overlay.

The checked-in PGDG public signing key has fingerprint
`B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8`, as published in the
[official Debian installation guide](https://www.postgresql.org/download/linux/debian/).
Prepare the pinned source and build from the repository root:

```sh
python3 scripts/materialize-market-p2.py
bash scripts/prepare-market-docker-cargo.sh
docker build --platform linux/amd64 -f deploy/agent-preview/Dockerfile -t agent-preview:local .
```

The container requires `AGENT_PREVIEW_ORIGIN` (the exact public HTTPS origin) and
`AGENT_PREVIEW_OWNER_HASH` (a 64-character compatibility binding; retain it on
upgrade, or generate a random SHA-256 for a fresh installation). It is not an
access code and is not accepted as public login. `AGENT_PREVIEW_REVISION` identifies the deployed code. Mount a new,
dedicated volume at `/data`; no existing gateway volume or dstack socket is used.
Publish only port 3000. Attach only to a new dedicated bridge network, separate
from the gateway network. This is not an egress firewall; Docker's `internal`
bridge prevents the host-published preview port from working. The application
uses only loopback model/payment fixtures. All PostgreSQL, Redis, wallet,
proxy and Market ports remain on the container's loopback interface. Set a memory limit, CPU limit,
read-only root filesystem, `/tmp` tmpfs and `no-new-privileges`.

The public-origin guard rejects cross-origin browser writes and sets Secure
cookies for HTTPS. The edge strips forwarding headers and limits request size
and concurrency. The Phala default HTTPS gateway terminates public TLS for this
preview; this does not establish end-to-end TEE TLS or inference privacy. The
existing gateway retains its own TLS/attestation configuration.

First boot creates an isolated public database and 128 new buyer slots. Each
verified owner permanently claims two slots with finite simulated budgets and
two sum/verify tasks. Catalog and initial-task validity is seven days. Each agent
can create one additional bounded task. Finished artifacts remain readable after
expiry. Restart resumes the same configuration, ledger, journal, virtual files
and original operations; it never replenishes money, offers or task counts.
Transient first-boot interruption can finish the original seed transaction;
occupied data or an altered owner binding fail closed.

Use `scripts/prepare-agent-preview-overlay.py` (operator dependency: PyYAML) to
generate the additive overlay and preservation report from the backed-up
app-compose, immutable image ID, archive SHA-256, source revision, public origin
and compatibility binding hash. Keep input/output manifests outside git.
The report proves the original service, volume and network definitions, other
manifest fields, and original pre-launch prefix remain equal.

Use the Phala CLI to back up the existing app-compose, apply the release overlay
to that same CVM, and preserve encrypted environments. The overlay must assert
that the original service definitions, volumes and allowed secret names are
unchanged. Append a digest-checked public image loader to the original measured
pre-launch script. Never enable disk cleanup, reset the ledger, replace the
existing gateway image, or copy live credentials into the preview. Record the new
expected compose hash, preview origin, image hash and source revision.

## Public ordinary-wallet workspace

The current image serves the single `market-playground` Mono UI. Access-code login is disabled when `publicWorkspace` is configured by the runner. NEP-413 wallet login opens an isolated owner workspace; Agent API credentials are unnecessary.

An upgrade preserves the existing `/data/pg`, private preview database, `market` directory, and gateway volumes. It creates `private_market_agent_public_v1`, `market-public-v1`, Redis DB 1 and `public-auth.sqlite` inside the preview volume. Each owner permanently claims two new buyer slots; old private preview identities are never reassigned. The initial pool has 64 owner allocations. Claims, virtual budgets, local fixture receipts and transfer journals survive restart.

The preview's inference model and settlement are still controlled. Its separate ordinary-wallet panel supports optional real mainnet funding and returning funds with browser-held keys. Only owner authentication and final transfer verification use the mainnet read-only RPC; the server cannot sign real NEAR transactions. Back up the preview volume including `configuration.json` and the encrypted authentication database together. Agent key backups remain the user's responsibility and never enter this volume.

The historical `AGENT_PREVIEW_OWNER_HASH` environment field remains solely as an upgrade compatibility check. It grants no public access and is not requested by the UI. The overlay update changes only preview image/revision, appends a digest-verified image loader, and preserves the original gateway service, sealed env names, volume definitions and manifest metadata.

A host may explicitly set `AGENT_PREVIEW_FALLBACK_ORIGIN` to one additional exact
HTTPS origin it owns (for example its original Phala preview address). The
canonical origin is retained. Both request origins are whitelisted; login
challenges and local wallet-possession proofs bind to the actual selected origin.
Wildcards, paths, extra origins and HTTPS-to-HTTP downgrade are rejected. Cookies
and browser vaults remain local to each host. Moving to the other host requires
restoring the same encrypted backup if real wallets have already been registered.
The overlay's optional `--fallback-origin` records this extra preview environment
field explicitly in its preservation report.

## Frontend-only updates

`Dockerfile.frontend` builds the canonical playground (including `/proposal`)
over the exact currently deployed runtime image. Load and verify that image
first, then pass its immutable pin as `RUNTIME_IMAGE` and the reviewed frontend
commit as `FRONTEND_REVISION`. The `ai.bitrouter.frontend.revision` label records
the UI source separately from the inherited runtime revision. No backend binary,
entrypoint or persistent data is replaced. Publish and apply the resulting image
with the same digest-checked release overlay and preservation checks above.
