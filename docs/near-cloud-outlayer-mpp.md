# Two independent OutLayer wallets through real Cloud MPP

This opt-in CLI acceptance joins PR #20's OutLayer custody adapter with the
previously verified NEAR AI Cloud MPP proxy. It is a fixed-task financial
integration, not acceptance of the original Market/autobidder, browser owner
onboarding, Chutes, mainnet, or a deployed P3 product.

Each agent owns a different unbound implicit NEAR account and `wk_` credential.
The project never receives the agent private keys. A trusted CLI executor holds
the API credentials and enforces the frozen request, merchant, account budget,
principal cap and gas reserve. OutLayer signs and broadcasts the payment; the
proxy independently verifies FINAL principal and gas before provider admission.
The model never receives wallet credentials.

The agent pays our MPP merchant in native test NEAR. The project Cloud API
account pays the upstream provider. Actual usage at the frozen Cloud tariff is
our customer charge basis; this is not an independently verified provider invoice.
The test exchange convention is one test NEAR per USD, not market FX.

## Scope and recovery

- `p3/outlayer.mjs`, `p3/wallet.mjs`, and `p3/outlayer-native-verification.mjs`
  reuse PR #20 at `e4a47017578b7da807845b6fdf6e2dc35b24ac09`. The last filename
  and the wallet import are adapted to coexist with the local-signing verifier.
- `near-cloud/outlayer-client.mjs` adapts the durable one-POST wallet executor
  to an encrypted SQLite account journal. One process owns that journal; the
  launcher uses an exclusive process lock. Do not launch another executor with
  copied credentials and a fresh journal: the local account budget is not an
  OutLayer-wide cumulative limit. OutLayer's native hosted idempotency is not
  assumed or fault-injected by this acceptance.
- Native transfer attempts are durably marked before the API POST. A missing
  acknowledgement remains Unknown/review and is never automatically re-POSTed.
  A known request UUID/hash is reconciled against its original operation.
- The first MPP challenge is replayed verbatim across retries and port changes.
  An expired quote can be replaced only after a matching durable wallet operation
  is cancelled with zero attempts and no request ID/hash. Its history and price
  reservation remain. A late payment against it is refundable, never admissible.
- A FINAL payment without an available NEP-413 assignment can be registered as
  refund-only. That designation is sticky: a later credential cannot admit
  inference. Repeated refund registration cannot create a second refund.
- Provider dispatch is journaled once under a shared two-call / $0.01 project
  allowance. An unknown provider result retains its reservation. Saved output
  is replayed without another provider call, including after restart.
- Wallets receive policy before funding. The policy permits native transfers
  only to the merchant, caps principal at 0.001 test NEAR and permits NEP-413 only
  for the MPP realm. Account budgets include an explicit 0.01 test NEAR gas
  reserve; actual gas is separately reconciled. This reserve is not a chain-level
  hard gas ceiling. A gas overrun stops later purchases.

## Run and audit

Use Node 24.22.1 or later with the locked dependencies from
`services/mpp-near-direct` and `services/inference-comparison`. Keep the existing
testnet merchant key, Cloud API key and run directory private (files 0600,
directory 0700). The merchant's local testnet key is also the policy controller
for this CLI test; this does not certify a real connected user owner.

```sh
node services/mpp-near-direct/near-cloud/accept-outlayer.mjs \
  --execute-testnet /private/new-run /private/merchant.json /private/near.key
```

The setup ceiling is 0.3 test NEAR including policy deposits, funding and owner
gas reserves. Agent A receives 0.05 test NEAR with a 0.02 account budget; B receives
0.06 with a 0.03 budget. Both execute the fixed text task once. A is frozen after
its payment/signature but before inference and refund. A's new purchase is then
blocked without a Transfer POST while B can still execute. Both finish frozen.
Refund gas is paid by the merchant and is not deducted from agent principal.

Repeat the exact command and preserve all journals to replay/recover the same
run. An abandoned process lock requires checking the recorded process before
manual recovery. Never clear Unknown by deleting a journal, changing wallet
credentials, or choosing a fresh run directory for the same funded accounts.

The following audit reads exported receipts/responses and fresh testnet RPC. It
does not load API/wallet keys, the financial database or persistent RPC caches:

```sh
node services/mpp-near-direct/near-cloud/verify-outlayer-evidence.mjs \
  /private/existing-run /private/fresh-read-only-audit.json
```

It checks four FINAL transfers, original refund destinations, gas payer/amount,
frozen-tariff arithmetic, signed financial receipts, response hashes, visible
answer `4`, independent account identities, budgets and final frozen policies.
The official Cloud SDK verified `provider_tee` responses during execution; the
read-only audit does not independently repeat the encrypted-wire verification.
It also does not independently attest the hosted OutLayer deployment.

The actual evidence is summarized in
[the acceptance report](acceptance/2026-11-14-outlayer-cloud-mpp.md).
