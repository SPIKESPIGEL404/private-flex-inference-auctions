# Batch A source and dependency record

Cloud source: `https://github.com/bitrouter/bitrouter-cloud`, commit
`244177cafa26e8c8b001e61297cf4e7f89ac8de9` (PR 667).
Native protocol/client source: `https://github.com/bitrouter/bitrouter`, commit
`f206ca9a6f472b079167c9992c1c1ce1688725af`, as selected by Cloud's manifest.
The independent host lockfile pins the complete resolved graph.

Batch A uses the unmodified Cloud library as a fixed Git dependency. The
dependency retains the whole Cloud library source to close the shared money,
schema, auth and Redis dependencies without replacing private financial APIs.
This is an intentional temporary dependency boundary, not a claim that Cloud's
full library has already been extracted into a small standalone market crate.
The executable constructs only the Market, its verified resolver and the
required database/cache handles. It does not start Cloud's public gateway,
Console, Core process, Stripe, auto-topup or OAuth product.

The Market domain is also a dependency from the same source commit. There is
no scheduler dependency or dependency on a local Cloud checkout. The existing
root scheduler manifest and lockfile remain independent.

Retained implementation paths:

- `crates/bitrouter-market`: kernel, qualification, offers, execution identities.
- `src/market/inference`: contract and Strategy.
- `src/market/pg`: fenced writer, storage, money, coordinator and native evidence.
- `src/core_gateway/market_inference*`: native transport, stream and recovery.
- `src/db`, `src/service/redis_balance`, `src/platform_billing`: shared cash,
  migrations, durable Redis mutations and integer money conversions.
- `src/auth/remote_resolver`, `verified`, `namespace`: verified source identity.

Copied without modification: `sql/{settings,promo,inference,cash}-up.sql`, from
`src/platform_billing` at the Cloud commit. These are the same stopped-writer
installation scripts used by the pinned native Market acceptance fixtures.
They install schema only; no billing gateway or production payment flow runs.

Adapted fixture code: `src/catalog.rs` and `src/provision.rs` derive from
`src/core_gateway/projection/admission/producer/native_publication/tests/public_coordinator/market_inference/{catalog.rs,../market_inference.rs}`.
They retain the native fixture's qualification and candidate construction;
the host fixes one On-demand seller with three one-use Offers and a shared slot, changes synthetic names, uses a thirty
minute offer lifetime, and writes a launch catalog. Qualification observations
and tokenizer IDs are synthetic. They must never be reused as evidence for a
real seller or model. `fixtures.rs` supplies a new controlled native seller and
loopback test authority. No production authentication proof constructor is added.

Upstream MIT notice is retained in [LICENSE.bitrouter-cloud](LICENSE.bitrouter-cloud).
This notice applies to the copied/adapted source as well as distribution of the
upstream library. Before shipping a binary, retain dependency license notices.

Further extraction should introduce narrow public library seams in the owning
source, then rerun batch B's financial and recovery invariants. Batch A does not
rewrite funds locking, snapshot fencing, Unknown handling or terminal evidence.

## Batch B regression sources

`tests/` retains the pinned kernel's integration tree byte-for-byte. Its hashes
are in `kernel-test-sha256.json` and are verified by `market-source-tests.py`.
The 202 default-feature cases run against the actual Git dependency. Seventeen
unit cases run from that same dependency's original Cargo source, located by
locked Cargo metadata. SQLite tools/simulation tests retain their original guards
and do not run in this PostgreSQL host.

`tests/inference_source.rs` adapts `src/market/inference/tests.rs` from the same
commit. Imports reference the real dependency; the result alias is made local.
The private platform-fee comparison uses the public `money::MicroUsd` calculation
and `NanoUsd` conversion. Two private `validate_contract` calls are replaced by
a public contract-version check; persisted-state and terminal assertions remain.
The private empty-output validator call supplies `OutputCheck::Empty` to the
domain test, with the validator itself covered by HTTP `terminal-empty`.
The private schema-instance test moves to HTTP `schema-instances`, including its
one valid and six invalid inputs. Thus 24 domain cases run at the public API and
the remaining private validator scenario is exercised through the host.

Cloud's private gateway/Core fixtures are not copied. B re-expresses applicable
Chat cases on the independent host: real PG/Redis transactions, external native
seller, process kill, concurrent admission, and dropped financial COMMIT ACK.
The proxy observes actual PostgreSQL protocol messages; no production fault hook,
authentication proof constructor or alternate financial implementation is added.

## Batch C live assembly

`src/live.rs` adds a separate two-phase project seller registration. It reuses
public kernel/PG types and the fixture construction shapes above, replaces all
synthetic model, tokenizer, endpoint, prices, Offer bindings and qualification
fields with an explicit bounded registration, then publishes an observation from
the captured real calibration. No upstream file is patched. Conservative Ready
declarations and the project quota remain declarations, separately labeled from
the measured sample and from the Provider's external GPU capacity.

`init-live` writes no serving catalog. `qualify-live` checks original calibration
bytes/terminal/usage and registration linkage before publishing source throughput
and a hash-bound native catalog. The native route, source meter, Strategy, shared
cash and financial recovery code remain the pinned Cloud implementations.
`validate-native-chat` invokes that actual meter/output contract before a live
probe. `scripts/market_c.py` supplies the private collector and exact local
tokenizer service, and keeps original source result bytes for upstream billing
because public replay IDs are rewritten by Cloud. The fixed tokenizer files are
recorded in the [C acceptance](../../../docs/acceptance/2026-11-11-market-batch-c.md).

This assembly is specific to the bounded text-only acceptance workload. It does
not establish arbitrary-prompt tokenization, Provider contract assent, attested
model weights or confidential Market deployment.

## Buyer-to-Market ACI identity

`src/attestation.rs` uses `aci-protocol` from
`Dstack-TEE/private-ai-gateway@0edde219a8ecb970c76c4cb3d1ca557d4fd567b3`
(Apache-2.0). It reuses the canonical wire types, keyset digest and exact nonce
statement/report-data encoding. `dstack-sdk-types` 0.1.2 supplies the official
Info/Quote RPC response shapes; a bounded local Unix-socket HTTP client avoids
pulling in the SDK's unrelated Ethereum client. RPC contracts and report assembly
follow the pinned upstream `src/dstack.rs` and `src/aggregator/service/e2ee.rs`.

The buyer pins published `@phala/aci-verifier` 0.11.0 through npm integrity. It
adds mandatory reviewed boot/compose policy and current TCB checks, then uses
the package's verified Node transport. The full gateway router, provider
failover, E2EE and exchange receipts are not imported. Local controlled test
identity injection lives only under the buyer's `test/` directory and cannot be
selected by the production CLI. See [scope and acceptance](../../../docs/market-buyer-verification.md).
