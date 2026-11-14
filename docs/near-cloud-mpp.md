# NEAR AI Cloud through MPP: first integration

This standalone, loopback-only integration accepts one frozen text request for
`Qwen/Qwen3.8-27B`, charges an ordinary wallet on NEAR **testnet**, invokes the
real NEAR AI Cloud model, and refunds unused principal using actual verified
token usage. It does not invoke Chutes or use the controlled P2 inference fixture.
It does not yet connect the browser wallet, Market order book or autobidder.

The client owns the agent key; the proxy receives only its public binding and
signed original payment credential. The merchant key signs financial receipts
and native refunds. API keys and wallet keys stay in private local files.

## Payment, inference and settlement

1. A pinned official SDK verifies gateway/model evidence before a new payable
   quote is exposed. Chat uses E2EE, strict `UpToDate` TCB policy and subsequent
   `provider_tee` response verification.
2. The authenticated client calls `/v1/chat/completions` with the original body
   and idempotency key. MPP returns an original, persisted 402 challenge. The
   server uses `requiresAuth: true` so the payment credential uses
   `Payment-Authorization` and preserves the application's Bearer credential.
3. Before broadcasting, the client persists the exact signed Transfer and
   registers its signed assignment through `/v1/orders/:id/payment`. The server
   can reconcile the original transaction and refund a late payment even if
   the client disconnects. Agent principal and actual gas are independently
   verified from the entire FINAL receipt graph.
4. The owning encrypted SQLite transaction binds payment to exactly one order
   and commits the original provider intent before any paid model invocation.
   Concurrent or restarted requests cannot create another provider call.
5. The proxy persists response bytes before parsing and retains official SDK
   verification before metering. Repeated/cumulative SSE usage is not summed:
   the final monotonic usage snapshot determines the charge. Reasoning tokens
   already included in completion tokens are not added again.
6. The frozen Cloud tariff determines the service charge, rounded up to one
   microUSD. A merchant signature binds usage, request, response digest, terms,
   original payment and principal settlement. This is a proxy service receipt;
   it is not a Market receipt or an independently verified provider invoice.
7. A background merchant worker prepares one refund plan per order, persists
   original signed bytes before broadcast and changes W to R only after FINAL.
   Merchant refund gas is separate from the agent's payment gas.

The test conversion is explicitly **one test NEAR represents one USD**. It is
an accounting convention for test coins, not an exchange-rate assertion. Frozen
USD pricing and real token usage are separate from that convention.

## Recovery boundaries

Existing payments/refunds remain readable after tariff expiry and during provider
outages. A known SDK-verified response can be settled after process restart
without another inference request. Unknown execution retains its principal hold;
HTTP errors, a missing transaction or elapsed time never imply zero cost.

The first real run exposed repeated Cloud usage frames before the old parser had
saved its response. Its original cost could not be reconstructed. The merchant
explicitly waived that customer's charge and returned the full deposit; the
unknown upstream expense and original maximum reserve remain recorded. This
narrow local operator waiver does not relabel the inference as unexecuted. Only
after that refund was FINAL was a second, explicitly named test case authorized.
Both original orders and provider intents remain in the same journal. At most
two such test orders may exist and their aggregate original reservations must
fit the original $0.01 upstream authorization.

## Running locally

Use Node **24.22.1** or later. Install both services' locked dependencies:

```sh
npm --prefix services/mpp-near-direct ci --ignore-scripts
npm --prefix services/inference-comparison ci --ignore-scripts
```

Prepare separate testnet `agent.json` and `merchant.json` credential files with
`network`, `role`, `account_id`, `public_key` and `private_key` fields. A
`storage.key` file contains 32 random bytes encoded as hex. Keep all three files
and the existing Cloud API key file at mode 0600 in private directories. Fund
only these testnet accounts, using the official testnet faucet.

```sh
node services/mpp-near-direct/near-cloud/accept.mjs \
  /private/testnet-wallets /private/near.key /private/cloud-mpp-run
```

The run freezes the tariff, request and authorization in `run.json` and retains
separate encrypted client/server journals. Repeating the same command recovers
the same order. The public response, full local evidence and signed receipts
are written only after original result delivery and confirmed refund.

The explicit `--retry-after-waiver` flag is for the single documented parser
incident after its full refund. It is not an automatic retry of Unknown. Never
delete journals, change logical keys or replace transaction nonces to recover
an ambiguous original operation.

The read-only audit needs only the exported evidence, not API or wallet keys:

```sh
node services/mpp-near-direct/near-cloud/verify-evidence.mjs /private/cloud-mpp-run/evidence.json
```

It rechecks original native payment, exact refund, both gas responsibilities,
principal conservation, frozen-price arithmetic and financial signatures. It
does not claim to independently replay the SDK's encrypted-wire verification.

## Validation

```sh
cd services/mpp-near-direct
node --test test/*.test.mjs near-cloud/test/*.test.mjs p3/test/*.test.mjs
cd ../inference-comparison
node --test test/*.test.mjs
```

The acceptance record includes the real Cloud result and chain transaction IDs:
[2026-11-14 first integration](acceptance/2026-11-14-near-cloud-mpp.md).
