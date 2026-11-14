# OutLayer wallets + real NEAR AI Cloud through MPP: passed

Two distinct OutLayer testnet wallets each bought one real
`Qwen/Qwen3.8-27B` response through the MPP proxy. Both completed the fixed task
with visible answer `4`. Each agent paid native NEAR principal and gas; the
merchant returned the difference to that same wallet and paid refund gas.

| Evidence | Agent A | Agent B |
| --- | --- | --- |
| Account | `9c617cabf4db57e7f11dc6b3d668108ab7104dc689bd6c3dff7469c9cbf2ee73` | `ddd6d65c1e6e9f8ea5b52ac46e14bc776d6e6f9d511303c4f3f19b17b541f5a4` |
| Input / output tokens | 61 / 31 | 61 / 31 |
| Reasoning tokens, included in output | 28 | 28 |
| Service charge at frozen tariff | $0.000045 | $0.000045 |
| Prepaid test NEAR | 0.000501 | 0.000501 |
| Charged test NEAR | 0.000045 | 0.000045 |
| Refunded test NEAR | 0.000456 | 0.000456 |
| Agent gas, test NEAR | 0.0000446365125 | 0.0000446365125 |
| Merchant refund gas, test NEAR | 0.0008349895375 | 0.0008349895375 |

Payment and refund are independently FINAL:

- A payment: `DQM3iBSoct5ASiMZJUwHLn6ugCf3bixQf96FWJFAhgDU`
- A refund: `ARwebJKhfBW2zPPdq65USwrpwjpE1tqkKBUNuNDSXC9w`
- B payment: `31VYsUZnaG4FMgEjRM7wKeyM1xwd5faH8DzZWAa9F3Pd`
- B refund: `An8iidkkXNpM2ADFrfasPMUvXaEKwjyVGcJNq87wUXwF`

A was frozen after its payment/MPP signature and before inference/refund. Its
refund still arrived. A subsequent purchase was blocked with zero transfer
attempts and zero provider calls. B then completed while A stayed frozen. Both
wallets were independently checked frozen at the end.

Exactly two actual provider POSTs and two agent payment POSTs appear in the run's
durable journals. Their retained maximum provider reservation is 1,002 microUSD
under the 10,000 microUSD project allowance. The service charge totals 90
microUSD. The accounting convention is one test NEAR represents one USD; this
is not a market FX quotation or an independently verified provider invoice.

The first B attempt stopped at a transient read-only RPC failure before any
payment POST or inference. Recovery exposed a challenge persistence conflict,
which was fixed and regression-tested. The original B wallet operation had
zero attempts and was durably cancelled after quote expiry before a new quote.
The old quote/reservation remains in history. A's completed result was replayed;
neither its payment nor inference was repeated. Final process restart delivered
both original responses with **zero additional provider invocations**.

Validation: 81 MPP/wallet/native/Cloud tests and 28 inference-comparison tests
passed. Controlled tests cover lost hosted ACK across journal reopen, concurrent
recovery, cumulative budgets, fixed challenge replay across port changes,
known-unsent quote renewal, unknown provider retention, and paid-but-signing-
frozen refund-only recovery. Hosted ACK loss was not fault-injected.

A fresh read-only RPC audit, without wallet/API credentials, financial database
or persistent RPC cache, passed for both cases. It checked principal
conservation (`H=W=0`), four transfers, both gas responsibilities, frozen rates,
financial signatures, response hashes/answers and frozen policies. Cloud's
official SDK verified gateway/model readiness and `provider_tee` responses at
runtime; the later audit does not redo encrypted-wire verification.

Scope: local CLI integration only. Browser wallets, a real connected user
controller, original Market/autobidder integration, Chutes, mainnet funding,
production deployment, hosted OutLayer attestation and independent subagent
review remain outside this acceptance. This branch has not been pushed,
merged or deployed.

Public results, frozen policy/setup transaction IDs, final replay counters and
source hashes: [JSON evidence](2026-11-14-outlayer-cloud-mpp.json).
Private keys, API credentials and raw journals are outside the repository.
