# PR20 + PR24 bounded Testnet integration

Approved target: integrate real Testnet tasks, native payments and refunds, then
expose a separate Testnet entry. Keep the current mainnet-wallet/P2 entry intact.
This file records the integration contract; deployment acceptance is separate.

The browser owns fx/just-bash task memory using PR24. AuctionMarket owns bids,
allocation contracts, budget/native liability, result admission and settlement.
PR20 supplies OutLayer wallet operations and independent chain/policy verification;
its separate Cloud financial harness and its server-side task journal do not
become a second financial authority for auction orders.

Ordinary Testnet wallets authenticate owners. Each owner creates two distinct
OutLayer agent wallets, installs and verifies their merchant-only policy before
funding, then explicitly starts a task under an owner/agent/task budget. Agent
wallet credentials stay in the trusted service and never enter browser/model
inputs. Existing mainnet agent wallets, keys and balances are not migrated.

The live server is a separate bounded-testnet mode with real adapters. Local
fixture gates remain closed to real broadcasts. HTTPS origin, NEP-413 network
binding, owner isolation, Secure cookies, body bounds and rate/agent limits are
required. Native payment gas is paid by the agent; merchant refund gas is paid by
the merchant. Chain fees and provider cost retain distinct evidence/accounting.

Every payment/refund/provider operation has one immutable original operation.
Persist an intent before outbound effects; lost ACK/unknown never authorizes a
new payment POST, new inference call, replacement nonce or released liability.
Late/fenced payments are refund-only. Owner freeze/revoke prevents new purchases
without preventing recovery/refund of an already paid original order. A browser
refresh never restores tools or starts purchases; financial recovery continues.

NEAR AI Cloud is the first live provider for this integration. Freeze its public
tariff and response/model evidence scope before admission. Capture and verify the
original provider response and native usage before settlement. Market auction
charges differ from the upstream Cloud account invoice. One test NEAR per USD is
an explicitly labelled test accounting convention, not an exchange rate. The
project allowance starts bounded at USD0.01 with unknown calls retaining their
reservation; never reset it on restart. No stronger model-weight proof is implied.

Deployment must build frontend and binaries from the merged source rather than
relabel the prior archive. Include the shared client task module in Docker build
contexts. Keep the no-pre-launch image deployment, pin GHCR digests, use a new
Testnet data volume/database, and compare the live CVM manifest immediately before
updates. Preserve original services/volumes and provide an additive rollback.

Acceptance requires controlled regression, owning PostgreSQL concurrency and
unknown/replay cases, fresh image builds, a real Testnet owner/agent setup, real
provider task/tool continuation, FINAL payment/refund/gas evidence and restart
replay with zero added effects. Browser wallet-extension acceptance and full
hardware/channel verification must be reported only when actually performed.
