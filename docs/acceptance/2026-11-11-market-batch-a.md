# Market batch A acceptance

- Date: 2026-11-11, America/New_York.
- Implementation result: PASS for local controlled batch A.
- Independent review: `gpt-6-astra` — PASS for batch A, no open findings. See [review report](../reviews/2026-11-11-market-batch-a-review.md).
- Source: Cloud `244177cafa26e8c8b001e61297cf4e7f89ac8de9`, native SDK
  `f206ca9a6f472b079167c9992c1c1ce1688725af`.
- Runtime observed: Rust 1.97.0, PostgreSQL 18.6, standalone Redis, macOS arm64.

## Delivered scope

The independent `private-market-host` package uses the unmodified, pinned Cloud
library for the domain, PgMarket, coordinator, Strategy, native streaming,
verified authentication, shared cash and Redis. It retains that whole library
dependency for batch A; it does not claim completion of a standalone Cloud crate
extraction. See [source record](../../crates/private-market-host/upstream/SOURCES.md).

The executable initializes a new database, three random test identities and
auditable test-credit entries. It provisions three one-use On-demand Offers from
one controlled Provider with a shared one-request physical scope, then runs the
native API and authenticated recovery surface. It does not construct a Core
process, Cloud public gateway or scheduler.

## Verification

```bash
bash scripts/accept-market-a.sh --evidence /tmp/private-market-a-evidence.json
```

The final run passed formatting, Clippy with warnings denied for the host,
locked build and end-to-end acceptance. Cargo's upstream duplicate legacy-package
discovery warning selects the intended Cloud root package. Its existing
`proc-macro-error2` future-compatibility warning does not fail the current build.

The harness started and stopped its own temporary PG cluster and Redis process;
no existing databases, Redis data, production credentials or model endpoints
were used. Observations:

| Check | Observed result |
| --- | --- |
| Explicit isolated initialization | Fresh database and state; three test accounts at 25,000 microUSD; 0700 state directory, 0600 credentials file |
| Repeated initialization | Refused; no test-credit refill |
| Authentication | Actual source introspection resolver; absent or forged full credentials return 401 |
| Native execution | Three owner submissions reach controlled Chat HTTP through the pinned SDK; buyer opts into usage; output and replay both contain `stop`, 2 input / 3 output / 5 total tokens and `[DONE]` |
| Buyer isolation | Other buyers receive 404 for status, event replay and cancel |
| Owner replay | Saved native output replays byte-for-byte with original terminal and opted-in usage |
| Idempotency | Same request/key recovers; changed purchase cap returns 409; exactly three submit effects and three original requests |
| Finance | Each Provider charge is 35 microUSD; platform fee rounds to 0 for this short fixture; cash charge is 35 and balance is 24,965 |
| Redis confirmation | No non-applied balance mutations remain after the requests |
| Lifecycle | SIGINT drains the owned host and exits successfully; owned test services stop |
| Scheduler independence | Host dependency graph contains no `flex-scheduler`; root scheduler manifest, lockfile and implementation unchanged |

The sanitized [machine-readable evidence](market-batch-a-evidence.json) records
the final assertions and fees. A one-use Offer is consumed by its first match;
the three requests use three explicitly provisioned Offers, rather than
implicitly resetting capacity or replenishing seller orders.

## Limits

This is controlled acceptance using synthetic token IDs, seller output,
qualification observations and test credits. It makes no real-model, TEE,
attestation, private-storage, snapshot-freshness, NEAR asset or production funds
claim. The short fixture also does not test a nonzero platform fee.

Batch B still needs the applicable source regression suite, concurrent money and
capacity checks, Unknown/restart invariants, alternative attempts and lost-commit
recovery. Batch C must replace synthetic qualification and tokenizer data with
authorized, measured real-seller evidence. Batch D owns the private deployment.
The preserved historical Chutes/scheduler evidence is not reused for this Market.
