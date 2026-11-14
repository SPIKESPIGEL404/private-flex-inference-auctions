# Agent wallet onboarding — first implementation batch

Recorded 2026-11-14 UTC (2026-11-13 America/New_York).

Base: PR #4, `02d104739aee2d8f739d4fa305890ff12fe47db3`.
Scope: browser → hosted wallet gateway → NEAR login and Agent API initialization.
MPP is excluded. This is controlled local acceptance, not a mainnet release.

## Implemented boundaries

| Boundary | Result |
| --- | --- |
| Browser → gateway | Same-origin configuration/session API; live mode has no scripted fallback |
| Owner authentication | Real Ed25519 verification of NEP-413, one-use expiring challenge, mainnet full-access key lookup |
| Wallet initialization | Pinned SDK `0.9.1`, per-agent creation + separate grant, seven-day expiry, owner-signed caps and restricted payees |
| Persistence | AES-GCM records + authenticated record identities; private SQLite/WAL; opaque HttpOnly sessions |
| Equal funding plan | Integer division, retained remainder, separate principal/balance, exact-amount deposit identity |
| Source transfer preparation | NEP-141 batch, bounded recipient storage, original address/memo/amount, no duplicate send after ambiguous broadcast |
| Purchase boundary | Hard-coded `503 procurement_not_ready`; Run disabled; no transfer/provider/MPP implementation |

The real SDK's requests are exercised against an in-process controlled HTTP
adapter, not the hosted Agent API. The on-chain access-key RPC is controlled in
automated tests. Source transfers, deposits and settlement observations are
fixtures; they do not establish actual route feasibility or execution.

## Checks

- Node.js `v24.7.0`: `npm test` in `clients/buyer-gateway`: **15 passed**.
- Playground: `npm run build` (TypeScript + Vite). The existing embedded runtime
  still produces a bundle-size warning; the wallet connector is a lazy chunk.
- Both dependency installs: `npm ci --ignore-scripts`; npm audit at installation
  reported zero known vulnerabilities.
- Browser: Playwright CLI with cached Chromium, desktop and 390×844 layout.
  Unconfigured real mode renders genuine fx terminals, reports unavailable host
  configuration and disables Run. Combined-login wallet selection loads the
  connector's actual public manifest; no wallet was selected or signature made.
- Fixed a native-dialog focus issue discovered at that boundary: the wallet
  dialog yields its modal top layer while the connector owns interaction.
- A separate, loopback-only controlled browser fixture seeds two independently
  initialized wallets and an HttpOnly test session. The production build reads
  the session through the real gateway, restores two buyer panes, and displays
  separate wallet IDs and `0.149999 USDT` available balances. `document.cookie`
  does not expose the session. Funding and Run stay disabled.
- Refresh restores the owner's saved task; disconnect removes the server session
  and displays a separate anonymous configuration rather than the owner's task.
  The production `?preview=1` URL does not enable the scripted mode.
- An unsigned three-buyer draft survives first login to an owner with no existing
  allocation, then moves out of anonymous storage. Existing owner configuration
  takes precedence when restoring a returning user.
- Fixed an early fx shutdown rejection during owner changes. Three controlled
  terminals were disposed on their first output, before becoming interactive;
  all three cancelled cleanly with no unhandled browser errors.

Automated negative coverage includes origin denial, replay/expiry, non-full-access
keys, cross-owner and changed-key access, substituted grant messages, lost
generate/submit acknowledgments, uncertain execution, changed policy, fake
transaction hashes, repeated funding attempts and oversized token storage costs.
Grant secrets are absent from response DTOs and plaintext database/WAL pages.

## Remaining acceptance and implementation

- Real-wallet login, NEP-366/NEP-413 signing, observed popup counts and mainnet
  policy normalization still require actual-wallet acceptance.
- Reviewed Owner Terms URL and acceptance evidence are required before creation;
  the host must supply the operator's current URL. No URL is invented by the app.
- Funding defaults off. No source wallet was debited, no agent created on the
  hosted service, and no paid inference was called. The fixture balances are
  not real assets. Native NEAR conversion is not implemented.
- Expired unsigned owner intents need explicit reconciliation; automatic
  replacement is not implemented. Top-ups, resizing an existing allocation,
  partial funding retry, source-chain reconciliation, grant revocation and owner
  withdrawals have no production UI yet.
- The next Market batch must add authenticated quotes, payment receipt checks,
  order-scoped funding admission, native metering/fulfillment and durable refunds.
  Existing account-credit fixtures are not a replacement for that boundary.
- No deployment, public URL, DNS change, new TEE claim or historical acceptance
  promotion is included. Use one gateway process with persistent encrypted state.
