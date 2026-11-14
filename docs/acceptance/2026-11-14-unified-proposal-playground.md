# Proposal inside the Mono playground

The proposal now lives in `clients/market-playground/src/proposal`. Both views
share `SiteHeader`, local Geist Mono fonts, monochrome controls and separators.
The long-form text, evidence boundaries and synthetic procurement/delivery
example remain intact. Chapter links scroll an independent reading pane below
the fixed application header.

Production-build browser checks confirmed:

- Direct `/proposal` entry leaves the workspace unmounted until visiting try.
- Urgent preference selects illustrative route B; wrong response binding rejects
  the illustrative delivery.
- Switching to try and back retains that preference, delivery selection and
  reading position (1699.5 px in the checked desktop viewport). The workspace
  stays mounted behind the proposal after its first visit.
- Browser back/forward switches views with the same retained example state.
- At 390 px, try/proposal links and horizontally scrollable chapter links remain
  available, with document width equal to viewport width.

The frontend build and all five existing frontend tests pass. The three edge
route tests and three deployment-overlay preservation tests pass. React review
covered hook cleanup, the lazy workspace boundary, stable mounted views,
inactive keyboard shortcuts, accessible navigation and scoped proposal styles.

Local browser checks did not sign in to a real wallet, fund an account or run a
provider call. The local preview proxy could not reach the remote workspace API;
this limits local workspace acceptance to retained DOM/layout and routing.
Wallet/agent lifecycle claims are not established by these UI checks.

`Dockerfile.frontend` supports a UI-only release over the reviewed current
runtime. Its restricted build context includes only frontend source and build
dependencies. The release must retain the existing entrypoint, runtime, volume,
origin and other service definitions; hosted acceptance is recorded separately.
