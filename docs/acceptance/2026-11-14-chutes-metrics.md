# Read-only native metrics — 2026-11-14

Live checks passed for the final native source: version `2c69b3d4-79be-5660-8ca5-dda527fea545`,
SHA-256 `fd07a1db3089904921ac17c07d213186008d0746c51eb6059251a3787ceb44bb`.

| Request | Live result |
| --- | --- |
| Authorized `GET /metrics` | 200, `text/plain; version=1.0.0; charset=utf-8` |
| Unauthenticated `GET /metrics` | 401 |
| Authorized `POST /metrics` | 404 |

The authenticated scrape returned 55315 bytes of real
vLLM/engine metrics. Prometheus' Python text parser accepted 86
metric families. This includes running/waiting requests, KV cache, TTFT, token
counters and latency histograms. Chutes reconstructs the Content-Type from
`Response.media_type`; that attribute has a regression assertion. Its external
relay uses `Cache-Control: no-cache, no-transform`.

Six native metrics contract tests and ten scheduler regression tests passed.
The Cord uses a fixed loopback GET with engine auth and optional mTLS, rejects
redirects/non-metrics content, and caps output at 4 MiB with a ten-second timeout.
The Prometheus example uses HTTPS and a separate mounted credentials file; its
YAML was parsed, without deploying a Prometheus server.

The new native instance passed strict source/version/image/revision pinning,
Intel DCAP and signed NVIDIA NRAS verification with a fresh nonce/ML-KEM key
binding. This was a verification-only operation, with no inference submission.
Metrics are ordinary monitoring, not signed TEE execution receipts or trusted
capacity reservations. Loaded weights and CPU/GPU session topology are not
independently hardware-proven.

The existing gateway received only measured provider source/version pin updates.
Its hardware/TLS verification and original request replay passed under compose
`9d0e742167036fa74e1c49c266970b41dc5b0f6ed429f6368274eab029578521`. The same ledger,
plan, buyer credentials and historical gateway image remain in use; that image
is not the main-based PR gateway build. Replay retained original stream bytes,
committed settlement, the 389 test micro-USD provider fee and zero hold. The old
Unknown history volume remains read-only; this update does not adjudicate it.
No new buyer inference request was submitted for this update.

The Market advertises only `qwen3.8-27b`. Exact hashes, HTTP results and scoped
verification evidence are in [the JSON record](2026-11-14-chutes-metrics-evidence.json).
