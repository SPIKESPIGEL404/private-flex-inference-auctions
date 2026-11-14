# Read-only native metrics — 2026-11-14

The native Chute registers only `GET /metrics`, protected by private-Chute
authentication. It scrapes a fixed loopback engine URL with engine auth and
optional mTLS, rejects redirects and non-metrics content, and bounds response
size and time. Six contract tests passed, including relay media-type handling,
alongside ten historical scheduler regression tests.

The final native source was deployed as version
`2c69b3d4-79be-5660-8ca5-dda527fea545`, SHA-256
`fd07a1db3089904921ac17c07d213186008d0746c51eb6059251a3787ceb44bb`.
Final authenticated HTTP validation is pending that version's GPU activation.

The existing gateway received only measured provider source/version pin updates.
Its hardware/TLS verification and original request replay passed under compose
`9d0e742167036fa74e1c49c266970b41dc5b0f6ed429f6368274eab029578521`.
The same ledger, plan, buyer credentials and historical gateway image remain in
use; that image is not the main-based PR gateway build. Replay retained the
original stream bytes, committed settlement, 389 test micro-USD provider fee and
zero hold. No new buyer inference request was submitted for this update.

The Market advertises only `qwen3.8-27b`. Metrics are operational monitoring,
not signed TEE execution evidence or a trusted capacity reservation.
