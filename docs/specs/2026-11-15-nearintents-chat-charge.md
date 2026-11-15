# Agent inference payments through NEAR Intents charge

The agent calls `POST /v1/chat/completions` with an ordinary OpenAI request.
A 402 response quotes this exact request. The agent's payment client checks its
own policy, pays from the agent wallet, and retries the same request with an MPP
Credential. The proxy settles the payment before invoking the provider and
returns the completion with the official MPP Receipt. Each tool continuation
purchases its own inference through that same endpoint.

This is inference purchasing, not a credit purchase or funding endpoint. There
are no payment channels or session contracts. Durable records describe original
payments, provider effects, results and unresolved liabilities, not task memory.

## Contract approved for this first implementation

The user allowed usage rebates to be deferred. `fixed-request-v1` therefore
quotes a fixed destination-asset amount for one admitted request, including its
explicit maximum output limit. The whole quoted amount is charged on successful
delivery, even when the output uses fewer tokens. Terminal usage is retained as
evidence, not used to imply a metered final charge. Both the Challenge description
and the 402 terms disclose this contract. It does not change the earlier native
NEAR auction's metered/refund contract.

A provider failure is different from unused-token change. A paid request that
cannot deliver records the full destination amount as a merchant refund
liability and blocks new quotes until reconciliation. Automatic refund payment,
reverse conversion into the source token, and refund completion tooling are
deferred. No refund is claimed to have happened. An uncertain provider effect is
not executed again. Expired payments retain their evidence for reconciliation;
they never receive a fresh payable challenge under the same operation.

## Payment and execution

1. Authenticate a configured agent token; keep Bearer authentication separate
   from `Payment-Authorization`, as supported by the official MPP SDK.
2. Bind the idempotency key to the agent and exact request bytes. Admit bounded
   text/tool messages and an explicit output limit. Freeze the offer version,
   destination amount, model, input/output limits and refund policy.
3. Use official `nearintents.charge` / 1Click EXACT_OUTPUT. The merchant receives
   the configured destination asset; the agent pays the quoted source amount.
   Source limits are enforced independently of the destination price limit.
4. Persist the original credential before verification. Commit SDK consumption,
   the paid-call record and official Receipt in one owning PG transaction.
   Cache pointers are per call; source-hash and deposit replay protection are
   shared across agents in this authority.
5. Persist one provider dispatch claim before a model POST. Capture and validate
   the original JSON or complete SSE response. Persist before release, then
   replay the same response and Receipt on retries, including after restart.

The client keeps an agent-specific durable payment policy and total source-asset
reservation. It refuses a price above its source/destination caps or an estimated
settlement time above its speed policy. This estimate is not a latency SLA or an
auction bid. The EVM signer binds refunds to its own address, caps gas per transfer
and in total, and stores signed transaction bytes, nonce and derived hash before
broadcast. Lost ACK recovery reuses the identical signed transaction. It never
creates a replacement nonce or payment for the same inference.

## Deliberate scope

The first runnable client is a normal EVM wallet held by the agent process. The
model never sees the private key, auth token or signed-transaction journal.
Each agent needs its own source tokens and source-chain gas. No Agent API key is
required. Non-EVM signing adapters and browser wallet provisioning are not part
of this change. Supported 1Click assets are not automatically supported by every
signer or policy.

This first mode has operator-published fixed offers. It does **not** connect the
existing auction's winning allocation/price to the new payment rail yet, and is
not enabled in the current market-playground deployment. It runs in a separate,
initially empty PG schema and does not credit or spend the existing Market cash
ledger or native auction balances. The next auction integration must use the
winning allocation as the single price/authorization authority rather than
creating another spendable balance or paying twice for one allocation.

The initial provider adapter forwards native OpenAI request bytes without buyer
payment credentials. It checks model identity, bounded terminal usage and full
delivery. HTTPS transport is its evidence scope; it makes no model-weight or TEE
attestation claim. The existing attested NEAR Cloud provider remains available in
the native auction mode and has not been replaced by this adapter.

JSON/SSE responses are buffered until complete and durably stored. SSE wire
format is preserved, but this first implementation does not offer live token
streaming or a native time-to-first-token comparison. Upstream cost reservations
are conservative operator-declared bounds, not a provider-enforced billing cap.

## Release gates

Controlled tests use the official SDK, real PostgreSQL and cryptographic EVM
signatures with owned HTTP/RPC fixtures. They do not broadcast to a blockchain,
move real money or invoke a paid model. Live launch requires an explicit frozen
server-plan fingerprint and a separate agent-plan fingerprint. Real acceptance
still needs an executable quote for the chosen asset/amount, funded agent and
merchant addresses, an approved spend cap, provider readiness, real source and
destination transaction evidence, and observed payment latency/fees. No live
spending approval is inferred from this implementation request.

References: [MPP NEAR Intents](https://mpp.dev/payment-methods/nearintents),
[official SDK](https://github.com/defuse-protocol/nearintents-mpp-sdk),
[supported tokens](https://docs.agentsonintents.com/api-reference/oneclick/get-supported-tokens).
