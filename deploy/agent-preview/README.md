# Controlled agent preview on an existing CVM

This sidecar publishes P2's browser, local scripted seller/wallet, native Market,
PostgreSQL and Redis. It makes no real chain or provider calls and accepts no
live credentials. The existing Chutes/NEAR gateway image, ports, mounted data,
pre-launch prefix and sealed secret names are preserved by the release overlay.

Prepare the pinned source and build from the repository root:

```sh
python3 scripts/materialize-market-p2.py
bash scripts/prepare-market-docker-cargo.sh
docker build --platform linux/amd64 -f deploy/agent-preview/Dockerfile -t agent-preview:local .
```

The container requires `AGENT_PREVIEW_ORIGIN` (the exact public HTTPS origin) and
`AGENT_PREVIEW_OWNER_HASH` (SHA-256 of a locally generated random 32-byte access
code). Keep the code outside the repository. The public compose contains only
its hash. `AGENT_PREVIEW_REVISION` identifies the deployed code. Mount a new,
dedicated volume at `/data`; no existing gateway volume or dstack socket is used.
Publish only port 3000. Attach only to a new dedicated `internal` bridge network;
the fixture requires no external network access. All PostgreSQL, Redis, wallet,
proxy and Market ports remain on the container's loopback interface. Set a memory limit, CPU limit,
read-only root filesystem, `/tmp` tmpfs and `no-new-privileges`.

The public-origin guard rejects cross-origin browser writes and sets Secure
cookies for HTTPS. The edge strips forwarding headers and limits request size
and concurrency. The Phala default HTTPS gateway terminates public TLS for this
preview; this does not establish end-to-end TEE TLS or inference privacy. The
existing gateway retains its own TLS/attestation configuration.

First boot creates an isolated database, two finite simulated agent budgets and
two sum/verify tasks. Catalog and initial-task validity is seven days. Each agent
can create one additional bounded task. Finished artifacts remain readable after
expiry. Restart resumes the same configuration, ledger, journal, virtual files
and original operations; it never replenishes money, offers or task counts.
Transient first-boot interruption can finish the original seed transaction;
occupied data or an altered owner binding fail closed.

Use `scripts/prepare-agent-preview-overlay.py` (operator dependency: PyYAML) to
generate the additive overlay and preservation report from the backed-up
app-compose, immutable image ID, archive SHA-256, source revision, public origin
and owner hash. Keep input/output manifests and the access code outside git.
The report proves the original service, volume and network definitions, other
manifest fields, and original pre-launch prefix remain equal.

Use the Phala CLI to back up the existing app-compose, apply the release overlay
to that same CVM, and preserve encrypted environments. The overlay must assert
that the original service definitions, volumes and allowed secret names are
unchanged. Append a digest-checked public image loader to the original measured
pre-launch script. Never enable disk cleanup, reset the ledger, replace the
existing gateway image, or copy live credentials into the preview. Record the new
expected compose hash, preview origin, image hash and source revision.
