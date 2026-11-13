# Market dstack / Phala Cloud packaging

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
  --domain market.example.com \
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
- `NAMECHEAP_USERNAME`, `NAMECHEAP_API_KEY`, `NAMECHEAP_CLIENT_IP`
- `ACME_EMAIL` (current ACME contact name; `CERTBOT_EMAIL` is legacy)

Buyer verifying keys are public config (`buyers.public.json`), not encrypted
secrets. Anything else the operator passes must be rejected by `allowed_envs`.

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

## Networking and TLS

All services use host networking so `DATABASE_URL` / `REDIS_URL` stay on
`127.0.0.1` and the Market HTTP listener stays loopback. Postgres is started with
`listen_addresses=127.0.0.1`. Redis uses `--bind 127.0.0.1` and
`--protected-mode yes`. Only port **443** is intended as the external surface
(`dstack-ingress` in production, Caddy for local acceptance).

Production TLS uses **dstack-ingress** with Let’s Encrypt **DNS-01** via
**Namecheap** (`DNS_PROVIDER=namecheap`). Credentials follow
[dstack-ingress DNS_PROVIDERS.md](https://raw.githubusercontent.com/Dstack-TEE/dstack-examples/e199b30ecfbd623cbbd175e554b7fd214f629be5/custom-domain/dstack-ingress/DNS_PROVIDERS.md):
`NAMECHEAP_USERNAME`, `NAMECHEAP_API_KEY`, `NAMECHEAP_CLIENT_IP`, plus
`ACME_EMAIL`. The TLS private key is created inside the CVM. The Market waits for
`fullchain.pem` and seals the leaf SPKI into the ACI keyset before serving.

**Namecheap / SET_CAA:** this compose sets `SET_CAA=true`. On Namecheap that
makes the gateway pointer an **A record instead of a CNAME**. Every Namecheap
write goes through `setHosts`, which **replaces the whole zone** (read-modify
write; if the read fails, nothing is written). `NAMECHEAP_CLIENT_IP` must be the
CVM node’s public IP, **whitelisted** in Namecheap API access. If that node IP
changes, API auth and renewals fail — pin the CVM with `phala deploy --node`.

**Certificate renewal:** a new leaf changes SPKI. The attested keyset will not
match the live certificate until the Market process restarts and reseals. Buyers
must re-verify. There is no hot reload in this version.

**DNS operator:** Namecheap credentials live in the CVM, and the operator who set
the encrypted secrets knows them. That operator also controls DNS and can
redirect traffic (denial of service). They cannot read buyer traffic: a
certificate issued outside the TEE has a different key and fails the client’s
SPKI pin after a successful Market identity check.

## Secrets and buyer keys

| Material | Source |
| --- | --- |
| Buyer ed25519 public keys | Public `buyers.public.json` (buyer-generated offline) |
| Buyer bearer tokens | Phala encrypted secrets (the operator who set them knows them) |
| Namecheap + ACME_EMAIL | Phala encrypted secrets |
| Bootstrap binding, cutover token, seller key, Postgres password | Generated inside the VM on first boot |

Signing private keys never enter the deployment.

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

## Local acceptance (no Phala)

```bash
bash scripts/accept-market-dstack-local.sh
```

Builds the image, runs the stack with attestation disabled and a self-signed
certificate, checks `https://127.0.0.1/healthz` from a container on the Docker
host network (required on Docker Desktop, where host networking is not WSL
localhost), and fails if Postgres/Redis/Market HTTP listen on a non-loopback
address. Only port 443 may bind non-loopback.

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
  --domain market.example.com \
  --buyers-public deploy/market/buyers.public.json
# Review deploy/market/rendered/compose.hash and app-compose.json.
```

### Encrypted env file

Create `deploy/market/.env` (gitignored) with **only** the allowed secret names:

```bash
BUYER_0_TOKEN=brk_...
BUYER_1_TOKEN=brk_...
BUYER_2_TOKEN=brk_...
NAMECHEAP_USERNAME=...
NAMECHEAP_API_KEY=...
NAMECHEAP_CLIENT_IP=...   # whitelisted node public IP
ACME_EMAIL=ops@example.com
```

### Phala deploy (measured app-compose)

Per [Phala Cloud CLI deploy](https://docs.phala.com/phala-cloud/phala-cloud-cli/deploy.md):

- `-c, --compose` is a **Docker Compose** path.
- `--app-compose` is a **whole app-compose JSON** file, “sent instead of
  `--compose` and the compose flags” (create only; needs `compose_advanced`).

To keep the measured hash identical to `scripts/render-market-compose-hash.py`,
deploy the rendered JSON with `--app-compose`, not a bare `docker-compose.yml`:

```bash
# Replace NODE with a fixed node from `phala nodes` (required for Namecheap IP).
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

Doc lines relied on (deploy.md options / examples):

- `-c, --compose <value>` — “Path to Docker Compose file”
- `--app-compose <value>` — “Path to a whole app-compose JSON file, sent instead
  of --compose and the compose flags”
- Example: `phala deploy --app-compose app-compose.json`
- `-t, --instance-type` / example: `phala deploy --instance-type tdx.medium`
- `--node <value>` — “Physical node name… Run `phala nodes` to list…”
- `-e, --env` / example: `phala deploy -e .env`
- `--kms <value>` — “KMS type: phala (default), ethereum/eth, or base”
- Example: `phala deploy --no-public-logs --no-public-sysinfo`

After deploy, confirm the CVM’s compose-hash equals
`deploy/market/rendered/compose.hash`, then pin that hash in buyer
`acceptedComposeHashes`.
