# P3 native Agent API run plan

Status: user selected agent-paid principal and payment gas on 2026-11-14.
The selected implementation target is Agent API native Transfer. Real P3 remains
NOT_ACCEPTED. This PR publishes completed P0–P2 controlled implementations,
wallet onboarding and current contracts; unfinished P3 runtime work is excluded.
No real transfers or provider calls are claimed by this integration.

## Selected payment and custody contract

- Agent API retains each independent agent wallet and owner grant.
- Native NEAR (24 places) pays inference principal and payment gas.
- MPP `bitrouter-near-direct` version 1 retains exact native Transfer and NEP-413
  original-order binding. Gas is separate from the principal conservation law.
- Merchant pays refund gas; every positive refundable principal unit is owed to
  the original agent. No gas is deducted from refunds or bridged automatically.
- Intents/1Click is a funding preparation leg, outside each inference payment.
- The project does not take custody of an agent FullAccess or gas-key secret.

The user decision supersedes the previous project-sponsored G1 contract.
NEP-366 Transfer debits the outer relayer for both principal and gas; the old
v2 fixtures modelled that incorrectly. They prove controlled wiring only.
Gas-key codecs/qualification tests remain historical component research and are
not a selected signer, a native-route acceptance, or a live G1 PASS.

## Agent fees and recovery

Persist original API request/hash, immutable idempotency key, order/challenge,
agent/grant/binding and principal/gas reserve before any dispatch. Mark possibly
sent before HTTP, then save the original correlation ID. Lost ACK recovery uses
only the same key/body; known correlation uses status reads. NEEDS_REVIEW stops
automatic resubmission. Never change keys, routes or nonces to replace a payment.
The API does not return raw signed bytes; do not claim those are locally stored.

Independent RPC checks the original FINAL transaction, exact single Transfer,
complete receipt graph, original public key and MPP assignment. Record actual
payment gas once as non-refundable agent expense, including failed/late payments.
Service settlement and refunds must not overwrite or release gas expense.
Unknown outcomes retain reservations. Server FAILED text, missing tx or expiry
alone cannot prove zero principal or that the API cannot still dispatch.

Gas reserve is a conservative operational estimate and pre-purchase threshold;
Agent API has no caller-provided fee ceiling. Freeze the estimate's provenance
and gas floor in the plan. Actual overrun is recorded, blocks new purchases and
never disappears to make a budget look compliant. Service principal caps remain
hard. Source fees, inference principal, agent payment gas and merchant refund
gas have distinct presentation and accounting.

## Bounded real acceptance sequence

1. Validate a live Agent API partner key. Connect the owner wallet, create/bind
   two independent agents, read back the native-only policy and owner grants.
2. Freeze source chain/asset/precision/amount, per-leg minimum native output,
   source fee limit and refund destination. Use two original 1Click legs;
   independently verify native NEAR arrival. Intents/wNEAR balance is insufficient.
3. Freeze per-agent service/principal caps, payment-gas reserve/floor/stop
   threshold, merchant refund budget and run deadline. No implicit top-ups.
4. Qualify the real tool-capable provider/model/tokenizer/rates and each actual
   request/output scope. Real calibration counts against its own provider budget;
   synthetic P2 tokenizer padding and 1ms throughput cannot qualify live supply.
5. Run two real fx tasks through MPP chat/completions, including a tool
   continuation. Correlate funding, original payment, actual gas, Market
   admission/execution, verified usage, charge and original-asset refund.
6. Independent gpt-6-astra review checks actual task artifacts and final financial
   evidence, including recovery, before G1/P3 PASS.

Still required for a real run: usable Agent API partner credential, owner wallet
and signed grants, source wallet/asset/principal/fee cap, merchant, actual NEAR AI
provider configuration and rates, provider-call/output/USD limits, deadline,
and deployment choice/cap. A concrete spending plan is reviewed before sends.
Configuration credentials do not imply source-wallet or provider spending
authorization.

[Capability evidence](2026-11-14-agent-api-gas-key-verification.md) ·
[Current contract](2026-11-14-agent-mpp-p0-contract.md) ·
[Agent API native documentation](https://docs.agentsonintents.com/integration/agent-api/native-accounts)
