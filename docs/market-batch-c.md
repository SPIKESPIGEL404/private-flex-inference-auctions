# Batch C: real native inference

Batch C connects the same pinned Market and native Chat execution path to NEAR AI
Cloud. It registers one project-controlled seller, three one-use Offers and three
test buyers. The Offers share one Market capacity slot; the runner purchases them
sequentially. This quota describes the project's admitted work, not NEAR's GPU
fleet or external traffic. Batch B separately tests concurrent shared capacity.

The project authorizes On-demand fulfillment and pays the upstream costs from its
test account. NEAR is the upstream API provider; registering a project Offer does
not establish that NEAR accepted Market refunds, interruption or recovery terms.
The independent host calls NEAR's native HTTPS API directly. No Provider-side
proxy or scheduler is required. The local tokenizer is Market-side infrastructure.

## Offline checks and existing captures

Use the [batch A tools](market-batch-a.md), then:

```bash
bash scripts/accept-market-c.sh
bash scripts/accept-market-b.sh --evidence /tmp/market-c-b-regression.json
python3 -m venv .market-c-tools
.market-c-tools/bin/pip install -r scripts/requirements-market-c.txt
```

The C wrapper validates registration, rejects unsupported native fields before a
probe, requires qualification before serving, checks the original SSE against its
claimed measurement, starts the qualified host, and rejects a modified catalog.
It uses controlled evidence explicitly marked `real_provider: false`, sends zero
inference calls and does not require an API key. B runs the full existing business
and recovery suite. These checks do not replace a real Provider run.

An existing real run can be audited without contacting the inference API:

```bash
.market-c-tools/bin/python scripts/audit-market-c.py \
  --run-dir /absolute/private/captures/successful-run \
  --verify-database --output /tmp/market-c-audit.json
```

`--verify-database` starts only the run's cleanly stopped owned PostgreSQL on a new
loopback port, uses read-only transactions, verifies original result blobs,
receipts, cash ledger, cache mutation completion and the full Market journal hash
chain, then stops it. Do not run this while that database is already running.
The auditor also checks tokenizer file hashes and actual token IDs, original
model/terminal/usage, buyer replay and provider invoice IDs. It makes no inference
calls. Add `--prior-calibration /absolute/private/captures/earlier-run` to include
the retained earlier calibration and enforce the shared task budget allocation.

## Prepare and approve a new live run

Keep credentials and run data outside Git in a private directory. The key file
must contain the test API key; do not put its value in CLI arguments or scripts.
The following paths are placeholders, not the private captures from acceptance.

```bash
.market-c-tools/bin/python scripts/market_c.py prepare \
  --run-dir /absolute/private/new-market-c-run \
  --key-file /absolute/private/near-test.key
```

Preparation queries NEAR's model catalog and downloads only the tokenizer files
at a fixed Hugging Face revision. It does not generate inference. The plan fixes
`Qwen/Qwen3-VL-30B-A3B-Instruct`, a public synthetic text prompt, 128 output tokens
per call, the native request hash, actual local input IDs, tokenizer hashes and
integer prices. Model weights are not downloaded. The runner rechecks model
availability, prices and the request before execution.

Review the printed plan hash, maximum estimated cost and four-call bound. Obtain
authorization for the seller terms and project-paid cost before executing. Supply
the approved **remaining allocation** in microUSD, not an entire task allowance
again if an earlier calibration already spent part of it:

```bash
.market-c-tools/bin/python scripts/market_c.py execute \
  --run-dir /absolute/private/new-market-c-run \
  --budget-micro-usd APPROVED_REMAINING_MICRO_USD \
  --approve-plan-sha256 APPROVED_PLAN_SHA256
```

Do not paste placeholders unchanged. The allowance is a local authorization and
conservative bound at the catalog prices, not a Provider-enforced account spend
limit. The project account must have sufficient credits; a catalog/API price
change or unexpected invoice requires investigation, not an automatic top-up.

Execution creates its own PostgreSQL, Redis, Market state and loopback tokenizer;
registers the original supply; performs **one real calibration**; publishes the
measured throughput; and submits **three real purchases** through Market. Intent
files precede each potentially paid POST. A new invocation refuses an existing
approval file, so a failed or uncertain run cannot silently resume or regenerate.
Keep the original database, evidence and intents. Resolve any Unknown using the
source contract; any new run requires its own explicit plan and remaining budget.
Failure during registration or qualification may leave partially committed
supply. This version deliberately requires investigation instead of retrying it.

## What is qualified

The registration fixes the API model ID, local tokenizer revision/files, endpoint,
credential environment reference, supported native protocol, On-demand service,
integer prices, output bound and project seller responsibility. Serving requires
the original qualified catalog hash. Input IDs come from the pinned tokenizer and
must agree with the real calibration's `prompt_tokens`. The loopback tokenizer
accepts only that exact synthetic request; this is not a general-purpose tokenizer
service for arbitrary prompts, tools, images or structured output.

One completed calibration supplies an observed sample, not a statistically proven
latency SLA or the Provider's physical capacity. The initial conservative Ready
declaration is separate from this real observation. All three Offers refer to
the same upstream and sample; they are not three independent Providers.

The API model ID and Hugging Face tokenizer/model reference do not prove that
NEAR deployed those exact weight bytes. Market-side endpoint binding and captured
native model IDs are functional evidence; attested model identity is not claimed.

Original source result bytes preserve Provider IDs, model, terminal and usage.
Cloud rewrites IDs in buyer-visible replay, so upstream billing uses the original
response ID, not the replay ID. The runner verifies the four native request
invoices using NEAR's billing API, separately from integer test-credit receipts.
Market rounds its Provider charge upward once in microUSD; NEAR invoices in
nanoUSD, so the two amounts need not match at finer precision. Cached input usage
is priced separately. Short prompts can produce a zero platform fee under the
fixed source meter; B validates nonzero platform fees with longer prompts.

The first attempted model used `chat_template_kwargs`, which the pinned Market
meter rejects. The accepted Instruct model uses only standard native fields.
`validate-native-chat` now checks the actual pinned meter and output contract
before any new live calibration, preserving the upstream billing contract.

## Evidence and limits

Private artifacts include original calibration SSE, native request and hashes,
original Provider result JSONL, replay SSE, invoice responses, plan approval,
registration/catalog hashes and the stopped database. They contain sensitive
credentials or identifiers in some files and must remain private. Public evidence
contains only this acceptance's explicitly public synthetic data and summaries.

See the [acceptance record](acceptance/2026-11-11-market-batch-c.md). The Market is
still a local, unattested functional prototype. There is no NEAR chain settlement,
production money, verified operator confidentiality, or real Provider crash/Unknown
recovery acceptance. D and E remain outstanding.

Provider references: [native API quickstart](https://docs.near.ai/cloud/quickstart),
[OpenAI compatibility](https://docs.near.ai/cloud/guides/openai-compatibility), and
[request-level billing](https://docs.near.ai/api-reference/billing/get-costs-by-request-ids).
