# Hosted buyer wallet gateway

First implementation on top of browser playground PR #4 (`02d1047`). This adds
NEAR owner login and independent Agent API wallet initialization. **MPP is out
of scope. Real inference procurement is not enabled in this batch.**

The frontend and `/buyer-api` share one origin. Judges use their browser and
NEAR wallet; only the host configures the integration's API key and storage.

## Run locally

Use Node.js 24 or later. The pinned SDK requires it; persistence uses Node's
currently experimental `node:sqlite` module.

```sh
cd clients/buyer-gateway
npm ci --ignore-scripts
# Create .env from .env.example without replacing an existing configuration.
# Supply a stable random 32-byte hex BUYER_STORAGE_KEY through your secret store.
npm run dev
```

In a second terminal:

```sh
cd clients/market-playground
npm ci --ignore-scripts
npm run dev
```

Open `http://127.0.0.1:4173/`. Vite proxies `/buyer-api` to port 4180. A different
development gateway can be selected with `BUYER_GATEWAY_URL`; set
`BUYER_APP_ORIGIN` to the frontend's **exact** origin, including the port.

For a hosted release, build the playground and run the gateway with `npm start`.
It serves `BUYER_STATIC_DIR` as well as the API. Configure the public HTTPS
origin, bind address, stable encryption key, and a persistent database volume.
Run **one gateway process** per SQLite database: owner mutation queues are local
to that process. Multi-replica coordination is not implemented.

## Host configuration

`.env.example` contains empty secret fields and is safe to commit. `.env` and
`.state/` are ignored. No `VITE_` or browser environment variable carries a secret.

- `NEAR_INTENTS_AGENT_API_KEY`: partner credential, kept on the server.
- `BUYER_STORAGE_KEY`: 64 hex characters, kept stable across restarts and backed
  up separately. Changing it makes existing sessions and grants unreadable.
- `BUYER_MERCHANT_ACCOUNT`: reviewed confidential Intents Market payee.
- `BUYER_OWNER_TERMS_URL`: current Owner Terms supplied by the Agent API operator.
  Creation stays unavailable until this is configured; the SDK requires showing
  these terms, OutLayer's terms and the risk notice, and saving acceptance.
- `BUYER_TOKEN_CONTRACT`: reviewed NEAR USDT (default) or USDC issued on NEAR
  contract. This batch uses a six-decimal stablecoin throughout. Native NEAR
  funding and automatic conversion are **not implemented**.
- `BUYER_WALLET_FUNDING_ENABLED`: defaults to `0`. `1` exposes the separately
  confirmed wallet-funding path; it **does not enable inference procurement**.
  Keep it off until the actual route, fees, storage and wallet behavior have a
  dedicated mainnet acceptance. A funded wallet has no recovery/withdrawal UI
  in this batch.

## Implemented flow

1. Connect a wallet supporting combined sign-in/message signing, NEP-366,
   NEP-413 and transaction batches. No function-call key is added.
2. Verify a one-use NEP-413 login challenge and the Ed25519 key's full-access
   permission through mainnet RPC. Set an eight-hour HttpOnly/SameSite session.
3. Save an immutable allocation for 1–8 agents, total principal up to 100 units.
   Divide atomic units with integer arithmetic and retain the remainder in the
   owner's source wallet. Accepting a policy cap creates no funds.
4. For each buyer, sign creation, wait for activation, then sign an independent
   seven-day grant. Owner creation uses a sequential signing queue to avoid
   racing delegate nonces. Creation and grant are distinct signatures.
5. Read back owner, policy synchronization, live grant and available balance.
   Exact policy disagreement prevents funding/readiness. Resume stored work
   after refresh, cancellation or a lost API acknowledgment.
6. If funding is explicitly enabled, create exact-amount deposits, review the
   principal, then ask the owner wallet to confirm NEP-141 transfer batches.
   Query recipient storage registration; include bounded storage deposits and
   the required one yoctoNEAR transfer deposit. Wallet gas/storage confirmation
   is additional to the equal principal. Net credits may differ from principal.
7. Persist `awaiting_chain` **before** returning transfer instructions. Browser
   hashes are hints, not credit. A refresh or cancelled/failed wallet prompt
   cannot automatically send the allocation again. Reconcile the same deposits.

Creation intents and grant tokens are stored in AES-256-GCM encrypted records,
including SQLite WAL writes. Keys and grants never enter the browser, terminal
filesystem, model request, response DTO or application log. Web sessions are
separate from Agent API grants. Disconnect closes the web session; **it does not
revoke a grant**. Configuration, prompt history and fx conversation stores are
scoped to the authenticated account/key.

`/buyer-api/inference` authenticates the owner and buyer but deliberately answers
`503 procurement_not_ready`. No `transfer`, provider API, test-credit refill,
payment receipt, refund, or MPP route is called. The UI's real-mode Run action is
disabled, with no fallback to scripted responses.

## Recovery and current limits

- Server-generated idempotency keys are saved before external calls. Unknown
  outcomes keep their original identities. Saved owner signatures are retried
  unchanged only when the API still reports `PENDING_SIGNATURE`.
- Valid grants and existing wallets are reused. Expired/revoked grants can be
  renewed on the same wallet. An expired **unsigned owner intent** currently
  requires operator reconciliation outside this UI; the app does not silently create another
  agent to replace it.
- One unresolved source-wallet broadcast blocks resending the allocation.
  Automated source-chain reconciliation, partial retry, top-ups, adding agents
  to an existing allocation, and a grant-revocation UI remain future work.
- Upstream deposit failures refund to the agent's own balance, not necessarily
  the original owner wallet. Do not infer a source-wallet rollback from a
  `REFUNDED` status.
- No real Agent API, wallet signature, deposit, or paid inference acceptance was
  performed. The service is a mainnet-only beta; there is no testnet assumption.

## Validation

```sh
npm test
```

Tests use real Ed25519 signatures and the pinned SDK against a controlled HTTP
adapter, plus an actual loopback gateway HTTP server. They cover replay/origin
rejection, ownership, distinct grants, integer allocation, lost acknowledgments,
uncertain results, encrypted persistence, storage costs and disabled procurement.
They do not establish provider settlement or real-wallet popup counts.

`node test/browser-fixture.mjs` is an explicit loopback-only browser fixture. It
uses controlled upstream responses and writes an ephemeral test session under
`.state/`; production startup never imports it. See the
[acceptance record](../../docs/acceptance/2026-11-14-agent-wallet-onboarding.md).

Next integration belongs at the Market: an authenticated order quote, receipt
verification, order-scoped funding admission, metered fulfillment and durable
refunds. Existing general account credit must not substitute for per-order
prepayment. Public TLS and fresh Market/channel verification are also deployment
gates; this gateway does not claim new TEE coverage.
