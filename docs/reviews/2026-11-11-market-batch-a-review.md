# Market batch A independent review

- Date: 2026-11-11, America/New_York.
- Verdict: **PASS for batch A — local controlled migration loop only.**
- Open findings: none. No blocking financial, authentication or terminal-semantics regression was identified in the reviewed host integration.
- Reviewed scope: the current working tree against `docs/specs/2026-11-11-private-market-hackathon.md`, the batch A run guide and acceptance record; `crates/private-market-host`, `scripts/accept-market-a.*`, root README and `.gitignore`.
- No implementation files were edited by this reviewer; no commit or push was performed.

## Findings and resolution

**Resolved P3: the original acceptance did not directly establish buyer-visible usage preservation.** The original request at `scripts/accept-market-a.py:119–122` omitted `stream_options.include_usage`, while the native-execution row claimed preservation of finish reason, usage and `[DONE]`. The original stream assertions checked only the output text and `[DONE]`. Reproduction: parse the original buyer SSE into JSON frames; no public usage frame is present. This is expected upstream behavior, not lost financial evidence: pinned Cloud `src/core_gateway/market_inference/stream.rs:748–798` makes usage visibility opt-in, and the original requests still settled for the correct 35 microUSD.

The implementation owner corrected the acceptance request and documentation. Current `scripts/accept-market-a.py:66–74` explicitly checks native `stop` and usage 2 input / 3 output / 5 total tokens; line 132 opts in to usage; lines 147 and 159 apply these checks to live output and replay; line 160 requires byte-identical replay. The final independent full-script rerun included all these changes and passed. This item is closed and does not alter source business semantics.

## Independent verification

Executed from the repository root after the final test correction:

```bash
bash scripts/accept-market-a.sh --evidence /tmp/private-market-a-review-evidence.json
```

The command exited 0. Formatting, Clippy with warnings denied for the host, locked build and actual host/PG/Redis/native-HTTP acceptance passed using the existing compilation cache. Each run created its own temporary PostgreSQL cluster, Redis process, database and private state directory; cleanup completed. No GPU or paid external Provider call was made.

| Observation | Independent result |
| --- | --- |
| Initialization | Three isolated test identities and 25,000 microUSD per buyer; state directory 0700 and credentials file 0600; repeated initialization refused |
| Authentication and ownership | Absent and forged full bearer credentials returned 401; another buyer received 404 for status, replay and cancel |
| Execution and delivery | Three authenticated requests reached the controlled native Chat seller through the pinned implementation; original `stop`, opted-in 2/3/5 usage and `[DONE]` present |
| Replay | Each owner's persisted SSE was byte-identical to that buyer's initial native response |
| Idempotency | Same request/key returned successfully; changed purchase cap returned 409; database held three original requests and three submit outbox effects |
| Financial loop | Each receipt charged 35 microUSD provider cost, 0 platform fee and 35 cash; each final balance was 24,965; no non-applied Redis balance mutations remained |
| Lifecycle | SIGINT after completed requests exited successfully and owned test services stopped |
| Provenance | Both Cloud packages resolve to `244177cafa26e8c8b001e61297cf4e7f89ac8de9`; native SDK resolves to `f206ca9a6f472b079167c9992c1c1ce1688725af` |
| Schema and notice | All four copied SQL files and `LICENSE.bitrouter-cloud` were byte-identical to the fixed Cargo Git checkout |
| Scheduler isolation | Full resolved Cargo metadata contains no `flex-scheduler`; `git diff --exit-code -- Cargo.toml Cargo.lock src` passed |

Cargo reported its upstream duplicate legacy-package discovery warning while selecting the intended Cloud root, and the existing `proc-macro-error2` future-compatibility warning. Neither failed the checks.

## Semantic and dependency boundary

The host uses the actual `RemoteIntrospectionResolver` with a configured source realm and full random opaque test credentials. It does not manufacture a production authentication proof or select the buyer from request JSON. Account seeding writes the original credit-account and ledger schema in one transaction and is isolated to initialization. Runtime purchases, holds, cash settlement, Redis acknowledgment, fenced Market writer, coordinator and native terminal handling remain in the fixed upstream implementation; no competing wallet or replacement terminal interpretation was introduced.

The whole Cloud Git dependency is an intentional **temporary batch A dependency closure** for shared funds, schemas, Redis and authentication. A standalone small Market crate extraction has **not** been completed. The new executable assembles the required Market services; it does not launch Cloud's public gateway, Core, Stripe payment flows or the historical scheduler. Three explicit one-use Offers share one configured execution scope; the sequential acceptance does not prove concurrent capacity enforcement.

## Limits of this PASS

This result establishes the batch A criterion: an independent database and host, controlled native seller execution, owner result/replay, financial receipt and isolated test-credit settlement without a scheduler dependency. It does not establish all upstream invariants merely because their implementation is reused.

- Batch B is unaccepted: the complete applicable source regression suite, concurrent funds/capacity, Unknown and restart behavior, permitted replacement attempts, lost-commit recovery and nonzero platform fees require their own evidence.
- Batch C is unaccepted: the seller, tokenizer, qualification observations and output here are synthetic; no real-model quality, authorized real-seller contract or real-provider metering has been validated.
- Batch D is unaccepted: local HTTP and loopback test authority do not prove TEE attestation, operator confidentiality, encrypted storage, attested endpoint binding or snapshot freshness.
- Batch E is unaccepted: this review does not certify the eventual demo client, deployment reproducibility or final evidence package. No NEAR payment or production-money claim is supported.

These explicit later-batch boundaries are not blockers for the batch A verdict.
