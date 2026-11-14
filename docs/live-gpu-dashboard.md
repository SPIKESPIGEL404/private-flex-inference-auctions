# Live GPU dashboard

`/gpu` shows actual engine telemetry for the private `qwen3.8-27b` Chute.
The existing playground's provider pane defaults to **Live engine**, with an
explicit **Simulated preview** selector. An unavailable live source never falls
back to fixtures. The dedicated page loads without wallet/terminal WASM.

```text
private Chute GET /metrics -> Prometheus -> buyer-gateway -> same-origin SSE -> UI
```

This uses the existing private metrics Cord from PR #7. It does not update the
Chute, its image or the inference gateway. The current main-based MPP playground
still uses its controlled provider; connecting telemetry does not route those
agent requests to Chutes.

## Run

Requires Node >=24, Docker Compose and a key authorized for the private Chute.
The key stays in its existing private file; only Prometheus mounts it read-only.
No key value enters the browser, gateway environment or Compose source.

From the repository root:

```sh
npm ci --ignore-scripts --prefix clients/buyer-gateway
npm ci --ignore-scripts --prefix clients/market-playground
npm run build --prefix clients/market-playground

export CHUTES_METRICS_KEY_FILE=/absolute/private/path/chutes.key
docker compose -p private-market-gpu-telemetry -f deploy/telemetry/compose.yaml up -d
node scripts/serve-gpu-dashboard.mjs
```

Open **http://127.0.0.1:4188/gpu**. `--port 4189` selects another local port;
`--prometheus http://127.0.0.1:19092` selects another approved Prometheus origin.
The launcher binds only loopback, explicitly enables public aggregate telemetry
on that local origin, and leaves wallet funding/procurement unavailable. Its
SQLite key persists privately under `.market-runs/provider-dashboard/`.

For an existing hosted buyer gateway, configure `PROVIDER_PROMETHEUS_URL` and
the optional job name in `.env.example`. The default requires a valid dashboard
session. `PROVIDER_TELEMETRY_PUBLIC=1` explicitly permits anonymous access to the
curated **global engine** metrics. It exposes no buyer, wallet or settlement
data. Host `/gpu`, `/buyer-api/provider-telemetry`, and its `/events` stream on
the same HTTPS origin. Reverse proxies must allow unbuffered SSE.

Prometheus is pinned by digest, bound to host loopback, capped at 512 MiB RAM
and 256 MB retained data (up to seven days). It uses a read-only root filesystem
and the one file-access capability needed for the operator's 0600 key and data
volume. Its HTTP API is not published to dashboard browsers. Collection
continues when a view is paused, collapsed or closed; GPU wall-clock billing
follows the existing Chutes deployment.

To stop this local monitor, stop the launcher and run the following. The named
Prometheus volume is retained; no Market ledger or Chute is reset:

```sh
docker compose -p private-market-gpu-telemetry -f deploy/telemetry/compose.yaml down
```

## Metrics and freshness

- Five-second scrapes; one fixed, shared PromQL query every ~2.5 seconds.
  Viewers subscribe to the same cache, rather than multiplying upstream calls.
- Running/waiting requests, output/input tokens per second, KV cache usage,
  token-based prefix-cache hit ratio, p95 TTFT/queue time, new KV tokens/request,
  finished requests per second and process-total preemptions.
- Counters use `rate`/`increase` over 60 seconds. Percentiles come from aggregated
  histogram buckets, with seconds converted to milliseconds. Ratios with no
  denominator observations and empty histograms are `null`, rendered as `—`.
- The actual gauge sample timestamp determines freshness, not Prometheus query
  evaluation time. After 20 seconds without fresh data, current values are
  withheld. Failed scrapes may mean cold/restarting/unreachable; this interface
  does not infer exact orchestrator state from `up` alone.
- API-process epochs clear the in-memory chart; boot-spanning/counter-reset
  windows withhold derived metrics. Histories are bounded to 180 points/five
  minutes since gateway startup, with gaps for missing data. Prometheus retains
  the underlying history independently; historical range browsing is deferred.
- This profile supports one target and one engine/model series. Multiple active
  Chute replicas require per-instance scraping, not a load-balanced counter feed.
  The displayed epoch is the engine API process start time, not a hardware proof.

All engine traffic, including Chutes startup and direct invocations, can affect
the feed. KV cache usage is **not** GPU SM utilization or total VRAM usage.
Power, temperature and hardware utilization need a separate hardware exporter.
Samples are ordinary telemetry, not signed TEE execution receipts. Revenue,
margin, SLO goodput and measured baseline uplift require other evidence and are
not presented by Live engine.

## Checks

```sh
npm test --prefix clients/buyer-gateway
node clients/buyer-gateway/test/prometheus-rules.mjs
npm run build --prefix clients/market-playground
```

The PromQL checks use the pinned real evaluator with nonzero counters,
histograms and a worker reset; they contact no provider. An explicit loopback
browser fixture is available at port 4299:

```sh
node clients/buyer-gateway/test/telemetry-browser-fixture.mjs
# Controlled modes: GET http://127.0.0.1:4399/{live,offline,stale,restart}
```

Those values are UI fixtures, not GPU performance evidence. See the separate
[live acceptance record](acceptance/2026-11-14-live-gpu-dashboard.md).
