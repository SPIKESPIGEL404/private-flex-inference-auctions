# Agent MPP integration — current native-payment contract

Date: 2026-11-14. The user's latest decision is **agent-paid inference
principal and payment gas**, with merchant-paid refund gas. Use the documented
Agent API native Transfer path; do not move agent keys into project custody.
Native NEAR (24 places), metered prepay/refund and independent order/chain
validity remain confirmed. This supersedes the previous project-sponsored gas
amendment. Historical v1/v2 acceptance records keep their original scope; no
record becomes a live-payment or P3 PASS by changing this contract.

See the [integration spec](2026-11-14-agent-mpp-inference-integration.md) and
[P3 plan](2026-11-14-agent-mpp-p3-run-plan.md). External spending is governed by
the later concrete run plan, not by this contract.

## Decision closure

| Decision | Concrete v1 proposal | Evidence / remaining gate |
| --- | --- | --- |
| R1 pricing | Metered maximum prepayment; verified usage settles at frozen provider rates + existing platform fee. Fixed order price remains a future distinct contract. | Existing owning settlement uses actual usage; integer prototype covers maximum and actual charge conversion. |
| R2 refunds | Normal unused principal and definitive pre-dispatch failure refund in native NEAR to original authenticated agent. Every positive refundable unit is owed; no dust cutoff or forced platform credit. Project pays merchant refund gas. | Refund plan + independent reverse-transfer verifier implemented. Durable merchant executor/outbox required in P1. |
| R3 bidder | Two layers; 25% unallocated task authorization retained for later rounds; no assumed total round count. Uncertain liabilities remain reserved and refunds are unavailable until confirmed. Bid includes the service fee; agent payment gas is separately reserved and recorded as non-refundable buyer expense. | Integer mapping/reference selector demonstrated in historical v1. New budget/route behavior needs corresponding implementation tests. |
| R4 reservation | One supply lease per logical call; 75s hold, 60s payment window, 2s conservative clock allowance. New admission requires its deadline and lease still valid; clock expiry alone never proves payment was absent. | Owning supply reservation and cash-purpose interfaces frozen separately; not implemented by HTTP sequencing. |
| R5 funding/asset | Supported 1Click source assets -> `DESTINATION_CHAIN` -> each agent's actual NEAR balance. Native NEAR 24 places is the sole hot-path asset. Equal source principal; remainder stays source wallet. Source fees and resulting target amounts shown per leg. | Pure allocation contract covers source precision. Real quote asset IDs/minimums/fees remain runtime preflight, not hardcoded. No FT registration needed on this route. |
| R6 API/location | Browser fx -> authenticated Proxy `/v1/chat/completions`; one hosted bidder/executor per agent. Login owner, task grant and chain payer binding remain separate. No raw transfer/signing relay exposed to browser/tools. | P0 package is a method library only. PR #5 runtime still needs P1 native transport integration. |
| R7 real run | Two agents, one seller, one tool-capable model, at least one tool continuation. **Current external spend/deployment allowance = zero**; a later bounded run plan must set source principal, fees, gas, refunds and provider limits. | This is a P3 gate, not an unresolved P0 algorithm. No real trial is silently started. |
| R8 speed | Usable terminal end-to-end; TTFT separate; p95 forecast valid for same request scope and <=30s old. No v1 latency SLA; hard-guarantee-only requests decline. Preference and urgency change deterministic scores within all hard caps. | Policy v1 implemented; two service timings in tests are explicitly simulated. No claim of paying more for real speed. |
| R9 method | Native NEAR principal and payment gas from agent; retain exact Transfer, NEP-413 order binding and global consumption. Use Agent API native transfer, not NEP-366 or project-hosted gas keys. | Historical v1 verifies only agent-signed plain Transfer + NEP-413 assignment. It does not qualify the live SDK/wallet or actual gas accounting. G1 must qualify the native API route. |

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
rounding, never raw yoctoNEAR. No float money.

Agent payment gas is separate from inference principal. Before dispatch, reserve
service principal plus a conservative gas allowance under the same task/agent
money fence, and keep a native gas floor after storage locks. Include estimated
gas in comparable buyer cost. Agent API native Transfer has no caller-specified
gas-fee ceiling: reserve is an operational estimate, not a chain-enforced cap.
Record FINAL actual gas even above estimate, stop new purchases on overrun, and
keep unresolved liabilities held. Actual fees count against subsequent task and
agent availability. Merchant refund gas belongs to its own operational budget.

Service settlement and refunds cannot reset payment-gas expense. A payment that
fails or arrives late may burn gas. Full principal refund leaves that gas spent.
Do not subtract merchant refund gas from the principal owed. Cross-chain funding
fees have separate records and authorization. Intents/wNEAR balances cannot
satisfy native-payment readiness.

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
candidates first. Agent native balance and gas reserve are additional required conditions.
The reference selector assumes that caller has already checked owner/model
authorization and supplies comparable forecasts; it does not establish them.

For an eligible quote, compare expected service cost + buyer-borne route fee +
`lambda * urgency * totalUsableMs` + explicit risk penalty, all in NanoUsd.
`lambda` = 1/20/100 NanoUsd per ms for save/balanced/fast; urgency multiplier 4
when remaining estimated duration consumes at least half the remaining time,
otherwise 1. These are reviewable deterministic defaults, not calibrated values.
All time stages are disjoint: elapsed wait + future payment + admission + full
generation to usable terminal + delivery. Include estimated agent payment gas
in comparable route cost and actual fees in durable accounting. Payment/API
and finality delay still count. Do not add TTFT to full generation.
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

Before a new payment, persist the exact API request, immutable idempotency key,
original order/challenge, agent/grant/binding and principal/gas reservation.
Mark the operation possibly dispatched BEFORE the HTTP request. Save its original
correlation ID before returning. Missing ACK may recover only the same key/body
under the API contract; after correlation is known, query that operation.
NEEDS_REVIEW stops automatic redispatch. Expiry does not create a replacement
payment window. Raw signed bytes are not returned by this API and are not claimed
as a local artifact. No alternate signer, raw signing or arbitrary call is open.

A native policy allows only merchant transfers and the MPP NEP-413 recipient.
Account-policy USD budget/owner approval are not native task guards. The trusted
executor enforces task totals in addition to provider asset/rate limits.

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

After the original transfer hash is durably recovered, sign the exact binding
message described in the [package README](../../services/mpp-near-direct/README.md).
RPC verification uses final transaction and complete receipt graph, exact
single native Transfer, original key and original challenge. The signature is
an explicit payer assignment, not an on-chain invoice. Enforce global consumption
in the same original money transaction. Malicious double assignments compete
for that one consumption; they never authorize two services.

G1 establishes the original API operation and agent authorization, exact native
Transfer, merchant receipt, complete FINAL receipt graph and actual agent gas.
NEP-366 and gas-key prototype evidence cannot qualify this route. A server FAILED
label, missing tx or timeout is not proof of zero principal: unresolved sends stay
held. Positive failure closure needs original-chain evidence and proof the API
operation cannot later make another valid send. A locally sealed operation that
was never dispatched is the only simple known-unsent release.

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
same identities, principal and gas liabilities for recovery. Expiry is not
proof of no payment and never authorizes a replacement principal transfer.
Recovery after expiry is reconciliation, not a new procurement window.

If matching money settles/is discovered after original terms or capacity lose
admission validity, record and globally consume the real movement as a liability,
do not dispatch, and refund the full principal to the original agent. Merchant
pays refund gas; agent payment gas remains spent. Admitted execution follows
original recovery/adjudication;
expiry alone does not prove cancellation or justify a second refund.

## Current G1: native API and real-payment qualification

The previous project-sponsored contract is superseded by the user's explicit
agent-paid principal/gas decision. This is not a new gas-cap feature in SDK 0.9.1.
Service principal caps remain hard constraints; payment-gas reserve and actual
expense are explicit, separate buyer accounting.

G1 must demonstrate the existing wallet's native permissions and owner grant,
original idempotency/correlation recovery, exact FINAL native payment and gas,
independent global consumption, late/unknown behavior and merchant-funded refund.
The controlled P1/P2 NEP-366 fixture's economics remain incorrect for real NEAR.
Historical snapshots are retained, not relabeled as G1 evidence.

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
