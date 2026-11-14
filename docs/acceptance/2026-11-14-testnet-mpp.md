# Real testnet MPP protocol acceptance

Status: **SCOPED ACCEPTED**. This is real native NEAR on testnet, official mppx
client/server HTTP authentication, local acceptance signers and deterministic
protocol metering. It does not establish browser-wallet, original Market cash,
real inference, mainnet or complete B/P3 acceptance.

Two independent agents each paid 0.001 testnet NEAR and their own actual gas.
The merchant returned 0.0006 to each original agent and paid refund gas. Each
order has one original payment, a retained 402 challenge and signed NEP-413 MPP
credential. Repeated credentials consume the same movement; HTTP retries return
the original response. P = C + R, with no remaining hold or refund obligation.

A separate short quote expired after payment and before protocol delivery. Its
independent cleanup path returned the full 0.001 testnet NEAR, C = 0. The observed
failure was `Payment Expired`; this is not evidence that the later explicit
after-verification fault point was reached. Normal delivery and abandoned
cleanup share an atomic settlement claim and one immutable refund plan.

All six payment/refund transactions were independently checked by gpt-6-astra
using fresh public RPC reads, without the primary runner's persistent snapshots:
original signatures, body binding, accounts, amounts, FINAL status, complete
receipt graph, actual gas and principal conservation passed.

[Public evidence](2026-11-14-testnet-mpp.json),
[initial independent review](2026-11-14-testnet-mpp-astra-review.json),
[expired-order independent review](2026-11-14-testnet-mpp-cleanup-astra-review.json).

The runner uses bounded RPC reads and may cache immutable FINAL transactions,
hash-addressed blocks and historical access keys. It never caches current
balances or unresolved transactions. Original signed bytes survive restart;
RPC failure does not permit replacement payments or refunds. Gas reserves are
estimates with an overrun stop, not chain-enforced fee ceilings.

Keys remain in restricted local files outside the repository and images. Only
public signatures, challenges and chain evidence are published. Testnet faucet
funds were used; no mainnet funds or inference-provider charges were incurred by
these protocol tests.
