# Market batch B acceptance

- Date: 2026-11-11, America/New_York.
- Result: PASS for batch B; `gpt-6-astra` independent review PASS with no open findings. See [review report](../reviews/2026-11-11-market-batch-b-review.md).
- Fixed Cloud source: `244177cafa26e8c8b001e61297cf4e7f89ac8de9`.
- Runtime: local macOS arm64, Rust 1.97.0, PostgreSQL 18.6, standalone Redis.

## Scope and reproducibility

```bash
bash scripts/accept-market-b.sh --evidence /tmp/private-market-b-evidence.json
```

The wrapper runs A's baseline, 219 kernel tests (202 copied integration + 17
original unit), 24 adapted public inference-domain tests, and seventeen host
scenarios. The private schema-validator scenario is covered by its original one
valid and six invalid instances through native HTTP. Adaptations and exclusions
are explicit in the [source record](../../crates/private-market-host/upstream/SOURCES.md)
and [B guide](../market-batch-b.md).

The entire Cloud gateway/Core fixture suite was not run. Its applicable Chat
invariants are tested through the independent host; unselected Messages/Responses
deployments and SQLite tooling are outside this acceptance.

The combined command exited 0: formatting and Clippy for the owned host, locked build, A baseline, all 243 source cases, and all seventeen host scenarios passed. The sanitized [machine-readable evidence](market-batch-b-evidence.json) records the inventory; `partial` is false.

## Implementation correction found by regression

An IOC no-supply response can return before the source native handler projects
the already committed financial release to Redis. Batch A had no ongoing cash
projection recovery owner. The host now owns a periodic scan of its three test
identities using the source's exact reconciliation API. A startup repair precedes
admission; a repair error stops serving. There is no new settlement algorithm or
arithmetic. The concurrent capacity/no-supply scenario requires the durable
mutations to finish and each account's cash to match its original ledger.

Independent review also found a test-runner artifact-selection bug: the `quote`
integration target shared a name with the `quote` dependency library. Name-only
cleanup removed that dependency cache and caused recompilation/disk exhaustion.
Cleanup now requires a test target, its exact source path and a non-null executable,
and removes only that executable. A guard verifies all observed dependency files
still exist afterward. Kernel unit cleanup is likewise limited to its executable.
The failed resource run is not counted as a completed independent acceptance.

## Required observations

| Spec | Observation required by the combined command |
| --- | --- |
| M1 | Absent/forged and foreign buyers denied; no own-request/fee/proof data in foreign Unknown error |
| M2 | Unsupported product/type/output limit and stale candidate rejected; frozen source tests cover Offer expiry |
| M3 | Three concurrent cash-limited requests yield one execution; confirmed original reserve rejects another purchase; distinct buyers share one execution slot; another writer cannot acquire the active lease |
| M4 | Concurrent same-key requests yield one original request, one submit and one seller call; conflict rejection retained from A |
| M5 | Buyer success SSE contains stop with usage 2/3/5; exact-cap SSE contains length with 2/64/66 and is billed; early cap, refusal, empty or invalid schema protected; missing usage holds cash pending metering |
| M6 | Seller disconnect or SIGKILL retains identity, persisted ordered event hashes, Unknown and 4,502 hold; no replacement submit |
| M7 | Buyer disconnect before terminal still completes in background; owner replay is byte-identical before/after process restart with no new generation |
| M8 | Qualified unaccepted capacity failure A retains fee protection and fulfillment; authorized B succeeds; only B's 35 plus one platform fee of 2 is charged |
| M9 | Proxy drops actual backend financial COMMIT completion before it reaches Cloud; durable receipt and ledger recover unchanged after restart; one seller call and one charge |

Normal long-prompt success: Provider 35, platform 2, cash 37, final balance 24,963.
Exact-cap success: Provider 706, platform 2, cash 708. Protected terminal failures:
zero charge and original hold released. Unknown or missing metering: original
4,502 hold retained. All amounts are isolated test microUSD.

Independent review reran the full wrapper successfully after the runner correction. It then independently reran `terminal-success` and `terminal-cap` after adding explicit buyer-visible SSE assertions. The P2 artifact-cleanup finding and P3 terminal-evidence finding are both closed.

## Boundaries

The host still retains the whole pinned Cloud library as its temporary dependency
closure. This stage does not finish small-crate extraction. The recovery scan is
complete for the static three-user test authority; a dynamic user directory needs
durable mutation discovery before supporting additional identities.

Only controlled native endpoints and synthetic qualification/tokenizer evidence
are used. No paid GPU, production account, chain settlement or TEE proof is
involved. P1/P2/P4 snapshot freshness and operator confidentiality are not certified;
the second-writer check covers the source process/session fence only. C–E remain
unaccepted.
