# NEAR AI Cloud → MPP first integration acceptance

Status: **PASS for the standalone real-Cloud/testnet payment path**. Browser
wallet integration, multi-turn tools, Market admission, mainnet and production
deployment are outside this acceptance. No Chutes calls were made.

The real model was `Qwen/Qwen3.8-27B`. Its visible answer was `4`. The official
`@nearai/inference-sdk` 0.3.0 Node entry point verified gateway/model evidence,
used Chat E2EE and accepted the actual response only after `provider_tee`
signature verification under the strict UpToDate policy.

| Item | Successful original order |
| --- | --- |
| Order | `d785410c83426eb174fa70691c3c095c3f6c7eafd7c21de9a0040ccc01acfdbe` |
| Provider response | `4ee3c787fe764573b84c08bb49334f45` |
| Prompt / completion / total tokens | 61 / 30 / 91 |
| Reasoning tokens, already included in completion | 27 |
| Frozen input / cached input / output rates, microUSD per 1M | 40000 / 18000 / 1350000 |
| Usage-based service charge, rounded up to microUSD | 43 microUSD = $0.000043 |
| Testnet principal P / charge C / refund R | 0.000501 / 0.000043 / 0.000458 NEAR |
| Held H / refund pending W | 0 / 0 |
| Agent payment gas | 44636512500000000000 yoctoNEAR, paid by agent |
| Merchant refund gas | 44636512500000000000 yoctoNEAR, paid by merchant |
| Provider attempts for this order | 1 |
| Additional provider invocations in restart process | 0 |

The testnet conversion is the explicit accounting convention of one test NEAR
per USD. It is not a real exchange rate. The service charge uses real verified
usage and the frozen public Cloud tariff, not a simulated meter. No provider
invoice amount is asserted.

- Payment FINAL: `CrLCjpvHboCNKrEQNzDEFsqzaBSMtgxnzxxEhzc7XrLJ`.
- Refund FINAL: `9DH6aDEcnr9LdMA1aCQCrtCs5nuJ2GPVNhDwqkRsQwfP`.
- A separate, read-only chain/financial audit rechecks the original signed MPP
  assignment, complete receipt graphs, historical FullAccess keys, both gas
  expenses, financial receipt signatures and P = C + H + W + R.
- Repeated HTTP requests replayed the identical original response. Restart
  reused the persisted verified response with zero additional Cloud invocations.

## Initial parser failure and explicit waiver

The first Cloud invocation was rejected by the old parser with
`multiple_final_usage`. The previous path had not retained its response before
parsing. It was never presented as a successful inference or zero-cost provider
call. The merchant explicitly absorbed that test expense and refunded the full
original principal; the original expense reservation of 501 microUSD remains.

- Original order: `919413669c6bfb968b812944099b62603ca421bfc572dbfe292be979afc6a165`.
- Original payment: `7wYjZvRKrXLHFhPtCLryMwQMtQPebdTYbU5VMnF8M4P7`.
- Full-refund FINAL: `CFxSgNf11UWXu7oJjsphAePAzyN4S3cqj6cUoHjK47DV`.
- Original P = R = 0.000501 test NEAR; C = H = W = 0 by merchant waiver.

After that refund, a distinct test case ran under the same retained journal and
$0.01 aggregate upstream authorization. Lifetime provider attempts were two,
with 1002 microUSD of original maximum reservations retained. The first
provider invoice remains unverified; this is not a claim of total actual cost.

The implementation now saves bytes before parsing, saves verified model
evidence before metering, accepts monotonic cumulative/repeated terminal usage
once and can recover a captured verified result after process restart. It never
reinvokes an ambiguous original inference.

## Local validation and artifacts

- 59 MPP/native/Cloud tests passed.
- 28 comparison/Cloud stream tests passed.
- Model and chain tests are distinct from controlled fixtures.
- Keys, API credentials, application bearer tokens and private journals are
  excluded from this repository. No files in the active deployment worktree
  were modified by this isolated integration.

[Public summary](2026-11-14-near-cloud-mpp.json) · [Runbook](../near-cloud-mpp.md).
