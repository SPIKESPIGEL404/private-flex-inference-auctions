# Live GPU dashboard — 2026-11-14

Scoped live monitoring passed against the private Qwen3.8-27B Chute. The complete
path was exercised: authenticated Chutes metrics -> pinned Prometheus -> fixed
backend query -> same-origin snapshot/SSE -> browser. This is a local monitoring
release, not a hosted frontend rollout or a new inference/TEE acceptance.

The live engine was idle: running/waiting requests and token rates were zero;
latency and cache-ratio windows without observations displayed `—`. Samples
remained fresh and the browser showed Live. No inference, warmup-management,
funding or supply mutation was submitted by these checks.

Validation:

- 23 buyer-gateway tests passed, including eight new telemetry tests covering
  query configuration, zero/null semantics, actual sample freshness, target/
  engine ambiguity, reset windows, shared collection, bounded history, failure
  redaction, read-only HTTP, session/SSE revocation and explicit public mode.
- The pinned real Prometheus evaluator passed two nonzero/reset cases. The
  normal case checks 10 output tokens/s, a 60% token-based cache hit ratio,
  900-ms TTFT p95, 420-ms queue p95 and 24 new KV tokens/request. These are
  controlled fixture values, not real model performance results.
- TypeScript/Vite production build passed. The GPU route was split from the
  wallet/terminal bundle; browser resource checks saw no terminal WASM or
  direct Chutes/Prometheus requests on that route.
- Chromium checked the real feed at 1440×900 and the layout at 390×844 and
  320×844, with no horizontal overflow. Pause/resume and metric selection work.
- Separate loopback UI fixtures checked nonzero values, stale/unreachable
  source handling, recovery and epoch resets. Live/Preview switching and pane
  collapse preserved the original buyer terminal node. Missing telemetry never
  selected simulated data automatically.

Screenshots and private captures are local ignored artifacts under
`output/playwright/` and `.market-runs/provider-dashboard/`. Public sanitized
[JSON evidence](2026-11-14-live-gpu-dashboard-evidence.json) records observation
metadata and source hashes without credentials or buyer data.

The profile assumes one Chute target/engine. It provides five minutes of bounded
UI history since gateway start, with seven-day/256-MB Prometheus retention.
Hardware utilization/power/temperature, signed samples, live economics and
connecting agent inference to this engine remain separate work. The existing
Market ledger, Chute deployment and inference gateway were not modified.
