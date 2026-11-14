# Fixed-supply comparison — controlled acceptance

Scope: first operator-run A/B slice on `codex/fixed-dynamic-comparison`, based on
main security PR #14 and the verified Chutes supply changes from #7. No deployment
or paid external inference was performed for this acceptance. Existing public
playground deployment remains unchanged.

## Results

| Check | Result | Evidence scope |
| --- | --- | --- |
| Comparison Node tests | 22 passed | Exact rate units, immutable plans, native stream bounds, private CLI, durable Unknown, signature failure, concurrent replay, restart and shutdown |
| Market buyer tests | 12 passed | Boot/catalog policy, purchase signatures, encryption vectors and signed receipt verification |
| Chutes Python tests | 27 passed | Existing gateway/deployment/metrics contracts plus zero-inference NEAR preparation |
| P2 Rust host tests | 13 passed | Includes exact NEAR loopback binding, security encryption vectors and single-model guard |
| Chutes full Market acceptance | Passed | Actual signed host + owned PG/Redis, native model mapping, settlement and replay after restart |
| Two-arm full Market acceptance | Passed | Two owned Markets/PG/Redis, common request, one controlled upstream invoke per arm, committed settlements and zero extra invokes after process restart/replay |
| Official SDK construction | Passed | Node 24.22.1, pinned SDK 0.3.0, no inference call |
| Public NEAR catalog snapshot CLI | Passed | Read-only live public metadata; zero inference calls |

The integration fixture explicitly reports `hardware_attestation: not_tested`,
`external_inference_calls: 0` and `real_agent_payments: false`. It uses a controlled
SDK client and native Chutes fixture. Those substitutes are confined to test
entry points; the production CLI uses the hardware-verifying Market executor and
the production bridge creates the official SDK with strict TCB policies.

The integrated #14 changes exposed a real regression: live deployments with
offline buyer keys persisted empty token fields, but only golden deployments
reloaded bearer secrets on startup. The host now records that buyer tokens come
from the environment independently of the golden catalog flag. The two-arm
acceptance asserts token fields stay empty on disk and exercises authenticated
purchases after restart. P2's separate dependency/lockfile also includes the six
required encryption packages without unrelated dependency updates.

A read-only live catalog run found unrelated fractional metadata, incompatible
with the purchase signer's integer-only JCS. The catalog digest now hashes its
parsed JSON serialization; all signed financial rates remain exact integer
strings. A regression case covers this boundary.

## Commands

```sh
npm test --prefix services/inference-comparison
npm test --prefix clients/market-buyer
python -m unittest discover -s deploy/chutes -p 'test_*.py'
cargo test --locked --manifest-path crates/private-market-p2/Cargo.toml --bin private-market-host-p2
cargo build --locked --manifest-path crates/private-market-p2/Cargo.toml --bin private-market-host-p2
python scripts/accept-market-chutes.py /absolute/path/private-market-host-p2
python scripts/accept-inference-comparison.py /absolute/path/private-market-host-p2
```

Node checks ran with 24.22.1. Python used an isolated 3.12 environment with the
repository's gateway, tokenizer and Chutes requirements. Rust used the existing
native target directory. Generated cross-language crypto vectors were restored
following tests; random test output is not part of this change.

## Remaining gates

- Real NEAR and Chutes A/B run on reviewed attested Market deployments, including
  compatible native token accounting and provider invoices.
- Signed financial receipts are collected and checked when available; comparison
  `serviceCostMicro` and `providerBillMicro` remain null until their authoritative
  projection is accepted. Tariff estimates are explicitly estimates.
- A's exact checkpoint/serving equivalence, performance counterbalancing and
  workload/task-success evaluation remain unverified.
- C's dynamic clearing terms, #10's result presentation, and native-wallet
  autonomous MPP payment are subsequent integration work.

See [the runbook](../inference-comparison.md) for preparation, bounded paid
calibration, operator execution and read-only recovery. This acceptance does not
establish production readiness or validate an economic pricing advantage.
