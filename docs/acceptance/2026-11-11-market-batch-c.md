# Market batch C acceptance

- Date: 2026-11-11, America/New_York.
- Result: **PASS for batch C**, including real-provider acceptance and captured
  evidence/database audit. Independent `gpt-6-astra` review **PASS**, no open
  blocking findings. See the [review report](../reviews/2026-11-11-market-batch-c-review.md).
- Cloud and native SDK remain pinned at the A/B source versions. No upstream
  source, root scheduler manifest or root lockfile was modified.
- Runtime: local macOS arm64, Rust 1.97.0, PostgreSQL 18.6, standalone Redis;
  tokenizer-only Python environment, no local model weights.

## Real Provider observations

The user authorized NEAR AI Cloud using a project test account and **US$0.01 for
the task**. The project is the registered seller responsible for Market On-demand
terms and upstream costs. NEAR provides the native API, not an independently
negotiated Market refund or recovery agreement.

Accepted API model: `Qwen/Qwen3-VL-30B-A3B-Instruct`. Local tokenizer reference:
`Qwen/Qwen3-VL-30B-A3B-Instruct@9c4b90e1e4ba969fd3b5378b57d966d725f1b86c`.
This pins local measurement and API routing, not attested upstream weight bytes.

| File | SHA-256 |
| --- | --- |
| tokenizer.json | `a5d85b6dcc535e6b93115a9ef287e6132fdbf30270da6218194ba742261173c7` |
| tokenizer_config.json, including embedded chat template | `c2da771801886ad9ae98181793ffd3dfb7f1af30f6f7c6a4e15d7dbba52e2399` |

Three one-use Offers share a single project Market slot. Three distinct test
buyers made sequential purchases, each with a public synthetic text prompt and
128 output-token cap. No local GPU, scheduler or Provider proxy was involved.
One real completed calibration preceded catalog qualification: 39 input tokens,
36 output tokens, 75 total, native `stop`, elapsed 2,139 ms. This single sample
does not establish a latency SLA. The original SSE hash is in the evidence JSON.

| Buyer | Original native usage: input / cached input / output | Terminal | Provider / platform test microUSD | Final test balance microUSD |
| --- | --- | --- | --- | --- |
| 0 | 39 / 32 / 36 | stop | 22 / 0 | 24,978 |
| 1 | 39 / 32 / 36 | stop | 22 / 0 | 24,978 |
| 2 | 39 / 32 / 36 | stop | 22 / 0 | 24,978 |

Every receipt is delivered and committed. Native result hashes match the source
Strategy's evidence and original stored Provider frames. Buyer replay matches
usage, terminal and output text; another buyer cannot read the request. Exactly
three submit effects exist. Ledger debits and account balances match the receipts;
all durable Redis cash mutations are applied. The independent artifact auditor
also verifies the whole persisted Market journal hash chain and final host state.

The Astra reviewer independently reran offline C checks and the captured/database
audit with the earlier calibration included. Additional read-only SQL confirmed
both runs' request/submit counts and balances, and the persisted single shared
scope/slot with Offer IDs 11/12/13. It independently recomputed successful invoice
costs from usage and rates. Review generated zero new inference calls.

Rates are 150,000 input, 30,000 cached input and 550,000 output microUSD per one
million tokens. Per purchase, the upstream amount is 21,810 nanoUSD, rounded by
Market to 22 microUSD. The short prompt yields zero platform fee under the fixed
source meter. B separately covers nonzero fees. The three frozen caps are 77,
78 and 79 microUSD; unused provider allowances of 55, 56 and 57 are released.

## Actual task cost, including the earlier calibration

| Calls | Count | Confirmed upstream cost nanoUSD |
| --- | --- | --- |
| Earlier Qwen3.8 calibration | 1 | 62,470 |
| Accepted model calibration | 1 | 25,650 |
| Accepted three Market purchases | 3 | 65,430 |
| Entire task | **5** | **153,550 = US$0.00015355** |

The earlier `Qwen/Qwen3.8-27B` calibration completed with input/output 43/45,
native stop and a confirmed invoice. Its Market request was rejected with HTTP
400 `invalid_market_inference` because the pinned meter disallows
`chat_template_kwargs`; its database had zero requests and zero submit effects,
and all three balances remained 25,000. That model was replaced with a standard
Instruct request without changing the source meter. The runner now preflights
the actual meter and output contract before any new paid calibration.

Other preparation/build/setup failures made no inference calls. They are retained
privately, not counted as successful acceptance. A disk-exhausted build initially
left an incomplete executable; execution now requires a valid-sized executable
before recording approval or issuing inference. Only generated Cargo caches were
removed to make room; historical scheduler source and evidence remain.

The accepted four-call run cost 91,080 nanoUSD and received only **9,937 microUSD**
of remaining allocation, after conservatively reserving 63 microUSD for the
earlier 62,470 nanoUSD cost. This is part of the single approved 10,000 microUSD
task budget. The task-level audit verifies both captures and their combined cost.
Invoice IDs come from original Provider frames/headers, not Cloud's rewritten
public replay IDs. No production money or NEAR chain payment was used.

## Reproducibility and evidence

The [C guide](../market-batch-c.md) documents two-phase preparation/approval,
failure handling and independent audit. The [public evidence JSON](market-batch-c-evidence.json)
contains sanitized real-run observations and task-level costs. Private raw native
frames, plan approvals, stopped database and invoices are held outside Git. They
are necessary to independently re-audit the specific run; the public JSON alone
is a summary, not independently authenticated Provider evidence.

```bash
bash scripts/accept-market-c.sh
bash scripts/accept-market-b.sh --evidence /tmp/market-c-b-regression.json
```

The C wrapper makes zero inference calls. The artifact/database auditor also makes
zero inference calls. A new live run requires a new prepared plan, explicit
remaining cost allocation and test credentials. Do not rerun a failed or uncertain
execute directory; preserve original intents and source recovery state.

Both wrappers exited 0 after the C changes: formatting, Clippy and locked build;
the A baseline; all 243 source tests; all seventeen B host scenarios; and C's
offline registration/qualification checks. The completed B inventory is embedded
in the C evidence JSON with `partial: false`. The artifact audit, including the
stopped PostgreSQL and earlier calibration's shared budget, also passed without
new inference. Python/shell syntax and repository credential checks passed.

## Boundaries

No TEE deployment or client attestation is validated. Local plain HTTP is
restricted to loopback. Market-side confidentiality, snapshot freshness and
attested upstream weight identity remain unverified. Real Provider failure and
Unknown recovery were not fault-injected; B's controlled fault evidence retains
its original scope. Only this text-only native Chat workload is qualified. D and
E remain unfinished. There is no new auto-bidder or scheduler dependency.
