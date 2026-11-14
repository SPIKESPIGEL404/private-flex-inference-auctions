# P3 ordinary-wallet native NEAR run plan

Status: **NOT_ACCEPTED**. On 2026-11-14 the user selected ordinary agent wallets,
agent-paid principal and payment gas, native NEAR refunds, and the complete P3
payment loop as the acceptance requirement for baseline B. Agent API credentials
are not a prerequisite. Merge and deployment wait for that acceptance.

## Payment and custody

Each agent has an independent ordinary NEAR key in the owner's encrypted browser
vault. Its private key never enters the model, server, logs or Git. The owner
connects a wallet, creates/restores and backs up agent wallets, funds them, and
authorizes bounded tasks. Intents can prepare funding later; it is not involved
in native inference payments. The dedicated local acceptance wallets are test
infrastructure, not production server custody of the judges' agents.

MPP `bitrouter-near-direct` version 1 binds the original request, quote, agent,
merchant, frozen USD/NEAR conversion and exact native Transfer using NEP-413.
The agent pays the Transfer principal and its own transaction gas. The merchant
pays refund gas separately and owes every refundable yoctoNEAR to the original
agent address. No fee is deducted from that refund. Project-sponsored NEP-366,
gas-key and Agent API executors are not the selected route.

The contract remains usage prepayment and actual-use settlement: prepayment is
an authorization maximum, not a fixed final order price. Only the original
Market cash receipt determines service charge C. With frozen FX and integer
rounding, P = C + H + W + R. Gas is an additional agent expense, outside that
principal conservation equation. A credit-ledger release is not a native refund.

## Durable payment and refund execution

Before broadcasting, persist the exact signed transaction bytes and hash, original
MPP challenge, body/terms digest, authenticated wallet binding, task budget,
principal and gas reserve. A server-side account fence must cover inference
payments and withdrawals together, across browser tabs and process restarts.

Recovery queries the original hash or rebroadcasts the exact original bytes.
A timeout, transaction-not-found, cancelled HTTP request or quote expiry does
not authorize another nonce. Never regenerate a payment with a different
recipient, key, amount, request or FX rate. The merchant refund sender obeys the
same rule. Its history and budget belong to the account, including across key
rotation; the initial implementation pins the signing key. Persisted nonce
highwater prevents a stale access-key response from reusing an old transaction.

Independently verify FINAL, exact single Transfer, original signer, historical
FullAccess permission, entire successful receipt graph, inclusion time and
original MPP assignment. Sum tokens_burnt from that same rooted FINAL snapshot
for actual payment gas. A send acknowledgement alone establishes neither
principal receipt nor gas settlement. Unknown evidence retains the reservation.

Gas reserve is an operational estimate and pre-purchase threshold, **not a chain
gas-price ceiling**. Record actual overrun and stop further purchases. Do not
claim an absolute total-spend guarantee from an estimated native Transfer fee.
Merchant refund gas has its own reserve and stop policy.

## Original Market money authority

Use a separate native-B database/state namespace, with zero initial test credit,
while preserving the existing deployment and historical ledger. Keep P1/P2
controlled and synthetic paths ineligible for live serving.

Verified native payment can credit only its original earmarked order. Install
purpose protection and admission checks in the same original PostgreSQL
transaction as cash reservation, kernel admission and dispatch outbox. Check
body, purchase controls, native request ID, dispatch key, budget, wallet binding,
quote expiry, capacity lease and applied balance projection. A generic USD top-up
followed by an unrestricted purchase is insufficient.

The original cash receipt atomically determines C, outstanding W and protected
credit release. Native R increases only after the merchant's original refund is
independently FINAL. Late payment or definitive pre-admission rejection creates
a full refund obligation without dispatch. Unknown execution or metering keeps
its hold; it cannot be treated as zero charge.

## Supply readiness and qualification

Readiness is a fresh, cached observation of an active CPU/GPU-verified Chutes
instance. It is separate from market capacity, paid admission and workload
qualification. Offline/warming/stale/unverified supply must refuse before a new
payment. Reading readiness must not invoke the model or keep a replica warm.
Display the approximately one-hour idle shutdown and ten-minute cold start.

The current real B tokenizer accepts text Chat only, and its throughput profile
covers a specific qualified request size/output estimate. Before payment, use
the pinned tokenizer and the same catalog/candidate eligibility as real
admission. Do not generalize P2 synthetic tokens or one calibration to arbitrary
agent/tool requests. Complete real tool-message/tokenizer/provider support and
qualify each supported workload before claiming full P3 task acceptance.

## Bounded mainnet acceptance

Three dedicated public addresses are recorded in the local acceptance
configuration. The requested funding is 0.01 NEAR each, 0.03 NEAR total. Private
keys stay in restricted local files and will not be embedded in source or image
layers. Funding availability is checked read-only; no implicit top-up occurs.

Before sends, freeze the run's actual FX source/time/rate, original request scopes,
per-call and per-agent principal authorization, gas reserve/floor, merchant refund
budget, provider call/output/USD limits and deadline. Calibration consumes its
own explicit provider allowance. No extra provider instances are provisioned
implicitly.

Run two independent real fx tasks through MPP chat/completions, including a tool
continuation. Preserve evidence connecting owner funding, agent principal and
gas, original order, Market admission, actual provider usage/result, signed
financial receipt and original-asset merchant refund. Exercise interruption and
recovery without duplicate purchases, model execution or refunds. Browser
closure cannot discard a refund obligation.

Independent gpt-6-astra review checks the actual task artifacts and financial
chain. Only then merge to main and deploy through Phala CLI, preserving existing
CVM ownership, sealed environment, volumes and custom-domain services.

## Current evidence boundary

The ordinary native sender and FINAL principal/gas verifier are component work.
They are not yet the browser → MPP → original Market → provider → native refund
integration. Signed USD credit receipts and readiness checks remain useful lower
layers. Neither component tests nor test-credit settlement satisfy real P3.

[Current native contract](2026-11-14-agent-mpp-p0-contract.md) ·
[Ordinary NEAR SDK signer](https://near.github.io/near-api-js/classes/signers_key_pair_signer.KeyPairSigner.html)
