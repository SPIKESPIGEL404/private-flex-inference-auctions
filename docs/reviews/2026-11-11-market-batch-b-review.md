# Market batch B independent review

- Date: 2026-11-11, America/New_York.
- Reviewer: independently assigned `gpt-6-astra` review.
- Verdict: **PASS for batch B — controlled business-invariant and recovery regression only.**
- Open findings: **none**. The P2 runner defect and P3 evidence gap below are closed after independent verification.
- Scope: the current batch B working tree against `docs/specs/2026-11-11-private-market-hackathon.md`, including the host recovery owner, external fixture mode, source-test migration, fault fixtures, acceptance scripts and documentation. Existing uncommitted batch A files were treated as the established baseline.
- The reviewer edited only this report; no commit, push, production-money operation, GPU call or TEE operation was performed.

## Findings and resolution

**Closed P2 — source runner deleted a dependency with the same target name.** The original `scripts/market-source-tests.py:31–35` selected artifacts only by `target.name == source.stem` and deleted every reported filename. When running `tests/quote.rs`, this also selected the dependency library named `quote`. The first independent full run passed A and the source suites through `quote`, then rebuilt the dependency closure for `scheduler_indexes` and exited 101 while archiving `libbitrouter_cloud-eac3ffce1a9db164.rlib`: `No space left on device (os error 28)`. That run is not counted as a completed acceptance.

The implementation owner corrected the selector. Current lines 35–42 require a test target, its exact source path and a non-null executable, remove only that executable, and assert that previously existing dependency artifacts remain. Kernel-unit cleanup similarly selects only the original library's test executable. The independent full rerun passed all suites, including `quote` and the following `scheduler_indexes`, with the dependency-preservation assertions enabled. This fixes the defect rather than merely relying on more disk space.

**Closed P3 — normal and exact-cap fees alone did not prove buyer-visible native terminal preservation.** The initial B terminal checks asserted settlement, balance and ledger amounts but did not parse the returned SSE for the exact-cap finish reason and usage. The owner added direct assertions at `scripts/accept-market-b.py:77–84`: normal output contains `stop`, usage 2/3/5 and `[DONE]`; exact-cap output contains `length`, usage 2/64/66 and `[DONE]`. Both updated scenarios independently passed after the full run. Chat early-cap remains a protected invalid delivery; the pinned source's `verify_text_terminals` explicitly excludes that case from its normal wire-end guarantee. This review does not promise a successful native termination frame for invalid early-cap output.

## Independent verification

After the runner correction and repair of its affected compilation cache, executed:

```bash
CARGO_INCREMENTAL=0 bash scripts/accept-market-b.sh --evidence /tmp/private-market-b-review-evidence.json
```

The command exited **0**. It passed host formatting, Clippy, locked build, A baseline, **243 source tests** and **all 17 host scenarios**. Evidence reports `partial: false`. The complete rerun log is `/tmp/private-market-b-review-rerun.log`. The earlier disk-exhaustion failure is recorded separately above.

The final SSE assertion additions were made after that process had loaded the host scenarios. The reviewer therefore independently reran both affected cases against the final script:

```bash
python3 scripts/accept-market-b.py crates/private-market-host/target/debug/private-market-host --case terminal-success --evidence /tmp/private-market-b-review-success-evidence.json
python3 scripts/accept-market-b.py crates/private-market-host/target/debug/private-market-host --case terminal-cap --evidence /tmp/private-market-b-review-cap-evidence.json
```

Both exited **0**; their evidence correctly reports `partial: true`. The source suites and remaining scenarios were unaffected by these additional Python assertions. An additional independent run of all 17 host scenarios also passed before the final full rerun, recorded at `/tmp/private-market-b-review-host-evidence.json`.

## Provenance and semantic assessment

The reviewer compared all **48 retained kernel test/support files** and their hash manifest directly with the fixed Cargo Git checkout, not merely with a self-generated local manifest. They are byte-identical. The checkout resolves to Cloud `244177cafa26e8c8b001e61297cf4e7f89ac8de9`; native SDK dependencies remain pinned to `f206ca9a6f472b079167c9992c1c1ce1688725af`.

The 243 source cases consist of 202 kernel integration tests, 17 original kernel unit tests run from that dependency checkout, and 24 public inference-domain adaptations. A direct diff against the original domain tests agrees with `upstream/SOURCES.md`: two private contract-validator calls are replaced by public state checks; the private fee helper uses the public integer fee API; the empty validator and the one valid/six invalid schema instances are exercised through native HTTP. These adaptations are disclosed, not represented as byte-identical domain tests.

The cash recovery owner calls the original `RedisBalanceCache::reconcile_balance` at startup and periodically for the same three identities accepted by the test authority. The upstream API retains PostgreSQL user fencing, durable snapshots/outbox acknowledgment and Redis CAS. The host adds no independent wallet arithmetic, financial receipt constructor or terminal interpretation. Its owned task group propagates repair failure to shutdown. The directory is deliberately static; this is not an arbitrary-user recovery service.

| Requirement | Independently observed evidence |
| --- | --- |
| M1 identity/isolation | A rejects missing/forged credentials and foreign status/replay/cancel access; B's foreign Unknown response omits the original request and sensitive proof/fee markers. |
| M2 eligibility | HTTP rejects unsupported model/service/output limits and stale load evidence before a submit effect; kernel tests cover source offering/prediction expiry and frozen terms. The stale-load HTTP test is not described as an expired durable Offer test. |
| M3 funds/capacity | Concurrent cash-limited purchases produce one seller call; after reserve confirmation another purchase returns 402. Distinct buyers share one blocked slot, denied purchases release funds, pending Redis mutations drain, and a second active writer is refused. |
| M4 idempotency | Three concurrent identical submissions produce one original request, submit effect and seller call; A retains changed-content conflict denial. |
| M5 terminal and money | Normal costs 35 provider + 2 platform; exact cap costs 706 + 2. Final focused checks establish their buyer-visible terminal/usage frames. Early cap, refusal, empty and invalid schema are protected; missing usage retains the 4,502 hold pending metering. |
| M6 Unknown/restart | A seller disconnect and SIGKILL after persisted output preserve request identity, event sequence/hash/frame data and the 4,502 hold. The independent seller survives the host kill; no replacement submit or second native call is observed. |
| M7 offline replay | Buyer disconnect precedes seller terminal output; background execution completes. Owner replay before and after host restart is byte-identical, with one execution and unchanged persisted events. |
| M8 authorized replacement | Qualified unaccepted capacity failure A is followed by authorized B; two attempts persist, A retains fulfillment/fee protection, and only B's 35 plus one logical platform fee of 2 is charged. |
| M9 lost settlement ACK | The proxy observes the actual financial-receipt SQL update and backend `CommandComplete(COMMIT)`, then closes the client connection before forwarding that completion. The original receipt and ledger survive restart, with one seller call and one 37-unit charge. No receipt or successful commit is fabricated by the fixture. |

## Limits of this PASS

SQLite tooling/simulation and Cloud's whole private gateway/Core fixture suite were not run. Applicable controlled Chat cases were re-expressed at this host's real HTTP, process and PostgreSQL boundaries; Messages/Responses deployments are not certified. The test counts and documented exclusions are accurate.

The whole pinned Cloud library remains the temporary dependency closure. Small-crate extraction is not completed or required by this batch's verdict. The seller, tokenizer and qualification are synthetic. Process restart and writer fencing do not establish snapshot freshness, rollback protection, TEE attestation, operator confidentiality or production recovery. Real-provider qualification, private deployment and final demo delivery remain batches C, D and E, and are **unaccepted by this review**. These explicit later-batch boundaries are not open B findings.
