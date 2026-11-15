# Playground reset and repeat-run regression

Local acceptance on November 14, 2026 (America/New_York), followed by deployment
of `51e99f96d5d7060a57ee5ca629accfcca2019d8e` to the existing public preview.
The [deployment receipt](2026-11-14-playground-reset-deployment.json) verifies the
actual manifest and hosted revision. Online reset works, but full rerun acceptance
is **not passed**: the authoritative Market closes new purchases with `no_supply`.
Original virtual principal is refunded. Do not infer hosted task completion from
the local completion evidence below.

The workspace disabled running completed sessions and provided no reset action.
Creating another task only worked until the agent's lifetime two-task count was
exhausted. A runtime that failed before saving its final result could also leave
the hosted session in `running`. Late pause/resume operations could reopen a
completed session even though its fx journal already contained a terminal turn.
The exact source of the user's original `[refused]` response was not established
from the screenshot alone. Hosted verification subsequently established HTTP
409 `original_execution_closed` and an authoritative `closed/no_supply` receipt.
The task status now exposes that original closure reason rather than showing
only libfx's generic `refused` stop reason.

`reset all` now pauses visible sessions, waits for original settlement, retires
their execution authority, and creates fresh tasks/sessions/workspaces with the
same prompt, task cap and preference. Reset uses an idempotent control operation.
Old journals, workspaces, orders and results remain stored. Agent spend and holds
still aggregate over all tasks, including retired attempts. Only active tasks
consume the two available task slots. Unknown settlement blocks reset.

Runtime close conditionally releases only its own generation, including after
lease expiry. It cannot stop a newer writer or overwrite an owner pause. Late
pause/resume on a complete session leaves that session complete.

Validation:

- TypeScript and Vite production build passed.
- Frontend wallet tests: 5 passed. Backend P0/P1/P2 unit tests: 69 passed.
- `python3 scripts/accept-agent-mpp-p2.py /tmp/private-market-host-p2-debug --case reset`
  passed with real local Market/Postgres/Redis and native fx. It checks fresh
  workspace/journal, repeat reset, lost-ack idempotency, owner isolation, retained
  original evidence and aggregate spend, unsettled reserve rejection, expired
  runtime release, stale-writer fencing, and completed-task control races.
- Playwright exercised real browser WASM fx: initial two-task completion, reset,
  recovery after interrupted browser networking, and a three-pane reset/run with
  two panes sharing one agent. Final sessions all completed with results
  `42 / 19 / 19`, one tool application per session, and cumulative spend retained.
  The [browser ledger snapshot](2026-11-14-playground-reset-browser.json) records
  final active-session spend and cumulative agent totals.

The browser was suspended during one intermediate run, causing network and
writer-expiry failures; recovery was tested by resetting those error sessions.
Local supply/attestation endpoints are absent in this fixture, so their separate
UI panels show unavailable/failed verification. No real provider requests, wallet
funding or chain transactions were performed.

The deployment preserved the same CVM, login, ledger volumes, allowed sealed
environment keys, native binary and other service definitions. Only the preview
image and its source revision changed. Its two visible sessions reset to fresh
ready workspaces. Running them exposed the supply failure above; the page now
shows `[purchase stopped: no_supply]` and exits `running` correctly. The existing
controlled catalog has finite one-use seller offers; this deployment does not
replenish or redesign that supply lifecycle. `provider ready` describes the
separate Chutes readiness endpoint and does not prove this controlled Market has
eligible supply.
