# Private Market playground

A local UI/UX prototype of the browser buyer experience: **one buyer = one fx
session = one terminal pane**. Each buyer receives a task and demo budget.
The intended integration makes every fx model call a Market purchase; that
transport is explicitly deferred in this version.

## Run

```sh
cd clients/market-playground
npm ci --ignore-scripts
npm run dev
```

Open the printed local URL (normally `http://127.0.0.1:4173/`). `npm run build`
type-checks and produces a static `dist/`; no application backend is required.
The browser must support WebAssembly JSPI. Unsupported browsers display an error
without silently substituting a fake terminal.

## What works

- One to eight buyer panes, controlled by the buyer count in the header. A fresh
  browser session starts with one buyer.
- Independent `libfx@0.0.16` WASM terminals, wterm/Ghostty rendering, and separate
  just-bash workspaces. Each buyer has its own opaque fx session store.
- Automatic tmux-style tiling, edge-to-edge terminal panes and one-pixel
  separators. Geist Mono and monochrome styling follow `fx.sh/try`.
- Header-only controls for task/budget, buyer count, run/pause all, pane selection
  and zoom. Configuration can apply to the selected buyer or all buyers.
- Reducing the count pauses and parks extra buyers. Increasing it restores their
  identities, configuration and saved conversations in the original order.
- Browser-session configuration in versioned sessionStorage; prompt history in
  buyer-scoped localStorage; opaque fx conversation bytes in IndexedDB, with
  revision checks. Existing v1 localStorage configuration is imported without
  overwriting it.
- Three explicitly scripted UI scenarios: completed turn, waiting for supply,
  and budget stop. Choose a scenario in the buyer settings.
- Responsive tiling, native modal focus handling,
  precise integer microUSD parsing/display, and reduced-motion support.

`Ctrl B`, then an arrow switches panes; `Ctrl B Z` zooms/restores the selected
pane. `Ctrl B %` adds a pane and `Ctrl B X` parks the last pane.
`Cmd/Ctrl K` configures the selected buyer; `Cmd/Ctrl Enter` starts it.
Native fx commands such as `/help` work inside each terminal. The preview's
workspace adapter connects fx's shell tool to a buyer-local just-bash instance;
`market status` is a read-only fixture command.

## Honest preview boundary

The fx runtime and terminal are real. **Responses, supply, purchase states and
usage amounts are scripted illustrations.** The fixture transport returns local
Gateway-format SSE without making a network request. The placeholder credential
is deliberately fake, remains in this transport, and authorizes nothing.
All real provider spend is zero. UI budgets and simulated usage are not a ledger,
spend authorization, successful bid, remote-attestation result or proof of model
execution. This page does not contact NEAR or the deployed Phala Market.

Buyer labels are not interpreted as real authenticated accounts. All panes are controlled by the
same browser owner; separate sessions/workspaces are not a security boundary
against that owner. Do not place real credentials in the preview.

The network request hook and workspace adapter are kept in `src/runtime.ts`.
Connecting the real Market requires a separate implementation and acceptance of
buyer credentials, browser-verifiable channels, current supply, tool transcripts,
metering, hard budget enforcement and idempotent recovery. No production backend,
DNS configuration or existing acceptance ledger was modified for this prototype.

The browser bundle uses a small `fflate` adapter for just-bash's residual
`node:zlib` imports, including output limits. Fonts and WASM are bundled as local
assets. The transitive `undici` dependency is pinned to patched `7.30.2`.
