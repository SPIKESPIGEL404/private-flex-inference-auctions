# Buyer verification of the Market

This step adds first-hop ACI identity and channel verification to the A–C host.
It reuses `aci-protocol` at Private AI Gateway commit
`0edde219a8ecb970c76c4cb3d1ca557d4fd567b3` and the published
`@phala/aci-verifier` 0.11.0 client, pinned by npm integrity in the client lockfile.
It does not embed the other gateway's inference router or middleware. The Cloud
Market source, money authority, original attempts and native execution stay in use.

The user chose **local verification without deployment**. No CVM was created,
no new paid inference was issued, and this is not hardware acceptance or full
batch D completion. Local tests use a separately owned fake dstack RPC; the
production buyer rejects that evidence. Test acceptance does not establish
operator confidentiality, production OS acceptance or anti-rollback protection.

## Implemented flow

1. The optional host attestation surface computes the actual leaf certificate's
   SPKI hash and seals an ACI workload keyset with a 60–3,600 second lifetime.
   Its ephemeral Ed25519 key is generated inside the process; no ACI exchange
   receipts or E2EE are enabled in this phase.
2. A client supplies a fresh nonce. The host obtains a nonce/keyset-bound TDX
   quote from an explicit local Unix socket and includes the dstack event log
   and measured compose. Startup and later requests fail if RPC/binding fails.
   There is no in-process fake quote or simulator fallback.
3. The buyer requires a local, explicitly reviewed policy: exact HTTPS endpoint,
   compose hashes, production boot measurements. It verifies a real Intel-root
   quote and `UpToDate` TCB, rejects debug TDX attributes, checks the accepted
   MRTD/RTMR0/RTMR1/RTMR2 profile, and delegates nonce/keyset/expiry, RTMR3 compose
   and actual SPKI channel enforcement to the pinned ACI runtime.
4. The additional boot/TCB checks apply on every identity bootstrap or renewal.
   Only afterward does the CLI read the buyer credential file and procurement
   body. It sends one native purchase with redirects disabled and an explicit
   idempotency key. There is no automatic purchase retry.

The byte-offset boot check deliberately supports **TDX quote v4 only**. Other
quote layouts fail closed. The boot allowlist must come from independently
reviewed platform releases. Copying measurements or compose hashes from the
endpoint being verified would only create trust on first use and does not meet
this policy's intended deployment review.

## Host configuration

Without `PRIVATE_MARKET_ATTESTATION_CONFIG`, the A–C loopback host behaves as
before and has no ACI identity endpoint. Set it to a private JSON file:

```json
{
  "dstack_socket": "/var/run/dstack.sock",
  "tls_certificate": "/run/market-tls/leaf.pem",
  "public_domain": "market.example.com",
  "keyset_lifetime_seconds": 3600
}
```

The host still binds plain HTTP **only to loopback**. An eventual deployment must
place the TLS terminator and private key in the same reviewed confidential VM
as Market, PostgreSQL, Redis and tokenizer. The configured certificate must be
the leaf actually served by that terminator. A public TLS terminator outside
the confidential workload is not sufficient. The complete compose, source/image
pins, configuration, key generation/custody and management access need review.

Routes: `GET /market/v1/aci/attestation?nonce=<64 lowercase hex>` and the alias
`/v1/aci/attestation`. Responses are not cacheable. Missing/malformed challenges
are rejected. Evidence failure returns a generic 503 with no internal details.
An available proof endpoint is not a self-certified attestation verdict: host
health/startup remains `attested: false`, and only the independent buyer can
report successful verification. Expired identities stop producing reports and
require controlled restart; this version has no transparent key renewal owner.

## Buyer configuration and commands

```bash
npm ci --ignore-scripts --prefix clients/market-buyer
node clients/market-buyer/cli.mjs verify --policy /private/market-policy.json
node clients/market-buyer/cli.mjs buy --policy /private/market-policy.json \
  --credential-file /private/buyer-token \
  --request-file /private/purchase.json --idempotency-key buyer-order-1
```

Policy schema (replace all explanatory values with reviewed real values):

```json
{
  "version": 1,
  "baseURL": "https://market.example.com/market/v1",
  "acceptedComposeHashes": ["REVIEWED_COMPOSE_SHA256_64_LOWERCASE_HEX"],
  "acceptedBootMeasurements": [{
    "mrtd": "REVIEWED_96_HEX",
    "rtmr0": "REVIEWED_96_HEX",
    "rtmr1": "REVIEWED_96_HEX",
    "rtmr2": "REVIEWED_96_HEX"
  }],
  "acceptedPolicyDigests": ["sha256:REVIEWED_CATALOG_FILE_SHA256_64_LOWERCASE_HEX"]
}
```

The purchase JSON is the existing streaming native Market request, including
`bitrouter_purchase`. Stdout contains the buyer's SSE; stderr contains only the
verification summary or generic failure. Keep both private. A failed POST can
still have created the original procurement; preserve its idempotency key and
use existing Market recovery semantics instead of generating a new identity.

The client explicitly sets `requireVerified: false` and `requireReceipt: false`
for **upstream serving**. Market hardware/nonce/release/boot/TLS verification is
still mandatory. These settings prevent the ACI client from injecting the other
gateway's `provider.aci_verified` field or requiring its exchange receipts. The
current Market meter has not added those contracts. NEAR verification and ACI
exchange receipts are separate future work; Market's financial receipts remain.

## Local acceptance

Requires the existing PG/Redis/Rust tools, Node 22.19+, npm and OpenSSL. Allow
several GB of free disk for separate Rust build/lint artifacts.

```bash
bash scripts/accept-market-identity.sh
```

The production host uses a real Unix-socket RPC client. The test harness provides
a fake RPC in a separate process and an owned CA with two actual TLS leaf keys.
A **test-only** identity provider uses the official ACI binding/compose checks
and actual Node pinned transport while explicitly skipping the hardware root.
It cannot be enabled by a production CLI flag or host config. One successful
controlled TLS purchase uses the real host, native seller, PG and Redis ledger.

Negative scenarios cover changed keyset, expired keyset, wrong nonce, unaccepted
compose, unaccepted boot profile, different live SPKI, production rejection of
fake hardware, server startup rejection of a wrong quote slot, and an unaccepted
catalog digest. Assertions require zero sensitive POSTs/submit effects before the
successful purchase. A later catalog-byte change reseals a new keyset subject and
digest. A change between the first hash and Market load refuses startup.
The client unit tests additionally reject empty allowlists, HTTP/unexpected
endpoints, debug TDX attributes, unsupported quote shapes and altered boot fields.

## Catalog policy binding

On serve, the host hashes the raw `catalog.json` bytes and seals
`subject` as `market-policy:sha256:<hex>` inside the workload keyset. The pinned
`WorkloadKeyset` has no extension field, so this subject is the value included
in the JCS keyset digest and therefore in `report_data`. The hash is
`bitrouter_market::persistence_codec::digest`, which is plain SHA-256 of those
file bytes; a buyer can compute the same `sha256:` digest independently. After
`launch::start_configured` loads that path, the host reads and hashes the file
again and refuses to listen if it differs from the digest that will be sealed.
The buyer policy's `acceptedPolicyDigests` must contain that digest. The check
runs on every identity acquisition, including renewal.

This covers the catalog file only, at process start. It does not prove the
catalog's trading rules, any other file, code measurements, or a later on-disk
edit before the next process. A generic ACI verifier does not enforce this
subject. It is not hardware acceptance, and health output stays `attested: false`.
A catalog change creates a new attested identity only when a new process seals it.

```bash
bash scripts/accept-market-identity.sh
```

The controlled run rejects a wrong digest with no sensitive POST, shows that a
changed catalog changes the sealed subject and keyset digest, and shows that a
change between the first hash and Market load fails startup. Node tests reject
a missing or malformed `acceptedPolicyDigests` list.

This is bounded local integration evidence. A future hardware run must verify
the actual deployed source/configuration, production boot profile, TLS custody,
database/storage boundaries and lifecycle freshness before batch D can pass.
