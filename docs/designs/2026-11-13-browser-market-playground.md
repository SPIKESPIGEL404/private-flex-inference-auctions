# Browser Market playground — UI/UX scope

The user selected a minimal experience based on `fx.sh/try`: fx + wterm +
just-bash embedded directly in a browser, without an additional application
backend. A buyer is an independent fx agent/session/terminal. The user supplies
its task and budget; each buyer will autonomously procure its own model calls
through the existing Phala Market. Sellers remain registered across orders.

## Scope selected for this prototype

Market procurement for each fx call is deferred. Build the visible interaction
first: pane creation, task/budget editing, independent terminals, concurrency,
focus, pause, persistence and responsive layouts. All supply, response and cost
fixtures must remain visibly identified as scripted preview data. A terminal
running real fx is not evidence that any model was called or any bid was placed.

The implementation is in `clients/market-playground/`. A static application
hosts separate fx terminal instances, each with its own just-bash filesystem
and opaque browser session storage. wterm renders terminal output; fx owns
input editing; just-bash is the workspace behind fx's shell tool. Panes retain
their instances when switching into focused view.

## Interaction

- Visual direction: `fx.sh/try`, Geist Mono, monochrome black/white/gray and
  restrained Vercel/shadcn-style controls. Fonts and WASM are local assets.
- Fresh session: one buyer. An existing v1 browser profile is imported intact.
- Header: buyer count (1–8), task/budget configuration, run/pause all and help.
  A compact session row selects buyers and zooms a pane. No per-pane card,
  toolbar, settings, task annotation or usage footer surrounds the terminals.
- Count changes retile the full workspace automatically according to viewport
  size. Panes touch with one-pixel separators and have stable UUID keys.
- Shrink: pause and park the trailing buyers. Expand: restore them in original
  order before creating new identities. Surviving panes retain their runtime;
  restored panes mount their saved fx conversation.
- Edit: applies to future preview turns; pauses the local runtime first. A
  checkbox applies task/budget/scenario to all active and parked buyers.
- Run all: starts independent sessions concurrently, not one coordinating agent.
- Pause: stops local scripted output. In the eventual live integration, stopping
  local automation must not be treated as proof of upstream cancellation.
- Focus: temporarily enlarge a pane without destroying other runtimes.
- Refresh: recover active/parked configuration from sessionStorage and saved fx
  conversations from buyer-scoped IndexedDB, without issuing real inference.
  The old localStorage configuration is not overwritten. Prompt history remains
  buyer-scoped in localStorage; workspaces remain ephemeral.
- Keyboard: Cmd/Ctrl K configures, Cmd/Ctrl Enter runs, Ctrl B + arrows switches,
  Ctrl B Z zooms, Ctrl B % adds, and Ctrl B X parks the last pane.
- Market information: clearly states that the current preview is disconnected
  and signatures/attestation are not checked.

## Deferred integration

Current live-host constraints include three static buyers, fixed-request
tokenization/qualification, disabled client tools and three finite one-use
offers. Browser-verifiable channels and normal browser certificate trust also
require work. The UI does not relax any of these constraints or reuse historical
hardware/signature checks as a current connection verdict.

Future identity, budget and order authority stay in the existing Phala Market.
Browser storage holds the buyer's local experience, not authoritative funds.
Seller persistence must preserve explicit validity/capacity/authorization;
remaining registered does not imply unlimited free replenishment.

## Provider statistics presentation

A bottom pane previews revenue/GPU-hour, estimated margin/GPU-hour and SLO
goodput/GPU, with earnings/cache/latency/trust views. It shares the terminal's
monochrome styling and edge-to-edge separators; header and pane-label controls
collapse it without unmounting buyer terminals. Charts use solid current-mode
and dashed baseline lines; four experiment modes illustrate the eventual paired
baseline/matching/priority/combined comparison.

The current one-second feed is explicitly simulated. Its sample GPU cost,
baseline and uplift are not real experiment results, and there is no relationship
between its values and the number/activity of buyer terminals. Missing evidence
stays unavailable. Actual source aggregation, seller settlement/cost attribution,
histogram quantiles and experiment provenance must be implemented before a live
data source is presented as measured.
