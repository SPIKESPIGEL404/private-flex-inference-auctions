# Agent MPP integration: controlled Phase 1

**2026-11-14 G1 correction:** the v2 fixture below models an agent-funded
Delegate Transfer, whereas real NEP-366 funds its deposit from the relayer.
Its intermediate receipt assumption also differs from nearcore. Historical P1
results remain controlled workflow/accounting evidence; they do not establish
the stated principal/gas split on NEAR. See the [P3 correction and plan](specs/2026-11-14-agent-mpp-p3-run-plan.md).

The controlled transport purchases one native chat-completion execution through
MPP. It models the historical controlled project-sponsored contract: the agent pays
native NEAR inference principal, while the project pays payment and refund gas.
The current target is agent-paid principal and payment gas, with merchant-paid
refund gas. This historical fixture does not implement that live route; G1 is
closed. See the [current contract](specs/2026-11-14-agent-mpp-p0-contract.md).

## Run and inspect

```bash
# Node >=24 must be on PATH, or set P1_NODE to its executable.
bash scripts/accept-agent-mpp-p1.sh
```

The runner installs the locked JavaScript dependencies, materializes the pinned
owning source, builds `crates/private-market-p1`, runs the unit suite and creates
fresh PostgreSQL/Redis processes for each integration scenario. It stops only
its own processes. PostgreSQL tools, Redis tools, Rust, git and patch are required.
`CARGO_TARGET_DIR` can select an existing target directory. No external chain,
wallet, inference provider or deployment is contacted by the integration tests.
Dependency installation/source retrieval can use the network.

See [the acceptance record](acceptance/2026-11-14-agent-mpp-p1.md). This P1 is
separate from the historical scheduler phases and the `nearintents.charge`
funding adapter. Neither old adapter is enabled in native P1 mode.

## Request and authority flow

1. The agent uses `p1/client.mjs` as its model transport and calls Proxy
   `/v1/chat/completions`, with its bearer token, `X-Agent-Task` and stable
   `Idempotency-Key`. `Payment-Authorization` carries the MPP credential separately.
2. Proxy authenticates the controlled agent/task mapping. The Rust quote helper
   uses the pinned native ChatRequest DTO, original output contract, original
   billing meter and original `base_charge_cap`. It freezes exact input bytes,
   the native request, complete PurchaseControls, FX, task/binding revisions,
   quote and timing forecast before exposing 402. Reusing a key with different
   input conflicts. Unsupported scope fails before payment.
3. One transaction reserves agent principal budget, a project gas estimate and
   the controlled seller's physical slot. No slot or sponsor budget means no
   payable challenge. The buyer's deterministic cost/speed policy includes the
   controlled payment, admission, execution and delivery estimates; its route
   fee is zero because project gas is not an agent expense.
4. The controlled wallet atomically stores an original operation under
   `near-pay-v2-<orderRef>` and returns that operation on replay. Existing operations
   recover after expiry or revocation. A known-unsent cancellation creates a
   durable tombstone under the same operation lock before releasing reserves.
5. The official mppx extension records the presentation before RPC verification.
   Independent FINAL chain evidence proves principal and project fees; the
   trusted wallet operation map proves which original sponsor operation owns
   that transaction. Wallet success alone cannot prove money received.
6. The original PostgreSQL balance fence atomically consumes the global money
   identity, adds the existing cash ledger entry, queues its existing Redis
   mutation and earmarks the resulting credit for this exact native order.
   Projection must be applied before original Market admission.
7. The owning admission trigger runs inside the original cash/kernel/outbox
   transaction. It checks frozen native identity, raw native body, complete
   PurchaseControls, task revision, agent binding, expiry and capacity lease.
   Deferred purpose constraints protect earmarked money against every original
   cash debit path. Original Market owns provider dispatch, event persistence,
   actual usage and cash settlement. Proxy supplies no alternative billing engine.
8. Original cash settlement derives native principal charge C from actual USD
   charges using frozen integer FX. It records P=C+H+W+R and updates task spend
   even if W=0. Positive W remains unavailable until the merchant's original
   refund operation independently reaches FINAL. Gas never reduces the refund.

## Sponsored method v2 and trust boundary

`bitrouter-near-sponsored`, charge, version 2 extends the frozen v1 request with
`gasSponsor` and `sponsorOperation`. It is a separate method from historical
`bitrouter-near-direct` v1; the plain-Transfer verifier cannot accept a delegate.

Verification requires one outer project-signed Delegate, one agent-signed inner
Transfer, exact merchant and original agent, the actual NEP-366 Borsh signature,
FullAccess keys at execution blocks, nonce/block validity, FINAL rooted receipts,
and an agent NEP-413 assignment of the full v2 challenge and transaction hash.
NEP-413 does not authorize the transfer. Chain transaction/receipt/action identity
is consumed globally. An independently valid double assignment is still rejected
when it conflicts with the original sponsor operation.

NEP-366 separates agent transfer principal from relayer gas, and defines a block
deadline independent of an application order deadline. See the
[NEP specification](https://github.com/near/NEPs/blob/master/neps/nep-0366.md),
[delegate implementation](https://github.com/near/nearcore/blob/master/core/primitives/src/action/delegate.rs)
and [signable-message tag](https://github.com/near/nearcore/blob/master/core/primitives/src/signable_message.rs).
This controlled encoder/verifier does not establish that the current Agent API
SDK can sign/submit these actions or that a hosted relayer offers this contract.

All serving URLs and the isolated `private_market_*` database are loopback-only;
mode must be `controlled`, network `testnet`, and real broadcasting disabled.
Buyer, merchant and fault-injection secrets are separate. Only the test fixture
contains deterministic signing keys, test RPC and fault controls. Public pinned
configuration excludes database credentials and raw service secrets.

## Recovery, liabilities and timing

Proofs, money movements, original refund send mappings and original dispatch
identity survive process loss in PG. Lost ACK recovery reuses the same wallet,
ledger and execution operation; it never purchases a replacement. New purchases
stop at order expiry, while an already started/unknown delegate continues to be
reconciled. Unadmitted late or invalidated payments owe a full principal refund.
Under/overpayment creates an actual-amount anomaly liability and cannot dispatch.
Confirmed failed transfers release principal only with conclusive final failure
and consumed delegate nonce; gas is still a project expense. Other failures stay
unknown and retain responsibility.

An autonomous worker scans pending original operations, revoked/stale paid orders
and refund liabilities. Persisted attempt ordering rotates bounded batches and
excludes conclusively closed payments; blocked old refunds cannot starve newer
liabilities. Cancel preserves exceptions and confirmed refund state. The worker
retries PG/network outages without discarding the original operation. It runs
without the buyer's continuing grant. A later
invalid public proof cannot suppress the wallet's durable original proof. Refund
gas estimates are project reservations; actual costs are recorded independently.
Estimates are operational limits, not claimed protocol hard caps. An overrun pauses
new sponsorship; a pending unfunded refund remains owed.

The controlled wallet locks current grant/task/project authority and checks actual
principal and sponsor funds again at new-send time. This includes pending wallet
holds; a quote does not guarantee that later balances remain available. Existing
operations recover before new-send checks. Late refund ACKs cannot downgrade a
confirmed refund. No backend can mint a fixture transaction with negative funds.

The order view exposes the frozen quote/policy decision and separately sourced PG
wall-clock stages: quote, proof, funds, native admission request/commit, original
financial commit, response read completion or interrupted delivery. Chain inclusion
timestamps remain independent. These fixture timings are wiring observations;
they do not establish production latency or the quality of a speed forecast.

## Owning source and deliberately bounded scope

`scripts/materialize-market-p1.py` archives Cloud commit
`244177cafa26e8c8b001e61297cf4e7f89ac8de9`, applies the tracked
`crates/private-market-host/upstream/p1/owning.patch` and installs the tracked
PG module/schema under ignored `.market-p1-upstream`. It checks the base pin,
patch inputs and every materialized source hash before reuse. It can fetch the
pinned archive without first resolving a manifest that depends on that directory.
Cargo's shared checkout is never edited. The legacy host keeps its own original
git dependencies; P1 has its own manifest/lockfile. Financial extension definitions
are sealed and verified alongside the original PG schema.

The seller is a restartable, one-slot local fixture whose PG lease and exact native
request actually gate its acceptance. Its tokenizer reports two input tokens and
its configured rates/usage are controlled data. The native API is limited to
`m/external`, text chat, max 64 completion tokens, no tools or fallback. One eligible
quote can be accepted, waited on or rejected; there is no invented faster tier or
claim of competitive price discovery. This is a single-agent, single-call P1.

Browser wallet connection/funding, actual Agent API grant integration, tool rounds,
two agents and richer continuous bidding are P2 work. Actual NEAR sponsorship,
cross-chain funding, provider quality/latency and deployment require G1/P3 evidence.
Historical P0's 44-test PARTIAL record remains its own snapshot.
