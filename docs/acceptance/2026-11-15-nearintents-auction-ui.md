# Auction + NEAR Intents + playground acceptance

Implemented locally on `codex/nearintents-chat-charge`, extending the original
standalone candidate. The existing AuctionMarket is the sole allocation, price
and financial authority; the existing market-playground renders and runs the
agent tasks. No PR push, merge, deployment or real-spend acceptance is claimed.

The [machine-readable record](2026-11-15-nearintents-auction-ui.json) binds the
changed source, SDK versions, owning binary hash and test output. On Node
24.22.1 / PostgreSQL 18.6, **96 automated checks pass with zero skipped**:

| Gate | Passing checks |
| --- | ---: |
| Intents auction, source funding and live-plan gates | 14 |
| Existing native-auction/provider/wallet PG regression | 40 |
| Previous standalone Intents charge regression | 23 |
| Playground controller, wallet and funding tests | 15 |
| Startup/packaging activation gates | 4 |

The original Rust owning-schema verifier passes before and after the Intents
suite. Adapter metadata drift is rejected separately. Tests cover winning bid
pricing, no loser payment, exact allocation/contract/request binding, SDK/Market
atomic rollback, original-credential replay, slow-route refusal, revocation
during settlement polling, retained full refund liability, owner isolation,
exact source funding proof, immutable original hashes and exits using the same
nonce/transaction. Two real fx/bash runtimes independently verify sums 42 and 19.

Browser acceptance uses the built UI, a dedicated owning PG/Redis stack,
official MPP SDK and backend cryptographic agent signatures. Owner wallet,
1Click/source RPC and model replies are controlled fixtures:

- Create two independent agents, fund each with fixture USDC and ETH through
  the actual wallet UI, configure the existing bid multiplier and use two panes.
- Both tasks run the real browser fx/WASM/bash runtime and independently verify
  `/workspace/result.json` against their own three-number input (sums 42 and 19
  in this final run). The exported selected artifact verifies sum 19, count 3.
- Four Chat Completions purchases produce exactly four original source
  transfers, four provider calls and four settled Market orders. Activity shows
  the winning bid, fixed merchant principal, source USDC, ETH gas and official
  receipt. Fixture gas is not a live fee measurement.
- Reloading clears local task memory, shows original financial history and
  adds no payment/provider effect. Evidence export preserves the verified
  artifact.
- Freeze an agent, withdraw its remaining source USDC and ETH, and observe two
  confirmed exits with refreshed source balances. Merchant refunds remain a
  separate liability; an exit is not recorded as a merchant refund.

[Completed tasks and orders](2026-11-15-nearintents-auction-browser.png) ·
[Wallets and source exits](2026-11-15-nearintents-auction-wallets.png).
The browser's four HTTP 402 console entries are the expected MPP handshake.
No application exception is accepted as a successful task.

TypeScript/Vite builds successfully. An intermediate Linux/amd64 runtime overlay
built and imported the Intents runtime in a network-disabled container. After
the final guard/balance fixes, rebuilding hit local disk exhaustion and Docker
BuildKit's metadata I/O error; Docker subsequently became unavailable. **The
final image is not accepted.** Task-owned Rust build caches were removed,
space was recovered, and the affected PG suite was rerun successfully. No
unrelated image, volume, worktree or deployment was removed or changed.

Live activation remains separately gated. Real swap minimums/economics, actual
source/destination settlement, native NEAR unwrapping, live cross-chain latency,
attested Cloud completion on this payment profile, merchant refund tooling and
the final image/deployment still require acceptance. Successful bundles have no
usage rebate. Agent keys are held by the trusted service; this is not a
smart-account-enforced policy or an all-chain wallet implementation.

See the [contract and limitations](../specs/2026-11-15-nearintents-auction-ui.md)
and [operating instructions](../nearintents-auction-operations.md).
