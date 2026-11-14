# Agent MPP integration — P0 contract v1

Date: 2026-11-14. Status: implemented controlled prototype; concrete proposal for
review. Product directions in the [integration spec](2026-11-14-agent-mpp-inference-integration.md)
remain confirmed. The user additionally confirmed **native NEAR and metered
prepay/refund** during this implementation. Other policy defaults below remain
choices for review. No real transfer, inference or
deployment is authorized by this document.

## Decision closure

| Decision | Concrete v1 proposal | Evidence / remaining gate |
| --- | --- | --- |
| R1 pricing | Metered maximum prepayment; verified usage settles at frozen provider rates + existing platform fee. Fixed order price remains a future distinct contract. | Existing owning settlement uses actual usage; integer prototype covers maximum and actual charge conversion. |
| R2 refunds | Normal unused principal and definitive pre-dispatch failure refund in native NEAR to original authenticated agent. Every positive refundable unit is owed; no dust cutoff or forced platform credit. Project pays merchant refund gas. | Refund plan + independent reverse-transfer verifier implemented. Durable merchant executor/outbox required in P1. |
| R3 bidder | Two layers; 25% unallocated task authorization retained for later rounds; no assumed total round count. Current authorization excludes uncertain payments/refunds. Bid includes platform service fee, excludes separately capped gas. | Integer cap mapping and deterministic reference selector implemented. Atomic reservation demonstrated in test-only SQLite, not production PG. |
| R4 reservation | One supply lease per logical call; 75s hold, 60s payment window, 2s conservative clock allowance. New admission requires its deadline and lease still valid; clock expiry alone never proves payment was absent. | Owning supply reservation and cash-purpose interfaces frozen separately; not implemented by HTTP sequencing. |
| R5 funding/asset | Supported 1Click source assets -> `DESTINATION_CHAIN` -> each agent's actual NEAR balance. Native NEAR 24 places is the sole hot-path asset. Equal source principal; remainder stays source wallet. Source fees and resulting target amounts shown per leg. | Pure allocation contract covers source precision. Real quote asset IDs/minimums/fees remain runtime preflight, not hardcoded. No FT registration needed on this route. |
| R6 API/location | Browser fx -> authenticated Proxy `/v1/chat/completions`; one hosted bidder/executor per agent. Login owner, task grant and chain payer binding remain separate. No raw transfer/signing relay exposed to browser/tools. | P0 package is a method library only. PR #5 runtime still needs P1 native transport integration. |
| R7 real run | Two agents, one seller, one tool-capable model, at least one tool continuation. **Current external spend/deployment allowance = zero**; a later bounded run plan must set source principal, fees, gas, refunds and provider limits. | This is a P3 gate, not an unresolved P0 algorithm. No real trial is silently started. |
| R8 speed | Usable terminal end-to-end; TTFT separate; p95 forecast valid for same request scope and <=30s old. No v1 latency SLA; hard-guarantee-only requests decline. Preference and urgency change deterministic scores within all hard caps. | Policy v1 implemented; two service timings in tests are explicitly simulated. No claim of paying more for real speed. |
| R9 method | `bitrouter-near-direct/charge` v1; native Transfer + NEP-413 signed order/transaction assignment + global consumption. No new contract deployment or per-call 1Click. | Independent read-only verifier and pinned official SDK controlled interop pass. Wallet hard fee-bound capability remains a real-activation blocker, F1 below. |

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
rounding, never raw yoctoNEAR. Gas reserves are independently capped in yoctoNEAR
and conservatively valued into the same budget scale. No float money.

Maximum liability includes service, maximum payment fee, and any reviewed
storage cost; native-only v1 requires an already existing merchant account and
has no FT storage leg. The task also retains a native gas floor. Budget reserve
and native balance check are both necessary; neither creates cash. Refund
pending/sent/unknown does not make funds available. The original meter/provider
cost records remain unchanged.

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
per-call bid, native amount/gas caps and hard deadlines filter candidates first.
The reference selector assumes that caller has already checked owner/model
authorization and supplies comparable forecasts; it does not establish them.

For an eligible quote, compare expected service cost + maximum route fee +
`lambda * urgency * totalUsableMs` + explicit risk penalty, all in NanoUsd.
`lambda` = 1/20/100 NanoUsd per ms for save/balanced/fast; urgency multiplier 4
when remaining estimated duration consumes at least half the remaining time,
otherwise 1. These are reviewable deterministic defaults, not calibrated values.
All time stages are disjoint: elapsed wait + future payment + admission + full
generation to usable terminal + delivery. Do not add TTFT to full generation.
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

Before broadcast, persist original call/quote/revision/task budget reservation,
payment operation key and intended merchant/amount. Native policy permits only
merchant NEAR transfer and NEP-413 for the payment relying party; all contract
calls/EVM/Solana signing remain off. Account policy `budget` is not a native task
budget. Only the trusted narrow executor can use the grant.

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

Native sender operation unknown -> recover original key/correlation/tx; never
generate another operation key. Signature failure after money moved -> keep the
payment liability and recover the original signature or refund after chain
reconciliation; do not pay again. Expired credential recovery is separate from
MPP's ordinary expiry path. Payment final but lease/authorization expired ->
record liability, no admission, refund according to original contract. Receipt
success is not sufficient to dispatch: original ledger projection and one valid
admission command must also be ready.

## F1: strict native fee authorization feasibility result

Agent API SDK 0.9.1 accepts `{to,amount}` plus an idempotency key for native
transfer. It exposes no signed-transaction fee ceiling or per-operation maximum
native fee. The native key pays network gas. A fresh balance/fee estimate cannot
prove a hard upper bound through an arbitrarily delayed provider operation.

**Decision: preserve hard budget semantics and keep real broadcast disabled.**
P1 needs a reviewed wallet/signer interface that can enforce the frozen maximum
total native debit, transaction lifetime and original-operation recovery before
signing. It may require extending the wallet provider; an adapter must not merely
rename an estimate as a bound. Alternatively the user could explicitly authorize
a different fee-risk contract in a later revision. No such change is assumed.

NEAR can admit stronger signer designs (for example a protocol-version/lifetime
bounded plain-Transfer fee envelope). This finding is specific to the selected
unmodified SDK route; it does not assert that a hard bound is impossible for all
NEAR signing systems. Such a signer is not implemented or accepted here.

This is a concrete negative feasibility result for using the *unmodified* SDK as
the strict-budget live executor. It does not invalidate native transfer/order
verification or the controlled budget algorithm. It means the original P0 exit
criterion for the complete chosen live route is **not yet satisfied**. Contract
work and controlled prototype can pass while overall P0 remains PARTIAL; P1
dispatch and P3 money remain gated. Do not mark the integration ready by deleting
this blocker.

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
