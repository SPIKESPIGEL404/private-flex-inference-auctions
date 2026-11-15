# NEAR Intents payments in the existing auction and playground

This integration extends the existing single-seller AuctionMarket and
market-playground. It does not use the standalone paid-chat financial tables or
the older Market-credit funding endpoint. The original native NEAR auction
retains its metered prepayment/refund contract.

## Purchase contract and price authority

Each agent's existing autobidder submits a price multiplier and an explicit
service spending cap. The original `clearRound` first-price rule selects the
winner from eligible buyers for the same exclusive supply pool. The winner's
frozen contract fixes the request body hash, service class, token bounds, bid,
USD service amount, USD/NEAR reference, NEAR principal and payment/admission
deadlines. Increasing the task budget does not increase its economic bid.

For `auction-fixed-request-v1`, the price is the contract's **maximum** service
amount, calculated with the original integer pricing formula and the winning
bid multiplier. This is a token-bounded request bundle. On verified completion,
the full frozen price is charged. Actual usage is validated and recorded; it
does not reduce the price. A tool continuation purchases another request.

Only the winning allocation creates an official `nearintents.charge` EXACT_OUTPUT
quote. Its destination amount equals that allocation's NEAR principal. The
official challenge binds allocation ID, contract hash and exact request hash;
the source quote never replaces the auction price. There is no second merchant
invoice, internal credit purchase or second spendable agent balance.

## Request and wallet flow

1. The owner signs in with the existing NEAR wallet/NEP-413 flow. The owner can
   create up to two independent ordinary EVM agent wallets, within the global
   operator cap. These agent keys are held in the trusted service's private
   durable journal, never in the model or browser. They are custodial keys;
   merchant, source-spend and gas limits are enforced by this service, not an
   EVM smart-account policy.
2. Using an injected EVM wallet, the owner sends USDC and ETH to each agent on
   Arbitrum. The UI verifies the selected network/account. A durable funding
   intent precedes the popup, and reconciliation binds the original transaction
   hash, sender, token, destination and amount, including reverted commands.
   ERC20 success also requires the exact delivered Transfer event.
3. The page's real fx/bash agent calls `/buyer-api/v1/chat/completions`. Existing
   auction headers identify its grant, bid and exact native request. Waiting
   buyers receive 202; an unpaid winner receives the official 402 challenge.
4. The trusted agent signer checks the original grant, source amount per call
   and in total, gas per transfer and in total, merchant/refund address, and
   estimated settlement time against the remaining payment window. It signs
   and persists one original transfer before broadcasting. Owner auth remains
   separate from the `Payment-Authorization` credential.
5. Retrying the **same Chat Completions request** presents that credential. The
   official SDK verifies settlement. SDK hash consumption and the existing
   AuctionMarket payment movement commit in one PG transaction. Settlement
   polling holds no Market financial/capacity lock.
6. The existing provider dispatcher makes one bounded, original NEAR AI Cloud
   request through its attested SDK path. Completion, usage and provider cost
   settle in the existing Market. The original SSE/result and official MPP
   Receipt replay without another purchase or inference.

The first signer profile is **Arbitrum USDC + ETH gas → native NEAR merchant
delivery through 1Click's wrap.near asset**. Other chains/tokens require reviewed
signer and fee support; this UI does not claim all-chain funding. Owner NEAR
login and EVM funding may use different wallet accounts.

## Cost, speed and readiness

USD task/agent/owner caps constrain the frozen merchant **service** price. The
source USDC quote includes route/exchange costs; ETH gas is additional. Independent
source and gas caps constrain those effects. The UI shows both amounts and the
original destination receipt. An observed source token balance is never labeled
as a spendable NEAR balance. Eligibility conservatively requires enough source
USDC and ETH to cover the configured per-call caps.

An ETA check is a refusal policy, not a latency guarantee. There is a separate
cross-chain settlement for every inference call; this design does not provide
session/channel frequency or native-NEAR payment latency. The current capacity
slot remains held during the winner's payment, so a slow route reduces auction
throughput. Creating the quote makes bounded 1Click HTTP calls inside the
allocation transaction; a slow quote may temporarily delay other Market writes.
Moving quote preparation outside that lock is a later optimization.

The live runtime reuses Cloud catalog qualification, a bounded project-funded
paid API-credit probe, the existing provider cost/call allowance and fresh FX.
The probe counts toward that allowance. Missing/stale supply, FX, source funds
or gas prevents a new purchase. This integration's live provider is the existing
NEAR AI Cloud adapter; it does not establish that a self-hosted Chutes supply
has been settled through this new payment rail.

## Failure, refund and exit behavior

Successful requests have **no usage rebate**. Paid terminal failure, late
settlement or revoked admission retains the full merchant-asset refund
liability and stops new sales until reconciliation. Automatic merchant refunds,
reverse swaps into the source token and refund-completion tooling are deferred.
Do not describe such an order as refunded. Unknown payments/provider effects
stay unresolved and never generate replacement purchases automatically.

Freezing an agent prevents new authorized work and fences unused allocations.
An already-started original payment may still settle and become refund-only.
The owner can separately withdraw **unspent source USDC/ETH** after freezing.
This is not a refund of merchant proceeds. Exit shares the inference wallet's
nonce lock, persists original signed bytes before broadcast, and recovers the
same command/hash rather than creating a second transfer. It permits at most
eight owner-triggered exits, each with the displayed gas cap; exit gas is
additional to the inference gas budget. Funding gas remains possible for a
frozen agent's recovery. ETH sweep leaves any unused maximum-fee reserve behind.

The original PG database, instance binding and private agent-wallet journal must
remain together. Missing/mismatched journals, changed configuration, metadata
schema drift or another active runtime fail closed. No migration of funded
native-auction allocations is attempted. Reloading the page resets task memory
and files, queries original financial history, and starts no new purchase.

## Scope of acceptance

See the [acceptance record](../acceptance/2026-11-15-nearintents-auction-ui.md)
and [operating instructions](../nearintents-auction-operations.md). Controlled
tests exercise real PG, the owning Rust schema verifier, official MPP SDK,
cryptographic EVM signing and real fx/bash tasks. Chain/1Click/model responses
are owned fixtures. They do not establish real settlement latency, minimum
swap economics, native NEAR unwrapping or real Cloud delivery for this profile.

No production environment is switched by these changes. The live profile needs
an explicit reviewed fingerprint, funded source wallets and a separately
authorized real-spend acceptance run.
