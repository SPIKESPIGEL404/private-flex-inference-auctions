# Agent MPP integration: controlled Phase 2

P2 connects two independent **real libfx engines** to the native MPP inference
endpoint, persistent virtual bash tools, paid continuation and original Market
accounting. Native model responses, wallet/sponsor operations, NEAR RPC and the
seller are deterministic local fixtures. This proves runtime and money wiring;
it does not establish real model quality, mainnet operation or lower latency.
Real sponsorship G1 and funding/real-task acceptance P3 remain CLOSED.

## Reproduce

```bash
# Node >=24, Rust, PostgreSQL, Redis, git and patch are required.
bash scripts/accept-agent-mpp-p2.sh

# Serve a fresh isolated demo after building; owner codes are written to a 0600
# local context file, never printed or included in acceptance evidence.
python3 scripts/accept-agent-mpp-p2.py \
  target/agent-mpp-p2/debug/private-market-host-p2 --serve /tmp/p2-demo.json
# Open the URL and use ownerCode from that file. Stop with:
touch /tmp/p2-demo.stop
```

`P1_NODE` selects Node; `CARGO_TARGET_DIR` selects a shared build target. The
runner installs locked dependencies, verifies pinned owning source and local
tamper repair, builds P1/P2, builds the browser, runs 62 unit tests, 22 P1
regressions and 15 P2 integration scenarios. Each scenario owns its PG/Redis
processes and temporary data. Dependency/source retrieval can use the network;
inference and payment tests contact only loopback fixtures. Remove a previous
`.stop` file before starting a demo with the same path.

The browser is built in `clients/agent-playground`. It uses libfx WASM and
wterm/Ghostty; Node acceptance uses the same runtime module with libfx's native
addon. It is served by `services/mpp-near-direct/p2/server.mjs` alongside the
authenticated endpoint. The standalone Vite development server is for layout
work; the complete flow runs on the hosted P2 origin.

## Task, budget and native transport

Each owner has distinct agent identities, NEAR payer accounts, private transport
credentials, task sessions and budget state. Owner access codes are an explicit
controlled authentication fixture, not wallet connection or signature login.
No private bearer, grant, deterministic fixture key or signing material enters
the browser, virtual bash environment or model context.

The actual fx model request is POSTed to **`/v1/chat/completions`**. Session,
writer, generation and narrowly versioned recovery metadata use headers. The
hosted per-agent client uses the official mppx 402/credential flow against the
private Proxy; it never inserts a second funding ledger. The legacy
`/buyer-api/sessions/:id/inference` helper is acceptance compatibility only.

PG owns task budgets and aggregate agent authorization. Reserved principal
counts until verified refund FINAL; it cannot finance the next call while a
refund is merely sent. The aggregate trigger uses the original per-user balance
fence, so two tasks cannot independently consume the same agent limit. The
original Market PG/Redis cash projection, admission, execution claim, usage and
cash settlement remain authoritative. Only original financial settlement releases
the single physical seller slot; immutable per-order execution claims remain.

Two layers decide procurement: task remaining budget with a 25% future-call
reserve, then `cost-speed-p2-v1` for the current call. `save`, `balanced` and
`fast` start at one quarter, one half and the full authorized bid respectively.
Fresh synthetic end-to-end forecasts, original task deadline and per-call wait
clock determine whether to accept, wait, raise a bid or stop. Urgency can accept
the existing service up to the hard cap; it does not create a faster product.
Every snapshot and bid revision is durable. Manual bid reductions suspend
automatic increases until explicit `resume_auto`. CAS and operation identities
prevent stale controls or duplicate UI submissions changing terms twice.

The controlled catalog has one model/service, one physical slot and 16 finite
one-use offers. P2 admits the bounded native `bash` schema and max output 64;
other model/tool contracts fail before payment. The synthetic tokenizer bounds
the full transcript/tool schema to 512 units, **pads the qualified input to 512**,
and records the observed unpadded count separately. Provider input usage is 512.
This preserves the original exact-workload throughput qualification. It is not
a production tokenizer, speed benchmark or prediction of actual model costs.
The controlled throughput observation has an explicit synthetic 1-ms window
and 1-ms p95; it never treats database bootstrap elapsed time as model throughput.
The happy-path regression deliberately holds the PG host fence for 1.25 seconds
during bootstrap and still requires original kernel qualification and both tasks.
Native provider cap is 512 + 64×11 = 1,216 micro-USD, plus the original platform
meter's cap. Expected-cost decisions use that same 512-unit billing contract.

Agent principal uses native NEAR (24 decimals), USD prices and frozen integer
FX. Project gas sponsorship and original refunds inherit P1's v2 verifier and
recovery. No Intents quote, solver or Intents payment runs in this hot path.
P2 cannot enable live sending or register a live paid model.

## Durable effects and recovery

The original PG balance fence serializes each agent. A writer generation with
a 10-second renewable lease fences concurrent fx writers; owner pause/revoke
invalidates the writer before new tool effects or admission. Call deadlines and
wait start times never reset across pause, revision or process restart.

FX's opaque journal and marks are append-only, cursor-CAS protected and bounded
to 8 MiB/session. Logical inference intent is `(session, committed workspace
version)`, independent of asynchronous SDK journal timing. Exact original native
body hashes and a persisted native response cache replay a paid response rather
than buy a replacement. An existing exact body always resolves to its original
intent even after later tool progress; the session/body mapping is unique. Only
the pinned libfx 0.0.16 recovery header may remove its atomic, ordered pair of
exact standalone recovery-note suffixes immediately after a tool result. Other body
changes, new output limits or altered instructions conflict. At most four paid
intents are allowed per task, and each later one requires durable tool progress.

`just-bash` operates on an in-memory virtual filesystem without host files,
environment credentials or configured network fetch. Only `/workspace` text files
are persisted. A 2-second execution limit, 200-command/loop caps, 64-file/256-KB
workspace and 64-KB output bound the controlled tool. A tool must match an actual
cached paid native tool call by execution ID and exact command. Workspace and
tool receipt commit atomically in PG. The acceptance command appends to a log,
so duplicate application would be observable; replay returns the committed
receipt. This is an exactly-once durable **virtual effect**, not a guarantee for
arbitrary external tools or host processes.

Full restart scenarios SIGKILL fx, hosted Proxy, Market, wallet and Redis,
immediate-stop PG, and discard/recreate the in-process seller HTTP fixture.
The seller is not a separate OS process; its claims persist in PG. Redis uses
durable AOF; its original ownership marker is retained. Recovery
reuses original wallet operation, payment, response, tool receipt, dispatch and
refund. Unknown execution or unconfirmed metering retains principal/dispatch
custody and stops the task with a diagnostic; it neither invents failure nor
purchases another execution.

## Browser and limits

Each pane runs its own fx engine, can pause while procurement is waiting, and
can be parked/restored independently. Refresh reconstructs terminal history
from paid responses and committed tools, without invoking fx. Completed tasks
return cached results. Logout pauses active tasks and fences writers; stale
owner fetches cannot populate another owner's panes. Artifacts, reserved/spent
amounts and refund state come from PG, not preview counters.

The controlled UI can create one additional task per agent (two total), with
a $0.01 task budget bounded by the existing agent authorization. API controls
also expose task-budget changes, preference, manual bid, cancellation and
resume-auto with revision checks. New tasks have a fixed three-minute deadline;
they do not grant new agent funds. Only two predefined controlled agent IDs are
registered. Broader onboarding, cross-chain funding, real wallet grants, provider
quality, real speed contracts, unbounded agents and production deployment are
outside P2. See [the evidence record](acceptance/2026-11-14-agent-mpp-p2.md).
