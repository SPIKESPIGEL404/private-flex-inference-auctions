# Private Flex Inference Auctions

A NEAR hackathon prototype for private inference procurement and native Provider execution. The Market protects buyer purchase limits, balances and order conditions; it calls the Provider's native API. The Market and GPU can be deployed separately.

The current implementation is a **local Market host with real NEAR AI Cloud inference**, based on [Cloud PR 667](https://github.com/bitrouter/bitrouter-cloud/pull/667), pinned to `244177cafa26e8c8b001e61297cf4e7f89ac8de9`. It initializes an isolated test-credit ledger and three test buyers. Batch C registers a project-controlled seller and connects native Chat Completions directly to NEAR AI Cloud; batches A/B retain controlled regression endpoints. The Provider requires no proxy or scheduler protocol. The Market is unattested; NEAR chain payments and production funds remain outside this stage.

See the [migration spec](docs/specs/2026-11-11-private-market-hackathon.md), [batch A run guide](docs/market-batch-a.md), and [source/dependency record](crates/private-market-host/upstream/SOURCES.md).

## Real inference acceptance

Three buyers completed native inference on `Qwen/Qwen3-VL-30B-A3B-Instruct`.
Original model/terminal/usage, replay, test-credit receipts and upstream invoices
are independently auditable. The whole task spent US$0.00015355 of the approved
US$0.01, including an earlier calibration. See the [batch C guide](docs/market-batch-c.md)
and [acceptance record](docs/acceptance/2026-11-11-market-batch-c.md).

```bash
bash scripts/accept-market-c.sh
```

This command runs offline registration checks with zero inference calls. A new
live run requires a prepared plan and explicit cost authorization as documented.
Private deployment and final demo delivery remain batches D/E.

## Browser playground

The separate [browser playground](clients/market-playground/README.md) provides
an fx-inspired, monochrome UI with independent fx/wterm/just-bash buyer terminals.
Set the buyer count in the header to retile 1–8 panes automatically. The default
mode now uses a [hosted buyer gateway](clients/buyer-gateway/README.md) for NEAR
owner login, independent agent wallets/grants and equal funding plans. Funding
defaults off and real inference procurement remains disabled. The original
scripted preview is available only through an explicit development switch;
wallet-mode failures do not fall back to scripted responses. No deployed Market
or real funds were changed by this implementation batch.

## Verify the Market before buying

The optional ACI identity endpoint and Node buyer now support fresh hardware
evidence, reviewed release/boot policy and actual TLS SPKI binding before sending
credentials or purchase limits. Local controlled integration is covered without
deployment; real hardware and confidential deployment acceptance remain pending.
See the [buyer verification guide](docs/market-buyer-verification.md).

```bash
bash scripts/accept-market-identity.sh
```

This command creates only local controlled infrastructure and sends no external
inference calls. The production buyer rejects the test's simulated hardware proof.

## Run business and recovery regressions

```bash
bash scripts/accept-market-b.sh
```

This includes the batch A baseline, 219 kernel and 24 public domain tests, and
seventeen controlled host scenarios covering concurrent funds/capacity, native
terminals, authorized replacement, Unknown, process restart, offline replay and
lost PostgreSQL COMMIT acknowledgment. See the [batch B guide](docs/market-batch-b.md)
and [acceptance record](docs/acceptance/2026-11-11-market-batch-b.md).

## Run batch A acceptance

Requires Rust 1.93+, Python 3, PostgreSQL tools and Redis tools on PATH. Cargo needs access to the pinned BitRouter repositories. Run as a normal user (`initdb` refuses root).

```bash
bash scripts/accept-market-a.sh
```

The script builds the independent host, creates its own temporary PostgreSQL cluster and Redis process, checks native SSE, receipts, balances, buyer isolation and idempotency, and stops its owned services. It sends no GPU requests. See the [acceptance record](docs/acceptance/2026-11-11-market-batch-a.md) for the measured scope.

The host is an independent Cargo package under `crates/private-market-host`, with its own lockfile. It has no `flex-scheduler` dependency. Buy caps authorize spending; they do not promise GPU priority or lower latency. Auto-bidder is deferred.

## Historical scheduler experiment

The original scheduler, fixtures and phase-one through phase-four evidence remain available as an independent experiment. Its Chutes evidence applies to that scheduler configuration. Start with the [historical overview](docs/scheduler-experiment.md), [scheduler spec](docs/specs/2026-11-02-external-prefill-gating-scheduler.md), and [phase-four report](docs/acceptance/2026-11-02-phase4.md).

```bash
bash scripts/accept-phase3.sh
```

The new Market does not read the scheduler journal, spool or execution plans.
The [earlier security design](docs/designs/2026-11-03-security-design.md) is preserved as historical context; its proposed capabilities are not current acceptance claims.

[MIT](LICENSE).
