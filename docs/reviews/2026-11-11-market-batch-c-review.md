# Market batch C independent review

- Date: 2026-11-11, America/New_York.
- Reviewer: independently assigned `gpt-6-astra` review.
- Verdict: **PASS for batch C — the bounded local real-provider Chat inference run and its test-credit settlement.**
- Open findings: **none within the specified C acceptance scope**.
- Scope: C and R6/contract boundaries in the migration specification; `live.rs`, live additions to `main.rs`, the C preparation/execution/offline/audit scripts, runtime requirements, guide, acceptance record and public/private evidence. Uncommitted A/B work was treated as the already accepted baseline.
- The reviewer changed only this report. No new inference, paid operation, source modification, commit, push or TEE operation was performed.

## Independent execution

Executed against the final built host:

```bash
python3 scripts/accept-market-c-offline.py crates/private-market-host/target/debug/private-market-host
TOKENIZERS_PARALLELISM=false .phase4-tools/bin/python scripts/audit-market-c.py \
  --run-dir /Users/kelsen/.codex/private-market-c/near-run-5 \
  --prior-calibration /Users/kelsen/.codex/private-market-c/near-run-2 \
  --verify-database --output /tmp/private-market-c-reviewer-audit.json
```

Both exited **0**. Offline registration checks report `pass`, `real_provider: false`, and zero inference calls. The independent artifact/database audit reports `pass`, `database_verified: true`, and zero inference calls by the auditor. Only tokenizer/configuration libraries were loaded; no model weights or local model inference were used.

The offline checks reject non-HTTPS upstream registration, missing project responsibility, zero budget, wrong call bound, expired qualification and empty token IDs. They exercise the pinned meter preflight, including rejection of `chat_template_kwargs`, refusal to serve before qualification, contradictory original SSE/measurement rejection, qualified host startup and authentication, and catalog-change rejection.

Beyond the provided auditor, the reviewer independently opened both owned, stopped PostgreSQL databases on fresh loopback ports and executed read-only SQL. Earlier run 2 has **zero requests, zero submit effects, and all three balances at 25,000 microUSD**. Successful run 5 has **three requests, three submit effects, and all three balances at 24,978 microUSD**. Each database was cleanly stopped afterward.

The successful database's persisted bootstrap was inspected and asserted independently: one scope, ID 30, `max_unresolved_requests: 1`; exactly Offer IDs 11/12/13; provider ID 7 for all members; and the same backend reference for all three. This agrees with the source construction of three finite seller orders sharing one slot, rather than three independent capacity allocations. Purchases in this real run were sequential; concurrency remains the separately tested B behavior.

The reviewer also compared every successful private evidence field against the public summary and recomputed all four successful upstream invoice costs directly from original usage and registered integer prices. These checks passed.

## Evidence and contract assessment

| Requirement | Verified evidence |
| --- | --- |
| Real provider, fixed route and model | Original calibration SSE and original source result JSONL consistently name `Qwen/Qwen3-VL-30B-A3B-Instruct`; the registered route uses NEAR AI Cloud HTTPS and the project credential environment reference. API model identity is not represented as proof of deployed weight bytes. |
| Actual input measurement | The pinned tokenizer files match their SHA-256 hashes; executing their chat template reproduces the registered token IDs. All accepted responses report 39 prompt tokens, matching those actual local IDs. |
| Real calibration | The captured completed calibration has native `stop`, usage 39/36/75 and elapsed 2,139 ms. Registration precedes the measured observation, whose request/registration/response identities match. All three candidate observations use this real sample. The initial Ready declaration and one-sample throughput observation are explicitly distinguished from an SLA. |
| Terminal, output and usage | Original Provider result blobs have matching source evidence digests, model, `stop`, usage and nonempty output. Buyer replay preserves output-text hash, terminal and usage; its rewritten IDs are not used as upstream billing IDs. |
| Integer settlement and cached input | Each buyer reports 39 input tokens, including 32 cached, and 36 output tokens. At rates 150,000 / 30,000 / 550,000 microUSD per million input/cached/output tokens, the calculation is `(7*150000 + 32*30000 + 36*550000)/1000000 = 21.81 microUSD`. The provider invoice is 21,810 nanoUSD; Market correctly rounds once to 22 microUSD. The zero platform fee is disclosed rather than represented as a positive-fee acceptance. |
| Durable funds and evidence | All three receipts are delivered/committed. Source blobs, receipt revisions, cash-ledger debits and balances agree; durable Redis mutations are applied. The full journal hash chain, final host hash and journal/host agreement pass the independent database auditor. |
| Seller authorization | Registration requires explicit project acceptance of On-demand terms and upstream cost responsibility. Documentation consistently identifies the project as the seller and NEAR as the upstream API provider. No NEAR agreement to Market refund/recovery terms is inferred. |
| Bounded execution and uncertain outcomes | The runner checks the approved plan hash, remaining budget, current prices, exact request/tokenizer and pinned meter before calibration. Exclusive approval/intent files precede paid dispatch; an existing approval prevents blind re-execution. The live catalog admits three finite offers and one attempt per purchase, with automatic fallback off. Failure preserves state and requires investigation. |

Saved billing responses resolve the original Provider response IDs, rather than the buyer replay IDs. The accepted calibration costs 25,650 nanoUSD and the three purchases total 65,430 nanoUSD: **91,080 nanoUSD for the successful run**. The earlier Qwen3.8 calibration has a separate captured terminal, usage, hash and confirmed invoice of **62,470 nanoUSD**. Its buyer request was rejected by the meter before any persisted procurement or submit effect, as independently confirmed above.

The complete observed task therefore has **five real calls totaling 153,550 nanoUSD = US$0.00015355**, below the single **US$0.01** approval. The successful run received **9,937 microUSD**, not another full allowance: 10,000 minus the earlier cost conservatively rounded upward to 63 microUSD. The auditor verifies this shared allocation as well as the actual total. A public evidence JSON is a sanitized summary; the retained original captures and billing responses are the evidence for this specific run.

## A/B compatibility evidence

The implementation owner completed the full final C wrapper and B regression while this independent review ran. The reviewer inspected `/tmp/private-market-c-offline-final.log`, `/tmp/private-market-c-regression.log` and `/tmp/private-market-c-b-regression.json`: formatting, Clippy, locked build, A baseline, **243 source tests and all 17 B host scenarios pass**, with `partial: false`. This review independently reran C offline and the captured/database audit; it does not claim to have independently rerun that entire B wrapper during C review. B also retains its separate independent acceptance report.

Inspection of live mode shows that the same pinned `launch::start_configured`, native execution, financial authority and recovery owner remain in use. C adds qualification, catalog identity checks and external-route assembly; it does not replace the source meter or redefine original terminal/settlement contracts. The earlier incompatible field led to a standard Instruct workload and a preflight check, not an upstream meter patch. Historical scheduler sources and evidence remain outside this execution path.

## Limits of this PASS

This is a local functional real-provider acceptance, **not** batch D private deployment or batch E final demo delivery. No TEE, client attestation, operator confidentiality, snapshot freshness, attested weights, production-money settlement or NEAR chain payment is verified. Saved local evidence and its hash chain are integrity checks under the trusted collector/local-host assumption, not independent remote attestation.

Only this exact public synthetic text-only Chat request is qualified. The tokenizer deliberately rejects other workloads. One calibration is not a statistical throughput or latency claim; one project capacity slot does not control NEAR's external load or physical GPU scheduling. The allowance is a local, price-based bounded authorization, not a provider-enforced account spend limit. New plans require an authorized remaining allocation; the scripts do not constitute a global cross-run spending authority.

The real run did not fault-inject Provider disconnect, Unknown, cancellation or crash recovery. Those controlled B results retain their original scope and are not upgraded into real-provider guarantees. The documentation makes these boundaries explicit. No unresolved C-blocking finding was identified.
