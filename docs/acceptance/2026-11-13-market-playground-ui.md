# Browser playground UI/UX acceptance

Scope: local prototype only. Per-call Market procurement, real buyer credentials,
live model responses, seller replenishment and browser attestation are deferred.
The deployed Phala Market was not changed. No inference call or provider spend
was made for this work.

## Implemented and checked

- Real `libfx@0.0.16` WASM terminals with independent wterm/Ghostty cores and
  buyer-local just-bash workspaces. Native fx `/help` opened in the browser.
- Three concurrent fixture responses, with separate complete/waiting/paused UI
  states. The fixture transport never invokes network fetch.
- A new-buyer dialog created two additional buyers with Chinese tasks and
  independent identities/configuration. A budget with seven decimal places was
  rejected; a valid `$0.004` budget was accepted.
- Focusing and restoring a pane preserves its runtime. Hidden panes keep their
  layout dimensions instead of being resized to zero.
- The `Control+B`, then `Z` shortcut focused and restored a buyer. Hidden pane
  dimensions remained nonzero during focused view.
- Pausing immediately after starting all buyers stopped fixture streams and
  showed zero active sessions. Pausing an idle buyer does not send an extra
  Ctrl+C that would exit fx.
- Reload restored buyers, budgets, usage illustrations and original fx
  conversation content. It did not increment the completed-turn count or start
  new provider requests.
- Desktop and narrow-screen layouts were inspected in the browser. Small
  screens stack panes with a scrollable workspace and preserve input controls.
- Browser session bytes are buyer-scoped and revision-checked in IndexedDB.
  Configuration and prompt history are local and versioned/scoped.

## Build checks

`npm run build` passes TypeScript and produces a static bundle. The built version
was served separately and its WASM terminals were checked in the browser. The
dependency audit reported zero known vulnerabilities at this check.

Direct checks verified integer-microUSD format/parse round trips, rejection of
invalid and over-precision budgets, and browser compression round trips/output
limits for the just-bash compatibility adapter. `git diff --check` passed.

These are UI/UX and runtime-wiring results. Scripted model responses and UI usage
numbers do not constitute autonomous-agent quality, auction, real-spend budget,
account isolation, hardware or cryptographic response acceptance. Source and
run instructions: [playground README](../../clients/market-playground/README.md).

## Terminal-native redesign — 2026-11-13

This revision supersedes the initial card/grid interaction described above.
It adopts Geist Mono, pure monochrome styling and the header proportions of
`fx.sh/try`. Panes now contain only the native fx terminal; task, budget, count,
preview information and actions live in the header or its dialogs.

- Browser checks exercised counts 1, 2, 4 and 8, then shrinking and restoring.
  The first four buyer UUIDs remained unchanged. Four panes tiled a 1280×720
  viewport as a full 2×2 workspace below the 94px header, with no card gaps or
  controls inside the panes.
- Direct geometry checks covered counts 1–8 at desktop, narrow and wide aspect
  ratios: rectangles covered the workspace without overlaps or uncovered areas.
  Resize sequences preserved buyer identity, simulated usage and turn counts;
  invalid counts were rejected.
- Ctrl B % expanded four panes to five; Ctrl B X returned to four. Configuration
  from the header saved an edited task and survived reload, along with the
  four-pane count and existing buyer UUIDs.
- At a 390×844 viewport, all four panes remained inside the workspace; document
  width and scroll width were both 390px, with no page overflow. The temporary
  viewport override was reset afterward.
- The new version stores active and parked configuration in sessionStorage v2.
  Legacy localStorage configuration remains intact. Shrinking pauses extra
  buyers and restores their saved fx conversations when expanded again.
- Scripted responses were shortened to a small `[preview]` line. Old saved fx
  conversations remain available; the redesign does not erase their history.

The revised TypeScript/static build passes. These checks remain UI/UX acceptance
only; the Market transport and real inference are still deferred.

## Provider statistics preview — 2026-11-13

Added a collapsible, terminal-style provider pane for the proposed single-GPU
vLLM / Qwen3.8-27B / RTX PRO 6000 experiment. This section verifies presentation
and interaction only. Every feed value, baseline and percentage change is
scripted browser-local data, independent of buyer terminal activity. There is no
wallet settlement, provider telemetry, hardware-counter or attestation connection.

- The three readouts are revenue/GPU-hour, estimated margin/GPU-hour and SLO
  goodput/GPU. Earnings, cache, latency and trust views are available, together
  with baseline, matching, priority and combined modes.
- Browser checks verified zero uplift in baseline mode, zero priority fees and
  non-applicable priority fulfillment without priority service, and a negative
  goodput difference in the priority-only sample. Trust fields remain explicitly
  unconnected/unavailable; an assumed GPU cost is disclosed.
- Pausing the statistics feed held the chart points unchanged across collapse,
  expansion and buyer-count edits. The feed controls do not start or pause fx.
- Collapsing increased terminal workspace height and retained the original buyer
  UUIDs. Eight panes remained nonzero in size; returning to three preserved the
  original three identities. Existing fx conversations resumed from storage.
- Keyboard tab navigation switched earnings to cache; selecting the margin
  readout switched the plot and returned to earnings. No browser console errors
  were recorded during these checks.
- Layouts were checked at 1280×800, 390×844 and 320×740. Narrow header controls
  were adjusted to fit, including a final 320px check where the control group's
  scroll width equaled its available width. Experiment/view preferences survived
  reload; the feed restarts as a fresh sample stream.
- The static TypeScript/Vite build passes with the existing embedded-runtime
  bundle-size warning. No dependencies were added. Direct checks verified sample
  revenue = base service + priority fee − refunds, margin = revenue − assumed
  cost, bounded ratios and undefined relative changes at a zero baseline.

Quantile snapshots are supplied by the scripted source and are not averaged by
the UI. Connecting live evidence and demonstrating actual revenue improvement
remain separate work.
