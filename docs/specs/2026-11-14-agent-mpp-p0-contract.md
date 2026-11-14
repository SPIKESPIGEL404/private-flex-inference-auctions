# Agent MPP integration — P0 contract with sponsored-gas amendment

Date: 2026-11-14. Status: implemented controlled prototype; concrete proposal for
review. Product directions in the [integration spec](2026-11-14-agent-mpp-inference-integration.md)
remain confirmed. The user confirmed **native NEAR, metered prepay/refund,
project-paid inference payment/refund gas, and separation of order expiry from
chain transaction validity**. Other policy defaults remain choices for review.
The 44-test v1 implementation and its acceptance record describe the earlier
agent-paid-gas snapshot. This amendment changes the contract, not that historical
evidence or the implemented payment method. No real transfer, inference or
deployment is authorized by this document.

## Decision closure

| Decision | Concrete v1 proposal | Evidence / remaining gate |
| --- | --- | --- |
| R1 pricing | Metered maximum prepayment; verified usage settles at frozen provider rates + existing platform fee. Fixed order price remains a future distinct contract. | Existing owning settlement uses actual usage; integer prototype covers maximum and actual charge conversion. |
| R2 refunds | Normal unused principal and definitive pre-dispatch failure refund in native NEAR to original authenticated agent. Every positive refundable unit is owed; no dust cutoff or forced platform credit. Project pays merchant refund gas. | Refund plan + independent reverse-transfer verifier implemented. Durable merchant executor/outbox required in P1. |
| R3 bidder | Two layers; 25% unallocated task authorization retained for later rounds; no assumed total round count. Uncertain liabilities remain reserved and refunds are unavailable until confirmed. Bid includes the frozen service fee; project gas is excluded from the buyer's budget. | Integer mapping/reference selector demonstrated in historical v1. New budget/route behavior needs corresponding implementation tests. |
| R4 reservation | One supply lease per logical call; 75s hold, 60s payment window, 2s conservative clock allowance. New admission requires its deadline and lease still valid; clock expiry alone never proves payment was absent. | Owning supply reservation and cash-purpose interfaces frozen separately; not implemented by HTTP sequencing. |
| R5 funding/asset | Supported 1Click source assets -> `DESTINATION_CHAIN` -> each agent's actual NEAR balance. Native NEAR 24 places is the sole hot-path asset. Equal source principal; remainder stays source wallet. Source fees and resulting target amounts shown per leg. | Pure allocation contract covers source precision. Real quote asset IDs/minimums/fees remain runtime preflight, not hardcoded. No FT registration needed on this route. |
| R6 API/location | Browser fx -> authenticated Proxy `/v1/chat/completions`; one hosted bidder/executor per agent. Login owner, task grant and chain payer binding remain separate. No raw transfer/signing relay exposed to browser/tools. | P0 package is a method library only. PR #5 runtime still needs P1 native transport integration. |
| R7 real run | Two agents, one seller, one tool-capable model, at least one tool continuation. **Current external spend/deployment allowance = zero**; a later bounded run plan must set source principal, fees, gas, refunds and provider limits. | This is a P3 gate, not an unresolved P0 algorithm. No real trial is silently started. |
| R8 speed | Usable terminal end-to-end; TTFT separate; p95 forecast valid for same request scope and <=30s old. No v1 latency SLA; hard-guarantee-only requests decline. Preference and urgency change deterministic scores within all hard caps. | Policy v1 implemented; two service timings in tests are explicitly simulated. No claim of paying more for real speed. |
| R9 method | Native NEAR principal from agent, gas from project; retain original order binding and global consumption, add a versioned sponsored route. NEP-366/relayer or actual wallet sponsorship are candidates, not yet accepted implementations. | Historical v1 verifies only agent-signed plain Transfer + NEP-413 assignment. It does not verify a relayer's inner transfer. G1 must qualify the selected sponsored route. |

## Prices, precision and delivery

The service denomination is NanoUsd; provider caps are MicroUsd. With frozen
platform fee `F`, the largest provider cap is `floor((serviceCapNano-F)/1000)`;
reject when the service cap is below `F`. The owning cost meter still derives
maximum and actual provider charges; this package must not estimate token usage
or replace that authority.

Freeze an exact rational rate represented here as positive integer
`nanoUsdPerNEAR` and its source/version/validity before issuing a payable quote.
The project merchant makes that firm conversion offer and bears later FX risk.
The prototype tests injected rates; it has no market-price oracle. An actual
merchant FX issuer and bounded exposure are P1/P3 configuration gates. If greater
rate precision is required, introduce a new rational-rate schema/version rather
than truncating a live price.

`P = ceil(maxServiceNano * 10^24 / nanoUsdPerNEAR)` yoctoNEAR.
`C = ceil(actualServiceNano * 10^24 / nanoUsdPerNEAR)` under the same frozen rate.
The service cap comparison uses `ceil(P * nanoUsdPerNEAR / 10^24)`, including
rounding, never raw yoctoNEAR. Project gas has its own operational ledger and
funding/eligibility check; it is not added to the agent's authorized debit. No
float money.

The buyer reserves the maximum service principal and any other explicitly
authorized buyer charges. Inference payment and service-refund gas are project
infrastructure costs, including fees from failed or late payments; they cannot
be recovered through an extra agent debit or reduced principal refund. This
does not automatically sponsor source-chain cross-chain funding/recovery fees.
The native-only route uses an existing merchant account and no FT storage leg.
Agent balance after storage locks/principal reservations and project sponsor
funding are checked independently. No agent payment-gas floor is required by
the sponsored route. Pending/sent/unknown refunds are unavailable to later calls.
The original meter/provider cost records remain unchanged.

Normal metered delivery charges verified usage for a valid text finish, complete
valid tool call or declared output-limit terminal. Output-limit is recorded;
incomplete tool arguments cannot be executed. Definitive pre-dispatch failure:
`C=0`, refund all principal. Post-dispatch failure or cancellation: use original
owning adjudication and verified liability; absent conclusive evidence keep `H`,
never assume zero provider cost or release budget. A correct task outcome is not
guaranteed by successful model delivery. There is no latency breach refund in
v1 because there is no accepted latency commitment; ordinary usage refunds and
failure liabilities still apply.

All transitions preserve `P=C+H+W+R`. Refund principal is denominated in the
original asset and rate. Merchant gas is a separate project expense. Refunds
remain payable after buyer grant revocation and never automatically bridge back
to the original user's source chain. A refund operation may not exceed the
locked remaining `W`; split/partial refunds require separate stable operation
IDs under the same order fence.

## Buyer policy v1

Fixed native request bytes/hash, model/tools/output limits and original call
start time survive retries. All owner auth, task authorization, capabilities,
per-call bid, native principal caps and new-operation/admission deadlines filter
candidates first. Project sponsor eligibility is a separate required condition.
The reference selector assumes that caller has already checked owner/model
authorization and supplies comparable forecasts; it does not establish them.

For an eligible quote, compare expected service cost + buyer-borne route fee +
`lambda * urgency * totalUsableMs` + explicit risk penalty, all in NanoUsd.
`lambda` = 1/20/100 NanoUsd per ms for save/balanced/fast; urgency multiplier 4
when remaining estimated duration consumes at least half the remaining time,
otherwise 1. These are reviewable deterministic defaults, not calibrated values.
All time stages are disjoint: elapsed wait + future payment + admission + full
generation to usable terminal + delivery. Buyer-borne gas is zero on the
sponsored route; record real project gas separately. Relay/sponsorship delay
still counts. Do not add TTFT to full generation.
Ties use stable quote ID. No fresh eligible quote -> wait; deadline/wait budget
exhaustion -> stop. Tick <=1Hz, one outstanding operation per logical call.

Automatic bid revision may increase only toward a fresh eligible service ask,
within the current task allocation and hard service cap; the selector itself
returns accept/wait/stop, and does not manufacture an ask or speed tier. Manual
override pauses automatic revision; resumption is explicit and CAS fenced.
P1 wires this contract to #6 bid revisions, preserving original absolute times.

## Native payment and recovery

The authoritative owner/agent binding freezes agent ID, actual NEAR payer,
refund payer, network, version and grant revision. A new binding is a new
authorization; pending old liabilities remain attached to the old version.

Before starting a new payment, persist original call/quote/revision/task
principal reservation, immutable payment operation key, intended merchant/amount
and project sponsorship association. New operations must begin within their
authorization/window. Historical v1 policy permits merchant transfer and NEP-413
only; the selected sponsored route needs separately reviewed wallet/grant
support. NEP-413 cannot substitute for a delegated-transaction signature. No
arbitrary calls/signing relay is opened. Account policy `budget` is not a native
task budget. Only the trusted narrow executor can use the grant.

The native readiness guard requires a fresh final NEAR-chain account balance,
correct network/account/native asset/24-place denomination, and spendable native
amount after protocol storage locks and all project reservations. Intents and
wNEAR FT balances cannot satisfy it. Its evidence must be produced by the trusted
reader and wallet writer, not a caller-supplied balance label.

New Agent policies retain `confidential:true` as required by current Agent API
policy signing, with `actions:[]` to authorize no Intents spend actions. Native
transfer permissions and withdrawal-shaped destination checks remain separate.
The official OpenAPI allows the empty action array; its Policy schema is pinned
and validated in tests. This does not claim a live owner/grant acceptance or
privacy for native transfers. Hosted Agent API beta is mainnet-only; testnet
objects in the package are controlled fixtures.

In historical v1, after the original transfer hash is durably recovered, sign the exact binding
message described in the [package README](../../services/mpp-near-direct/README.md).
RPC verification uses final transaction and complete receipt graph, exact
single native Transfer, original key and original challenge. The signature is
an explicit payer assignment, not an on-chain invoice. Enforce global consumption
in the same original money transaction. Malicious double assignments compete
for that one consumption; they never authorize two services.

The sponsored route must separately establish principal payer = original agent,
actual merchant receipt, original order/authorization, and project fee payer.
A relayer's outer signature is not proof that it paid inference principal.
Version the method/route and proof schema; do not feed delegated transactions
into the old plain-Transfer verifier and label it sponsorship support.

Native sender operation unknown -> recover original key/correlation/tx; never
generate another operation key. Signature failure after money moved -> keep the
payment liability and recover the original signature or refund after chain
reconciliation; do not pay again. Expired credential recovery is separate from
MPP's ordinary expiry path. Payment final but lease/authorization expired ->
record liability, no admission, refund according to original contract. Receipt
success is not sufficient to dispatch: original ledger projection and one valid
admission command must also be ready.

## Order expiry and original-operation recovery

Order/quote expiry stops new procurement/payment operations and new execution
admissions. It does not require an already authorized chain transaction to expire
at the same wall-clock instant. Protocol nonce and validity rules still apply;
if a selected mechanism supplies a cutoff block, verify it independently.

An operation known never signed/dispatched can close and release its original
reservations. Signed, dispatched, possibly sent or unknown operations keep the
same identities, principal and sponsor liabilities for recovery. Expiry is not
proof of no payment and never authorizes a replacement principal transfer.
Recovery after expiry is reconciliation, not a new procurement window.

If matching money settles/is discovered after original terms or capacity lose
admission validity, record and globally consume the real movement as a liability,
do not dispatch, and refund the full principal to the original agent. Project
pays gas. Already admitted execution follows original recovery/adjudication;
expiry alone does not prove cancellation or justify a second refund.

## F1 superseded by user decision; G1 sponsor-route qualification remains

Historical F1 found that Agent API SDK 0.9.1's `{to,amount}` transfer charges gas
to the agent without the earlier proposed per-operation fee/lifetime bound.
That finding remains accurate for the historical route. The user has now changed
the economic and deadline contract: project pays gas, and original transactions
need not expire with the order. F1 is therefore superseded as a product
requirement, **not fixed by new SDK functionality**. Agent principal caps remain
hard constraints.

G1 requires proving that the chosen wallet/relay route actually charges project
funds for gas, with zero extra gas debit/advance by the agent; authenticates the
original agent principal authorization and inner movement if delegated; recovers
original sends without duplicate principal; handles sponsor outages and late
money/refunds; and records project funding, operational limits and actual fees
separately. Unavailable sponsorship rejects/waits rather than falling back to
agent-paid gas. An estimate is not presented as a chain-enforced fee maximum.

Setting legacy gas inputs to zero while still calling `nativeNearTransfer` does
not implement sponsorship. NEP-366 is a candidate with a relayer and a separate
cutoff block, but current wallet API support, latency, grant scope and proof
verification must be established. This spec revision does not implement it or
reclassify the historical 44-test P0 PARTIAL result. New P0/P1 and real-route
acceptance must use the amended contract and separately bounded run plan.

## Official contracts checked

- [MPP custom methods](https://mpp.dev/payment-methods/custom): Method, client,
  verification and Receipt extension. Pinned actual package: mppx 0.17.0.
- [NEP-413](https://github.com/near/NEPs/blob/master/neps/nep-0413.md): Borsh
  payload, nonce, relying party and full-access Ed25519 signature.
- [Agent native accounts](https://docs.agentsonintents.com/integration/agent-api/native-accounts):
  native balance, native transfer/sign-message switches and limits that do not
  apply. Pinned actual package: Agent API SDK 0.9.1.
- [NEAR transaction RPC](https://docs.near.org/api/rpc/transactions): FINAL and
  receipt lifecycle. The trusted RPC assumption is explicit.
- [1Click quote](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote):
  destination-chain delivery. This package never issues a live quote or transfer.
- [Policies & Limits](https://docs.agentsonintents.com/integration/agent-api/policies-and-limits)
  and [official OpenAPI](https://api.agentsonintents.com/openapi.json): new-policy
  confidentiality requirement and structurally valid native-only policy. The
  checked schema and complete-document hash are pinned in the test fixture.
- [NEP-366](https://github.com/near/NEPs/blob/master/neps/nep-0366.md): candidate
  project-paid relay, original sender authorization and independent cutoff block.
  Not an assertion of support by the current SDK or v1 payment verifier.
