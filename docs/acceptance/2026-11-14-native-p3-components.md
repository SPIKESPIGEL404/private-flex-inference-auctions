# Ordinary native NEAR P3 component checkpoint

Status: **NOT_ACCEPTED for B/P3**. No real chain transfer, provider inference,
merge or deployment was performed by this checkpoint.

The selected runtime route is ordinary agent wallets paying principal and gas,
with merchant-funded native refunds. Agent API and gas-key executors are not
selected. The run plan was updated accordingly.

Node 24.22.1: **53 tests passed**, including nine new P3 component tests. The
durable sender survives a separate Node process reopening its on-disk encrypted
SQLite journal. It preserves original signed bytes, blocks replacement sends
while an outcome is unknown, prevents key rotation from resetting an account's
budget, and prevents stale RPC nonce data from assigning an old transaction to
a second refund.

The requested gpt-6-astra reviewer found the key-scope and stale-nonce issues;
both were fixed and covered by regressions. It independently checked rejection
of non-FINAL, missing/duplicate/failed receipts, wrong signer and missing gas
data. Its review was a component review, not full P3 acceptance. The separate
process recovery test was added after the initial review's disk-space block.

The funding preflight did not establish all three dedicated accounts as funded.
This is insufficient evidence, not a claim that their balances are zero. Keys
remain in restricted local files outside Git. No automatic top-up is enabled.

Still required: browser MPP signing and shared withdrawal fence; original Market
money-purpose/admission/settlement integration in a dedicated zero-credit native
namespace; real tool workload qualification; two real fx tasks; original payment
and refund FINAL evidence; independent full acceptance; merge and Phala deploy.
