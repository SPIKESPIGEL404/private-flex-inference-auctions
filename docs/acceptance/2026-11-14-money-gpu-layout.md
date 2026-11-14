# Integrated Money and GPU layout — 2026-11-14

The main page now places the combined Money overview immediately below the
header, preserves buyer terminals in the middle, and shows real engine metrics
in a compact bottom panel. `/gpu` remains available for standalone diagnostics.
This supersedes the main-page Live/Simulated selector described in the earlier
[GPU acceptance](2026-11-14-live-gpu-dashboard.md); that record's measurements
and source hashes describe its original commit, not this subsequent layout.

Money shows owner/key/asset-matched, observed active-wallet balances and
configured USD task limits as separate amounts. Default/unobserved zero is
unknown, while an observed zero remains zero. Partial or >2-minute-old balances
are withheld. Spent, Held, seller Revenue, GPU cost, Refunds and Net earnings
remain `—` because their settlement/billing sources are unconnected. The UI
does not infer spending from an allocation/balance difference or bills from GPU
uptime. A successful balance read supplies the new observation timestamp.

Validation at the source hashes in the adjacent evidence record:

- 23 gateway tests passed, including pre-observation null and successful-read
  timestamp assertions. Five focused Money tests passed for exact large integer
  amounts, observed/unobserved zero, owner/key/asset boundaries, duplicate or
  partial coverage, stale/future observations and independent configured limits.
- TypeScript/Vite production build passed. React review checked effect cleanup,
  owner boundaries, semantic definitions, panel controls, chart resize handling
  and stable buyer keys. No independent reviewer was launched.
- Real Chutes-backed telemetry was observed on the integrated localhost page.
  The engine was idle: actual gauges/rates were zero; empty latency/cache-ratio
  windows stayed `—`. Only the existing same-origin telemetry path was used.
- Separate loopback wallet fixtures showed exactly 0.299998 USDT available and
  $0.30 configured task limits, with Spent/Held and seller amounts still `—`.
  Changing selected buyers retained the aggregate. Refresh issued a GET to the
  existing allocation endpoint. Fixtures do not establish real funding evidence.
- Chromium checked 1440×900, 390×844 and 320×740 layouts without horizontal page
  overflow. The agent workspace retained a 180px minimum height; short screens
  may scroll vertically. Money cards scroll horizontally on narrow screens.
  Panel collapse/restore retained the original buyer terminal DOM node.

This is a local UI release on port 4188. No hosted frontend, wallet funding,
inference procurement, Chute image/deployment or inference gateway was changed.
No new inference call or real transfer was submitted for these checks.
Screenshots and browser states stay in ignored `output/playwright/`; the
[sanitized evidence record](2026-11-14-money-gpu-layout-evidence.json) carries
current source hashes without wallet session credentials.
