# PR20 + PR24 bounded Mainnet integration

Updated target approved after discussion: integrate real Mainnet tasks, native
payments and refunds, then expose a separate bounded Mainnet entry. Keep the current mainnet-wallet/P2 entry intact.
This file records the integration contract; deployment acceptance is separate.

The browser owns fx/just-bash task memory using PR24. AuctionMarket owns bids,
allocation contracts, budget/native liability, result admission and settlement.
PR20 supplies OutLayer wallet operations and independent chain/policy verification;
its separate Cloud financial harness and its server-side task journal do not
become a second financial authority for auction orders.

Ordinary Mainnet wallets authenticate owners. Each owner creates two distinct
OutLayer agent wallets, installs and verifies their merchant-only policy before
funding, then explicitly starts a task under an owner/agent/task budget. Agent
wallet credentials stay in the trusted service and never enter browser/model
inputs. Existing mainnet agent wallets, keys and balances are not migrated.

The live server is a separate bounded-mainnet mode with real adapters. Local
fixture gates remain closed to real broadcasts. HTTPS origin, NEP-413 network
binding, owner isolation, Secure cookies, body bounds and rate/agent limits are
required. Native payment gas is paid by the agent; merchant refund gas is paid by
the merchant. Chain fees and provider cost retain distinct evidence/accounting.

Every payment/refund/provider operation has one immutable original operation.
Persist an intent before outbound effects; lost ACK/unknown never authorizes a
new payment POST, new inference call, replacement nonce or released liability.
Late/fenced payments are refund-only. Owner freeze/revoke prevents new purchases
without preventing recovery/refund of an already paid original order. A browser
refresh never restores tools or starts purchases; financial recovery continues.

NEAR AI Cloud is the first live provider for this integration. Freeze its public
tariff and response/model evidence scope before admission. Capture and verify the
original provider response and native usage before settlement. Market auction
charges differ from the upstream Cloud account invoice. Mainnet quotes require a fresh, explicitly sourced USD/NEAR observation frozen
into each allocation contract; test accounting conventions are rejected. The
project allowance starts bounded at USD0.01 with unknown calls retaining their
reservation; never reset it on restart. No stronger model-weight proof is implied.

Deployment must build frontend and binaries from the merged source rather than
relabel the prior archive. Include the shared client task module in Docker build
contexts. Keep the no-pre-launch image deployment, pin GHCR digests, use a new
Mainnet data volume/database, and compare the live CVM manifest immediately before
updates. Preserve original services/volumes and provide an additive rollback.

Acceptance requires controlled regression, owning PostgreSQL concurrency and
unknown/replay cases, fresh image builds, a real Mainnet owner/agent setup, real
provider task/tool continuation, FINAL payment/refund/gas evidence and restart
replay with zero added effects. Browser wallet-extension acceptance and full
hardware/channel verification must be reported only when actually performed.

Mainnet effects remain disabled until a reviewed deployment plan pins merchant,
service, FX source, owner/agent/call principal limits, gas reserves, provider
allowance and deadline. No Mainnet spending amount is approved by this document.

## Implemented candidate

`auction/live/` connects the AuctionMarket to the OutLayer native wallet, merchant
signed-byte refund outbox and attested NEAR AI Cloud SDK. `auction/server.mjs`
exports separate controlled and bounded-Mainnet constructors; setting a live flag
on the controlled constructor cannot enable money. Mainnet requires a reviewed
plan hash in both configuration and `ENABLE_BOUNDED_MAINNET`, a dedicated schema,
Mainnet RPC/owner login and exact HTTPS origin. The model cannot call wallet setup
or receive a wallet credential. Native agent payment gas and merchant refund gas
are distinct from inference principal.

The owner flow is NEP-413 login → create an unfunded wallet → install policy in the
owner wallet → independent chain/API policy readback → create owner/agent root
budgets → explicitly fund → run a browser-memory task. One pending funding intent
per wallet prevents automatic resubmission after cancellation or lost wallet ACK;
the owner can reconcile the original hash. Funding never grants a new inference
budget. Task grants, global payment count, provider allowance and all unknown
reservations survive process restarts. A frozen agent remains visible to its
owner for financial recovery.

New quotes require fresh FINAL native balance, a fresh provider/merchant readiness
observation and a sourced FX observation at most five minutes old. The provider
preflight checks SDK attestation, model availability and public catalog prices no
higher than the reviewed service rates. The merchant must have the correct
FullAccess refund key and enough balance for existing principal liability and
reserved refund gas. Readiness/FX failure prevents new purchases while original
recovery/refunds stay available. FX observations are append-only and each
allocation freezes its own conversion. The initial canary uses operator-supplied
FX observations; a continuously refreshed production oracle is not included.

Input admission accepts bounded text/bash requests with a deliberately conservative
byte/template estimate. This is **not exact tokenizer qualification** or proof of
Cloud's hidden template/checkpoint. Verified usage outside the signed contract is
a full-principal refund, never a silently clamped bill. The project cost budget
reserves against the reviewed upper tariff; verified native usage is then recorded
against the dispatch-time catalog snapshot. These are local admission controls,
not an upstream invoice or a provider-enforced billing cap.

Gas above the reserve is recorded without rejection or clamping, freezes the
relevant budget scopes, and makes a paid unstarted order refund-only. Gas can be
recorded even when the chain proves a fee but has not yet proved the principal's
outcome. An overrun is recorded separately; it never raises future authorization.
No original-order liability is released merely because the buyer's page closed,
the run deadline passed, or an HTTP request failed.

## Remaining live gates and limits

Controlled PG tests use real cryptography, the real fee/principal verifiers and
signed refund bytes against owned chain fixtures. They do not establish hosted
OutLayer policy semantics, current Cloud availability, wallet-extension UX or a
Mainnet task. Those require the funded canary and its original transaction IDs.

SDK 0.3.0 keeps the attested request/response binding in process memory. If the
process dies after capturing a response but before durable verification, recovery
must remain Unknown. The adapter never invokes the model again to reconstruct it.
Verified results persist and replay; signature retries before process exit use the
original SDK capture. Durable offline response verification is a separate follow-up.

The owner can stop an agent, wait for every original allocation to finalize, and
withdraw its available native balance above the storage/gas floor. A separate
owner-only policy must be installed with the next on-chain version and verified
before the executor sends. Withdrawals share the same sender lock as inference
payments, have one active original intent per wallet, and never resend on a lost
API ACK. The recipient is always the authenticated original owner. Future credits
can be withdrawn through a new explicit exit after the original exit is FINAL;
there are at most eight owner exit intents per bounded wallet. A pending/unknown
original payment blocks exit. Withdrawal gas is paid by the agent and shown
separately from inference. The native gas/storage floor intentionally remains.
Policy update version semantics were checked against OutLayer's
[official API specification](https://github.com/out-layer/api-spec/blob/main/openapi.yaml).

A merchant key must never be reused with a fresh/refilled effect journal. Preserve
the original Mainnet volume and storage key during upgrades and rollback. Recovery
must keep the same original plans, SDK results and wallet credentials. The plan,
budget caps and deadline are immutable for a run; expanding them is a new reviewed
release, not a restart that resets balances.


The live browser transport sends exact native JSON to
`/buyer-api/v1/chat/completions` (also exposed as `/v1/chat/completions`).
Idempotency, agent/grant, bid multiplier, call cap and expiry are separate
headers. None is forwarded into the native inference body. Financial grant,
bid revision, original wallet payment and refund recovery remain Market APIs.
Controlled legacy `/procure` remains compatible. The two-agent fx/just-bash
HTTP acceptance exercises the native chat path with owned model/chain fixtures.


After the original native transfer is independently verified, the wallet endpoint
returns its bound `Authorization: Payment …` value. Native chat retries present
that exact original credential; the proxy checks its challenge, transaction,
NEP-413 signature and persisted operation before releasing the result. A missing
credential returns the same 402 so a lost payment response can recover the
original credential without another transfer. A failure stops the original call
and retains/refunds the existing liability rather than authorizing a replacement.
