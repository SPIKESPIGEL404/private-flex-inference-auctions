# Batch B: business invariants and recovery

Batch B keeps the fixed Cloud contract and tests the independent host's composition.
Run from the repository root with the same tools as [batch A](market-batch-a.md):

```bash
bash scripts/accept-market-b.sh --evidence /tmp/market-b-evidence.json
```

This command runs the batch A baseline, migrated source regressions, then seventeen
host scenarios. It uses only owned temporary PostgreSQL clusters, standalone Redis,
synthetic seller output and test credits. The source runner compiles and runs each
test executable sequentially and removes that executable afterward to bound build
storage. Retained upstream test files are checked against recorded SHA-256 hashes.

## Source regression boundary

- 202 kernel integration tests are copied byte-for-byte from the pinned Cloud
  `crates/bitrouter-market/tests` tree and execute against the actual dependency.
- 17 kernel unit tests run directly from the pinned dependency's Cargo checkout,
  located through Cargo metadata, with its original locked manifest.
- 24 of the 25 inference-domain tests are adapted to public dependency imports.
  Their state, authorization, recovery and financial assertions remain. Two calls
  to the private `validate_contract` method cannot be made externally; the tests
  still exercise persisted public state and terminal/settlement transitions.
  The private platform-fee helper comparison uses the same public integer fee API.
- The private `OutputConstraints` instance test moves to native HTTP: the valid
  instance and all six invalid instances from the source test are exercised by
  `schema-instances`. The source empty-validator call is likewise exercised by
  `terminal-empty`, while its domain state assertions use `OutputCheck::Empty`.

SQLite tooling and simulation tests keep their original feature guards and are
excluded because this host uses PostgreSQL. Cloud's original gateway/Core fixture
suite is not transplanted wholesale: its private proof/commit-injection seams and
unselected Messages/Responses deployment depend on that gateway. Applicable Chat
financial/recovery scenarios are implemented at the actual independent host's
HTTP, process and PostgreSQL wire boundaries. This is not a claim that every Cloud
gateway test ran. See [source record](../crates/private-market-host/upstream/SOURCES.md).

## Host change

Concurrency exposed an incomplete batch A composition: the native route returns
`market_no_supply` before reconciling cash for a closed native request. PostgreSQL
has already released the funds, but the durable cache mutation can remain pending.
The host now periodically invokes the source `RedisBalanceCache::reconcile_balance`
for the three configured test users, after performing the same repair at startup.
That original API owns locks, durable snapshots, mutation acknowledgment and CAS;
the host adds no wallet arithmetic or settlement interpretation. Repair failure
stops the host through its owned task group. The worker drains on shutdown.

This bounded identity scan fits the current static test authority. A dynamic user
directory needs a complete durable mutation discovery path before admitting users
outside that directory; this worker is not a production general-purpose drainer.

`PRIVATE_MARKET_EXTERNAL_FIXTURE=1` selects an independently owned loopback seller
for tests. This keeps the seller alive when the market process is killed, so a
host crash cannot masquerade as provider termination. The default batch A entry
still starts its internal controlled fixture. Neither mode accepts a real model
or supplies attestation.

## Acceptance matrix

| Spec | Evidence |
| --- | --- |
| M1 identity/isolation | A baseline absent/forged credentials and cross-buyer status/replay/cancel; B checks denied Unknown status contains no original request, proof or fee fields |
| M2 eligibility | HTTP model/output/service rejection and stale load evidence; kernel source tests cover Offer expiry, contract eligibility and frozen terms |
| M3 funds/capacity | Three simultaneous submissions near cash limit; confirmed reserve denies another purchase; distinct buyers share one blocked native slot; second writer is refused |
| M4 idempotency | Three simultaneous same-key submissions produce one request, submit effect and seller call; A changed-cap conflict test |
| M5 native evidence | Success, exact output cap, early cap, refusal, empty output, schema instances and missing usage; source contract determines charge or retained hold |
| M6 Unknown/restart | External seller disconnect and SIGKILL after persisted output retain original identity, original event hashes and 4,502 microUSD hold; no second native call |
| M7 offline replay | Buyer disconnects before terminal; background execution settles; owner replay, including after process restart, is byte-identical and does not regenerate |
| M8 authorized replacement | Qualified `capacity_exceeded` response proves unaccepted A; enhanced recovery authorizes B; both attempts and A's fulfillment/fee protection persist; only B plus one nonzero logical fee is charged |
| M9 lost settlement ACK | PostgreSQL proxy observes a real financial `COMMIT` completion, then drops its acknowledgment before Cloud receives it; restart recovers the same financial receipt and ledger without another submit or debit |

The concurrency test accepts a fail-closed 503 while the original reserve's cache
confirmation is pending. After confirmation it explicitly requires insufficient
cash (402). It verifies original account/ledger state and actual seller calls,
rather than treating an HTTP status alone as evidence against double spend.

The long public prompt yields a 2 microUSD platform fee with the fixed meter. A
normal result costs 35 + 2 microUSD and leaves 24,963. Exact-cap output costs 706 +
2. Protected failure costs zero. Missing usage and Unknown retain the original
4,502 hold instead of releasing or retrying it. These values are test credits.
Successful buyer SSE is checked for `stop` with usage 2/3/5, and exact-cap SSE
for `length` with usage 2/64/66 and `[DONE]`. The source may suppress an invalid
early-cap Chat terminal from the buyer; the test requires its protected zero
charge rather than inventing an additional native delivery guarantee.

The COMMIT proxy uses plaintext PostgreSQL only inside its owned local test
cluster. It detects the financial receipt UPDATE and the backend's actual COMMIT
completion; it does not replace a receipt or call a synthetic success callback.

For a focused development rerun, without claiming the full batch:

```bash
python3 scripts/accept-market-b.py crates/private-market-host/target/debug/private-market-host --case lost-commit-ack
```

Focused evidence is marked `partial: true`. The full wrapper supplies the source
test inventory and runs every scenario. Acceptance is scoped to the pinned
controlled Chat host. Real Provider/tokenizer qualification, TEE and snapshot
freshness, and final demo delivery remain C, D and E.
