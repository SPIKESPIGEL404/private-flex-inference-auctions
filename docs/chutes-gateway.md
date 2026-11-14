# Single-model Chutes TEE gateway

The only public model is `qwen3.8-27b`. The internal model is
`Qwen/Qwen3.8-27B-FP8`, revision
`017b9c7af6b5689d5dd426a76e0bc077eb5ca20a`, in private Chute
`5f5b67f2-139e-5857-bdfb-94a30e03a526`.

This branch extends current main. It retains mandatory signed purchases when
ACI is enabled, catalog-policy binding, golden controlled-deployment checks,
and buyer-generated offline signing keys. It does not deploy a historical
unsigned image as an upgrade to main.

## Request and proof path

```text
buyer (verified TLS + signed purchase)
  -> Phala Market / ledger
  -> authenticated loopback Chutes bridge
  -> encrypted Chutes relay
  -> nonce-bound ML-KEM key in an approved TDX instance
```

`GET /market/v1/models` returns exactly the public alias. Other model names,
Messages and Responses have no public product. Single-model startup rejects a
catalog containing other products or a remote/plaintext provider route. The
bridge listens only on IPv4 loopback, with a local caller secret separate from
the Chutes key. There is no plaintext inference fallback or invoke retry.

Before each invoke the bridge checks the authenticated private Chute's exact
source, version, image, model revision and native Chat interface. It verifies
Intel-root DCAP with UpToDate/no-advisory/debug-off policy, MRTD and all RTMRs
against a locally frozen Chutes-published reference snapshot, and the fresh
nonce/ML-KEM key report-data binding. NVIDIA NRAS ES384 signatures, JWKS,
issuer, expiry, nonce, detached GPU-token digests and device security claims are
also required. An expired invocation token or any failed check prevents invoke.

The snapshot trusts Chutes as the measurement-policy publisher; it is not an
independent reproducible-build audit. Model identity uses control-plane
source/version/revision/image pins. Loaded weights and CPU/GPU session topology
are not independently hardware-proven. Chutes reports are not relabeled as
NEAR-operated evidence. The recorded SHA-addressed native reports exposed at
`/market/v1/provider-evidence/<hash>` are preflights, not per-request execution
receipts. The ACI client's stronger `upstream_verified` contract stays false.

Only decrypted native terminal/usage evidence is accepted. Continuous vLLM
usage is checked for consistency/monotonicity, suppressed on intermediate choice
frames, and forwarded unchanged in the actual final usage frame. `[DONE]` is
withheld until validation; the native marker can itself be encrypted. The
plaintext relay billing summary cannot establish native metering. Unknown
attempts retain their original responsibility and cash hold.

## Controlled verification

```sh
uv venv --python 3.12 .market-runs/chutes-gateway/venv
uv pip install --python .market-runs/chutes-gateway/venv/bin/python \
  -r deploy/chutes/requirements-gateway.txt -r scripts/requirements-market-c.txt
npm ci --ignore-scripts --prefix clients/market-buyer
bash scripts/accept-market-chutes.sh
```

The owned PG/Redis scenario uses buyer-generated keys outside Market state,
signed purchases, the actual continuous-usage normalizer, native model mapping,
settlement and exact replay after restart. Unsigned, tampered and captured-nonce
requests are rejected before provider contact. Transport tests use real local
ML-KEM/AEAD and controlled signed NRAS tokens; they do not claim real hardware.
The existing `scripts/accept-market-identity.sh` checks main's identity and
purchase-security behavior independently.

## Native Chute preparation

In the existing Chutes SDK environment:

```sh
.phase4-tools/bin/python deploy/chutes/manage.py --definition market \
  --key-file /private/chutes.key --output /private/native-plan
```

Review its request and current deployment, then apply with `--apply` and a new
output directory. The native definition keeps the original private TEE/model,
single GPU and maximum one instance; it has no hourly price selector ceiling
and retains idle instances for one hour. The manager does not accept a new
deployment fee. The historical scheduler definition remains separate.

### Read-only native metrics

The private Chute registers `GET /metrics` alongside native Chat. Scrape it
with a Chutes API key authorized for this private Chute:

```sh
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${CHUTES_API_KEY}" \
  https://kelsen-qwen-qwen3-8-27b-fp8.chutes.ai/metrics
```

This returns the native Prometheus/OpenMetrics text and model labels. The Cord
always makes a GET to this replica's fixed loopback vLLM `/metrics`, using the
engine's own authentication and optional mTLS context. Caller URLs, parameters,
headers and methods are ignored. Redirects, non-text responses, upstream errors,
responses over 4 MiB and requests exceeding ten seconds fail with a generic
502. The handler sets `Cache-Control: no-store`; Chutes' external relay replaces
this with `no-cache, no-transform`. `Response.media_type` is set explicitly so
the relay reconstructs the native Content-Type. No POST metrics Cord exists.
Chutes enforces private-Chute authentication before dispatch; a Market buyer
token does not authorize this operational endpoint.

This endpoint is on the Chutes origin. The Market still advertises only
`qwen3.8-27b`. A scrape is ordinary authenticated monitoring, not a signed TEE
execution receipt or a trusted capacity reservation. It does not submit an
inference, reset counters, or automatically change auction admission. Updating
the Chute source requires reviewing and updating the gateway's exact source and
version pins before its next provider invocation.

For Prometheus, use [the scrape example](../deploy/chutes/prometheus.example.yml)
and mount the Chutes key at its `authorization.credentials_file` path. It uses
HTTPS and disables redirects; the key is never stored in the YAML. These fields
follow the [Prometheus scrape configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#scrape_config).

Run the six native metrics contract tests in the existing SDK environment:

```sh
.phase4-tools/bin/python -m unittest discover -s deploy/chutes -p test_metrics.py -v
```

```sh
.market-runs/chutes-gateway/venv/bin/python deploy/chutes/prepare_gateway.py \
  --key-file /private/chutes.key \
  --deployment-receipt /private/native-apply/update.json \
  --output /private/prepared-chutes
```

This makes no inference call. Review its frozen vendor measurement policy,
tokenizer hashes, provider source/version pins and project-seller test terms.
GPU wall-clock charges are separate from the token-based test-credit terms.

## Phala packaging on current main

Read [the packaging source of truth](market-dstack.md) and the official
[encrypted-env](https://docs.phala.com/phala-cloud/cvm/set-secure-environment-variables.md),
[deploy](https://docs.phala.com/phala-cloud/phala-cloud-cli/deploy.md), and
[platform verification](https://docs.phala.com/phala-cloud/attestation/verify-the-platform.md)
documentation before rendering a release. This optional profile uses an in-CVM
CA/leaf on the default TLS-passthrough hostname. It leaves the main
`deploy/market` custom-domain packaging intact.

1. Buyers generate their signing keypairs offline, as in `market-dstack.md`.
   Supply only `{ "public_keys": ["ed25519:...", "ed25519:...", "ed25519:..."] }`
   to the CVM. Signing secrets never enter a seed, image, volume or environment.
2. Create three distinct `brk_...` bearer tokens in a private JSON array file
   (mode 0600), separate from the provider key. Produce a public measured seed:

   ```sh
   .market-runs/chutes-gateway/venv/bin/python deploy/chutes/seed_gateway.py \
     --prepared-run /private/prepared-chutes --buyers-public /private/buyers.public.json \
     --bearer-tokens /private/buyer-tokens.json \
     --attestation-config /private/attestation.chutes.json \
     --nginx-config deploy/phala/nginx-chutes.conf --output /private/chutes-seed.json
   ```

   The seed contains only public inputs and the bearer-file digest. Unknown
   credential fields, extra buyer fields and public bearer files are rejected.
3. Build `deploy/phala/Dockerfile.chutes` from this branch, using its dedicated
   `.dockerignore` and a BuildKit `github_token` secret for the private pinned
   dependency. Pin the new image by digest; do not reuse the historical live
   binary. Fill `compose.chutes.example.yaml`, `attestation.chutes.example.json`
   and `nginx-chutes.conf`, choosing a fresh data volume and reviewed CA volume.
4. Seal `CHUTES_API_KEY` and `MARKET_BUYER_KEYS_B64` (base64 of the exact private
   token-file bytes). Review the entire app-compose manifest, seed hash,
   immutable configuration mounts and explicit `allowed_envs`, not only the
   YAML. Store the public seed at the explicit CVM persistent path before first
   boot; the CLI does not upload arbitrary bind-mount files. Bootstrap verifies
   its pinned digest and materializes the approved TLS/nginx configuration in
   RAM. Environment updates replace the whole secret set. Configuration binds
   must exist before container start; retain data and CA volumes on restart.
5. Bootstrap waits for an active Chute before making its one calibration and
   creating the initial ledger. `init-live-deploy` registers only the supplied
   buyer verifying keys and sealed bearer tokens, with no signing directory.
   Qualified restarts resume the same ledger; they never refill offers. A
   separately approved named calibration resume is allowed only before any
   buyer request and cannot reinitialize accounts.
6. Export and review the generated public catalog (`/market-catalog.json` in the
   example nginx configuration) through an independent operator channel. Compute
   its SHA-256 locally and put it in `acceptedPolicyDigests`, alongside reviewed
   compose/boot/CA pins, before invoking the buyer CLI. Do not learn an accepted
   digest automatically from a serving quote. State catalog bytes, their
   attested keyset subject and the buyer's accepted digest must match.
7. Use the existing signed buyer CLI with `--signing-key-file`,
   `--credential-file`, `--request-file deploy/chutes/example-market-request.json`
   and an explicit idempotency key. All private inputs are read after gateway
   verification. A fresh signature/nonce is required for an original-key replay.

This is a finite three-offer, test-credit bootstrap with 30-minute qualification
validity, at most 512 output tokens, and the base identity's maximum one-hour
lifetime. It is not production funding, perpetual supply, or a durable upstream
Chat reattachment service. The TLS helper retains each boot's RAM key during
certificate renewal; a new boot gets a new key and must be independently
verified. Keyset renewal behavior remains current main's behavior.

The [historical live run](acceptance/2026-11-14-chutes-live.md) records actual
hardware/E2EE, test settlement and CVM replay for the older binary, plus its
retained early Unknown test. The current main-based port has separate controlled
[acceptance](acceptance/2026-11-14-chutes-main-port.md); that gateway build has
not replaced the historical online image. The subsequent
[metrics deployment](acceptance/2026-11-14-chutes-metrics.md) updates the native
Chute source and that existing gateway's measured provider pins.
