# Private Market playground

The canonical Mono terminal UI for controlled P2 agent tasks and ordinary NEAR wallets. `clients/agent-playground` is a compatibility alias for this same source and build.

```sh
npm ci --ignore-scripts
npm run build
npm test
```

Use the persistent preview container in `deploy/agent-preview` for the complete stack. `npm run dev` proxies `/buyer-api` to `BUYER_GATEWAY_URL` (default `http://127.0.0.1:4180`); choose a backend whose configured public origin matches the browser origin.

In the public preview, connect a NEAR mainnet wallet and sign a NEP-413 login message. Each wallet account receives two isolated controlled agents. No invitation or access code is required. Up to 64 distinct owners can claim the initial 128-slot pool; claims persist without recycling or replenishing budgets. Reconnect to recover the same tasks.

Run the bounded example tasks without funding. Each agent owns an fx runtime, durable tools, task budget and autobidder. The model and inference payment/refund chain are fixtures. New task prompts do not turn the scripted model into a general language model.

Open the wallet panel to create two independent ordinary NEAR implicit accounts. Their random Ed25519 keys stay in encrypted IndexedDB in this browser profile. Download a password-encrypted backup before funding. The server stores public addresses, proof of key possession, and a transfer operation journal; it never receives private keys. Clearing browser data requires restoring that backup and password.

Owner-wallet funding is a real NEAR mainnet Transfer, limited to 0.1 NEAR per request. Returning funds signs a Transfer locally from the agent to the connected owner and retains 0.002 NEAR for storage and gas. Pending operations block replacements, including after restoring an old backup. An unknown owner-wallet result requires the original hash from wallet history. A pending withdrawal can rebroadcast only its original signed bytes. No automatic payment retries occur.

Real funding does not buy or increase controlled inference credit, and virtual refunds are not chain deposits. Real agent-paid inference remains a separate P3 qualification gate. The legacy Agent API adapter is retained for compatibility and is not used by this public path.

## Proposal

`/proposal` and `/proposal/` belong to this application. The proposal uses the same
`SiteHeader`, Geist Mono fonts, monochrome palette and button styles as the task
workspace. Chapter links scroll the reading pane while the header stays in place.
The procurement example remains synthetic and needs no wallet or backend.

Internal try/proposal links use browser history without reloading. Visited views
stay mounted: terminals and wallet state survive the switch, as do proposal
inputs and reading position. Workspace keyboard shortcuts are disabled while
reading. Backend tasks continue under their original limits; switching pages
does not pause, cancel, fund or restart them. Opening `/proposal` directly defers
the workspace bundle and its API discovery until the first visit to try. Modified
clicks and external links retain normal browser behavior.
