# Private Market playground

Browser buyer experience: **one buyer = one fx session = one terminal pane**.
The default mode now connects to the [hosted wallet gateway](../buyer-gateway/README.md)
for NEAR owner login, independent Agent API wallets/grants and saved equal
funding plans. Real inference procurement is still gated off; MPP is excluded.

## Run

```sh
cd clients/market-playground
npm ci --ignore-scripts
npm run dev
```

Open the printed local URL (normally `http://127.0.0.1:4173/`) and start the
gateway as described in its README. Vite proxies `/buyer-api` to port 4180.
`npm run build` type-checks and produces a static `dist/`, which the gateway can
serve on the same origin as the API. Hosts configure keys; browser users do not.
The browser must support WebAssembly JSPI. Unsupported browsers display an error
without silently substituting a fake terminal.

For the original offline fixture preview during development, explicitly open
`http://127.0.0.1:4173/?preview=1`. This switch is disabled in production builds.
Preview and authenticated wallets use separate conversation/configuration
namespaces. Live-mode errors never switch a terminal into preview mode.

## Wallet setup status

- Combined wallet connection/login message; server checks NEP-413 signature,
  one-use challenge and the Ed25519 full-access key on mainnet.
- A signed policy and separate seven-day grant per independent agent wallet.
- Persisted equal-principal allocation, retained remainder, actual balance reads,
  and recovery of the original initialization after refresh or a lost response.
- Partner key and grants stay on the server. The browser handles public owner
  payloads/signatures; their recovery copies are encrypted on the server. The
  owner private key stays in the wallet. Sessions use HttpOnly cookies.
- Funding is disabled by default. If separately enabled by the host, the owner
  must confirm a bounded NEAR-token transfer batch; this does not enable buying.
- Run is disabled until order-scoped Market payments are implemented. Manual
  terminal model calls are rejected by the authenticated gateway. Displayed
  wallet readiness is not evidence of an inference purchase.

No mainnet funding or real-wallet end-to-end acceptance is claimed. The current
funding path uses a NEAR six-decimal stablecoin; native NEAR conversion is future
work. See the gateway's recovery limits and [acceptance record](../../docs/acceptance/2026-11-14-agent-wallet-onboarding.md).

The main page shows Money below the header, buyer terminals in the middle,
and live GPU metrics at the bottom. Wallet balances and configured task limits
have separate sources; unconnected settlement/billing amounts remain `—`.

## Original development preview

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

## Money and GPU overview

Money combines Agent funds and Seller economics. Available uses exact observed
wallet balances, bound to the current owner/key/asset and active buyers. Missing,
partial or >2-minute-old snapshots show `—`; refresh balances performs the
existing status read. Task limits are configured USD limits, not wallet funds.
Spent, Held, Revenue, GPU cost, Refunds and Net earnings remain `—` pending
authoritative settlement/billing feeds. Development preview mode hides actual
wallet amounts. No balance difference or GPU uptime is converted into spend.

The bottom GPU pane uses the buyer gateway and Prometheus for actual queues,
throughput, KV cache and latency windows. `/gpu` opens the standalone view
without wallet/terminal WASM. See the [setup and data contract](../../docs/live-gpu-dashboard.md).
Missing/stale samples never turn into fixtures, and unobserved windows display
`—`. The feed includes all engine traffic and does not imply these terminals
invoked it. Collapse or expand either panel without resetting buyer terminals.

Historical simulated economics components remain in `src/ProviderStatistics.tsx`
and `src/statistics.ts`, but the main dashboard no longer renders them. These
scripted values are not used as money or GPU measurements.

`src/money.ts` owns wallet aggregation and exact formatting; its focused checks
run with Node >=24 through `npm test`. The live backend aggregates histogram
buckets before computing quantiles and guards process/counter resets.

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
The scripted transport submits no real inference. Live telemetry is a separate
read-only feed; existing GPU wall-clock billing remains separate. UI budgets and simulated usage are not a ledger,
spend authorization, successful bid, remote-attestation result or proof of model
execution. This page does not contact NEAR or the deployed Phala Market.

Buyer labels are not interpreted as real authenticated accounts. All panes are controlled by the
same browser owner; separate sessions/workspaces are not a security boundary
against that owner. Do not place real credentials in the preview.

The network request hook and workspace adapter are kept in `src/runtime.ts`.
The wallet-mode hook reaches the hosted gateway and does not forward the local
fx placeholder credential. Connecting the real Market still requires acceptance of
buyer credentials, browser-verifiable channels, current supply, tool transcripts,
metering, hard budget enforcement and idempotent recovery. No deployment, DNS,
real payment or historical acceptance ledger was modified by this batch.

The browser bundle uses a small `fflate` adapter for just-bash's residual
`node:zlib` imports, including output limits. Fonts and WASM are bundled as local
assets. The transitive `undici` dependency is pinned to patched `7.30.2`.
