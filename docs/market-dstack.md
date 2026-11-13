# Market dstack / Phala Cloud packaging

> **Agents:** Before changing Phala / dstack / CVM / ingress packaging, read this
> file, then open the [Phala docs index](https://docs.phala.com/llms.txt), select
> the links that match the task, and read those pages before implementing.

Controlled-mode packaging for a Phala Cloud confidential VM. This is not
hardware acceptance, not batch D completion, and not a live NEAR inference
deployment. Health remains `attested: false` until an independent buyer verifies
a real quote.

## What is measured

dstack records a **compose hash**: SHA-256 over the **canonical JSON** of
`app-compose.json`, not over `docker-compose.yml` alone. The manifest embeds the
full compose file as `docker_compose_file`, plus explicit fields such as
`runner`, `allowed_envs`, `kms_enabled`, `gateway_enabled`, `public_logs`,
`public_sysinfo`, and `pre_launch_script`.

Render and hash from the repo:

```bash
python3 scripts/render-market-compose-hash.py \
  --market-image ghcr.io/OWNER/private-market-host@sha256:DIGEST \
  --domain demo.bitrouter.ai \
  --buyers-public deploy/market/buyers.public.json
```

Deploy that exact rendered file with `phala deploy --app-compose` (see below). The
locally computed `compose.hash` must equal the RTMR3 `compose-hash` event. Do
not pass only `--compose docker-compose.yml` and let the CLI/dashboard invent
metadata, a different `pre_launch_script`, or flip `public_logs` /
`public_sysinfo`.

This package sets `public_logs=false` and `public_sysinfo=false`. The measured
`pre_launch_script` is `deploy/market/pre_launch.sh`: a no-op that deliberately
omits Phala’s default script behavior (private-registry login, image prune/pull,
root password, SSH keys). SSH is not enabled.

`allowed_envs` lists only encrypted secrets:

- `BUYER_0_TOKEN`, `BUYER_1_TOKEN`, `BUYER_2_TOKEN`

No DNS provider credentials. `ACME_EMAIL` is left **unset** (optional; published
in `/evidences/acme-account.json` if set). Buyer verifying keys are public
config (`buyers.public.json`), not encrypted secrets. Anything else the operator
passes must be rejected by `allowed_envs`.

## Buyer keypairs (offline)

Each buyer generates an ed25519 keypair on their own machine. Private keys and
seeds never enter the git repo or the CVM.

```bash
# From the repo root (Node 20+). Writes only public keys into the deploy file;
# each buyer keeps their own secret file outside the tree.
mkdir -p "$HOME/market-buyer-keys"
umask 077
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { generateBuyerKeypair } from './clients/market-buyer/purchase-sign.mjs';

const buyers = [0, 1, 2].map((i) => {
  const pair = generateBuyerKeypair();
  writeFileSync(
    `${process.env.HOME}/market-buyer-keys/buyer-${i}.secret`,
    pair.secretKey + '\n',
    { mode: 0o600 },
  );
  return pair.publicKey;
});
writeFileSync(
  'deploy/market/buyers.public.json',
  JSON.stringify({ public_keys: buyers }, null, 2) + '\n',
);
console.log('wrote deploy/market/buyers.public.json (public keys only)');
console.log('secrets under ~/market-buyer-keys/buyer-*.secret (do not commit)');
JS
```

`deploy/market/buyers.public.json` is gitignored. The example shape is in
`deploy/market/buyers.public.json.example`. Buyers sign purchases with
`--signing-key-file` pointing at their local secret file.

## Networking and TLS (tls-alpn-01)

All services use host networking so `DATABASE_URL` / `REDIS_URL` stay on
`127.0.0.1` and the Market HTTP listener stays loopback. Postgres is started with
`listen_addresses=127.0.0.1`. Redis uses `--bind 127.0.0.1` and
`--protected-mode yes`. Only port **443** may bind a non-loopback address
(`dstack-ingress` public peek frontend). In tls-alpn-01 mode, HAProxy’s TLS
frontend listens on **`127.0.0.1:9444`** (`TLS_TERMINATE_PORT`) and lego’s ACME
responder on **`127.0.0.1:9443`** (`TLSALPN_PORT`) — both loopback only.

Production TLS uses **dstack-ingress 2.8** with Let’s Encrypt **tls-alpn-01**
(lego; no DNS API token in the CVM), per
[dstack-ingress README — Certificates without DNS credentials](https://raw.githubusercontent.com/Dstack-TEE/dstack-examples/e199b30ecfbd623cbbd175e554b7fd214f629be5/custom-domain/dstack-ingress/README.md):

| Variable | Value |
| --- | --- |
| `CHALLENGE_TYPE` | `tls-alpn-01` |
| `DOMAIN` | `demo.bitrouter.ai` |
| `GATEWAY_DOMAIN` | `gateway.dstack-prod5.phala.network` |
| `DNS_SETUP_MODE` | `wait` |

### Operator DNS records (by hand)

On first start the container prints the exact records, then waits until they
resolve. The operator creates them outside the TEE (nothing in the CVM can write
DNS):

1. **CNAME** `demo.bitrouter.ai` → `gateway.dstack-prod5.phala.network`
2. **TXT** `_dstack-app-address.demo.bitrouter.ai` → `<instance_id>:443`
3. **CAA** `demo.bitrouter.ai` → `0 issue "letsencrypt.org;validationmethods=tls-alpn-01;accounturi=…"`

**CAA must allow `tls-alpn-01`.** A leftover `validationmethods=dns-01` record from
an earlier dns-01 deploy will make the CA refuse. Redeploying / replacing the
instance changes the TXT value (see single-instance below).

### Leaf certificate path (attestation)

lego stores the issued leaf+chain at:

`/etc/letsencrypt/lego/certificates/<domain>.crt`

(and the key at `<domain>.key`). Source: dstack-ingress `tlsalpn.sh` /
`legoman.py` (`LEGO_PATH` default `/etc/letsencrypt/lego`). The Market’s
`PRIVATE_MARKET_TLS_CERT` and attestation `tls_certificate` point at that
`.crt`. HAProxy may serve a **self-signed placeholder** under
`/etc/haproxy/certs/` until issuance succeeds — the Market **must not** wait on
or seal that path. It waits for the lego `.crt` (real leaf) before `serve`.

### Single-instance limit

tls-alpn-01 publishes the **instance ID** in the TXT record (not the app ID), so
the hostname is pinned to one CVM instance. There is no gateway failover across
replicas. Replacing the instance requires updating DNS; until then issuance /
routing break.

### Renewal → new SPKI → Market restart

Certificate renewal issues a new leaf and therefore a new SPKI. The attested
keyset will not match the live certificate until the Market process restarts and
reseals. Buyers must re-verify. There is no hot reload in this version. Losing
the `cert-data` volume also changes the ACME account URI, so a pinned CAA
`accounturi` must be updated by hand.

### DNS operator trust

The operator who controls the zone can redirect traffic (denial of service).
They cannot read buyer traffic: a certificate issued outside the TEE has a
different key and fails the client’s SPKI pin after a successful Market identity
check. No DNS provider token is stored in the CVM in this mode.

## Secrets and buyer keys

| Material | Source |
| --- | --- |
| Buyer ed25519 public keys | Public `buyers.public.json` (buyer-generated offline) |
| Buyer bearer tokens | Phala encrypted secrets (the operator who set them knows them) |
| Bootstrap binding, cutover token, seller key, Postgres password | Generated inside the VM on first boot |

Signing private keys never enter the deployment.

## Boot measurements (MRTD / RTMR0–2)

Per [Verify the Platform](https://docs.phala.com/phala-cloud/attestation/verify-the-platform.md), MRTD/RTMR0–2 for a given dstack OS image **can** be reproduced independently of a live CVM: download the OS image, combine it with the VM config (CPU, memory, `os_image_hash`), and compute expected values with `dstack-mr` / `dstack-verifier` (“Expected MRTD and RTMR0-2 calculated using dstack-mr from the OS image + VM config”; optional full rebuild from `meta-dstack`).

This Market packaging does **not** yet ship a pinned, locally reproduced `dstack-mr` profile for prod5 / OS **v0.6.3**. Until that artifact exists in-repo, the buyer boot allowlist (`acceptedBootMeasurements`) is taken from a **Phala-served attestation quote whose Intel signature has been verified** (dashboard / `phala cvms attestation` / PCS), not from an independently reproduced `dstack-mr` run in this repository. That is stronger than blind TOFU against the HTTPS endpoint, but it is not full platform reproduction. Reproducing MRTD/RTMR0–2 from the published OS image + VM config remains the intended end state.

## Persistent state

Application state lives on the CVM persistent disk volume. Per dstack’s FAQ, the
CVM data disk is a **LUKS2** volume encrypted with `aes-xts-plain64`, unlocked
with a KMS-derived key after attestation
([Phala dstack FAQs — data encryption](https://docs.phala.com/dstack/faqs)).
LUKS protects confidentiality at rest; it is not rollback protection. Freshness /
anti-rollback are out of scope for this packaging task.

## Image trust

Compose pins the Market image by digest. That digest is trusted as built by the
team. Buyers cannot yet prove the image matches this source tree; reproducible
builds are future work.

**Private git deps at build time:** `scripts/prepare-market-docker-cargo.sh`
copies already-fetched checkouts from the builder’s local
`$CARGO_HOME/git/{db,checkouts}` into `deploy/market/.build-cargo/git` (no
network login, no token file). The Dockerfile `COPY`s that tree into the build
stage so `cargo build` can resolve BitRouter / ACI git deps offline. crates.io
stays online. The staging directory is gitignored and is not present in the
runtime image layers (multi-stage build; only the `private-market-host` binary
is copied into the final image).

## Deploy catalog identity (golden file)

The measured deploy catalog is generated with fixed constants in
`crates/private-market-host/src/provision.rs` and committed as
`deploy/market/catalog.json`. The image bakes that file at
`/etc/market/catalog.json`. `init-deploy` writes the same bytes into state and
refuses to start if they differ; every subsequent `serve` also byte-compares the
state catalog to the golden file and exits on any difference.

| Constant | Value | Role |
| --- | --- | --- |
| `DEPLOY_FIXTURE_ADDR` | `127.0.0.1:18080` | Loopback-only seller/tokenizer published in the catalog |
| `DEPLOY_CATALOG_AT_MS` | `1700000000000` | Frozen catalog clock (always ≥24h in the past at deploy) |
| `DEPLOY_CATALOG_VALID_UNTIL_MS` | `4102444800000` | Far-future bound for wall-clock-sensitive validity fields |

**Wall-clock-sensitive fields** (deploy generation only; Market money semantics
unchanged): seller order `valid_until` / GTD `expires_at`, supply-state
`valid_until`, throughput observation `valid_until`, load snapshot
`valid_until`, and scope report `valid_until`. Lab `init` still uses wall-clock
`now` + 30 minutes.

`/healthz` includes `catalog_policy_digest` (`sha256:` of the catalog bytes) in
deploy mode so buyers and local acceptance can pin the policy digest without
attestation. Local mode sets `PRIVATE_MARKET_SIGNED_PURCHASES=1` so purchase
signatures use that digest as the keyset when ACI is off.

Regenerate (empty `private_market_*` DB required):

```bash
private-market-host emit-deploy-catalog deploy/market/catalog.json
```

## Local acceptance (no Phala)

```bash
bash scripts/accept-market-dstack-local.sh
```

Builds the image, regenerates the golden catalog from committed constants and
requires a byte match with the repo file and the baked image path, runs the
stack with attestation disabled and a self-signed certificate, checks
`https://127.0.0.1/healthz` (including `catalog_policy_digest`) from a container
on the Docker host network (required on Docker Desktop, where host networking is
not WSL localhost), completes one signed purchase through 443 against the frozen
catalog, refuses a mutated state catalog on restart, and fails if Postgres /
Redis / Market HTTP / fixture **18080** (or tls-alpn-01 ports 9443/9444 when
present) listen on a non-loopback address. Only port 443 may bind non-loopback.

## Commands to push and deploy (operator)

Do not run these from CI in this task; they are the exact operator steps after
local acceptance passes.

### GHCR login and image visibility

Use a GitHub PAT with `write:packages` (and `read:packages`) to push:

```bash
# Create a PAT at https://github.com/settings/tokens with write:packages.
echo "$GHCR_PAT" | docker login ghcr.io -u GITHUB_USERNAME --password-stdin
```

**Publish the Market image as public on GHCR.** This compose’s measured
`pre_launch_script` does not perform private-registry login, and `allowed_envs`
does not include `DSTACK_DOCKER_*`. A public package avoids putting registry
credentials in the CVM.

If the image must stay private, configure GHCR pull credentials per
[Create with private Docker image](https://docs.phala.com/phala-cloud/cvm/create-with-private-docker-image.md)
(`DSTACK_DOCKER_USERNAME`, `DSTACK_DOCKER_PASSWORD`, `DSTACK_DOCKER_REGISTRY=ghcr.io`).
That expands the secret surface and requires updating `allowed_envs` and the
measured `pre_launch_script` accordingly — not the default for this package.

### Build, push, render

```bash
bash scripts/prepare-market-docker-cargo.sh
docker build -f deploy/market/Dockerfile -t ghcr.io/OWNER/private-market-host:security .
docker push ghcr.io/OWNER/private-market-host:security
# Make the package public in GitHub → Packages → package settings (recommended).
DIGEST=$(docker buildx imagetools inspect ghcr.io/OWNER/private-market-host:security --format '{{json .Manifest.Digest}}' | tr -d '"')
echo "$DIGEST"

# buyers.public.json must already exist (see Buyer keypairs above).
python3 scripts/render-market-compose-hash.py \
  --market-image "ghcr.io/OWNER/private-market-host@${DIGEST}" \
  --domain demo.bitrouter.ai \
  --buyers-public deploy/market/buyers.public.json
# Review deploy/market/rendered/compose.hash and app-compose.json.
```

### Encrypted env file

Create `deploy/market/.env` (gitignored) with **only** the allowed secret names:

```bash
BUYER_0_TOKEN=brk_...
BUYER_1_TOKEN=brk_...
BUYER_2_TOKEN=brk_...
```

### Phala deploy (measured app-compose)

Per [Phala Cloud CLI deploy](https://docs.phala.com/phala-cloud/phala-cloud-cli/deploy.md):

- `-c, --compose` is a **Docker Compose** path.
- `--app-compose` is a **whole app-compose JSON** file, “sent instead of
  `--compose` and the compose flags” (create only; needs `compose_advanced`).

To keep the measured hash identical to `scripts/render-market-compose-hash.py`,
deploy the rendered JSON with `--app-compose`, not a bare `docker-compose.yml`:

```bash
# Prefer a fixed --node so instance replacement (and TXT updates) are deliberate.
phala deploy \
  --name private-market \
  --app-compose deploy/market/rendered/app-compose.json \
  --instance-type tdx.medium \
  --node NODE \
  --kms phala \
  -e deploy/market/.env \
  --no-public-logs \
  --no-public-sysinfo \
  --wait
```

After deploy, create the printed CNAME/TXT/CAA records, confirm the CVM’s
compose-hash equals `deploy/market/rendered/compose.hash`, then pin that hash in
buyer `acceptedComposeHashes`.
