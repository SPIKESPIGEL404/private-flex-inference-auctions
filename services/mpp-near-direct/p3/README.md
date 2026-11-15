# Ordinary-wallet P3 components

These local-key protocol tools coexist with the selected OutLayer custody route.
`outlayer-native-verification.mjs` and `outlayer-preflight.mjs` serve that route;
`native-verification.mjs` and `preflight.mjs` retain the local-key tooling API.
See the [OutLayer runtime](../../../docs/agent-mpp-p3.md) and the separately
accepted [real Cloud MPP CLI loop](../../../docs/near-cloud-outlayer-mpp.md).

Status: **testnet protocol accepted; native-funded B/browser integration NOT_ACCEPTED.**

`native-verification.mjs` independently verifies an ordinary agent's original
MPP Transfer and derives actual payment gas from the same complete FINAL
transaction. `native-sender.mjs` is the trusted local merchant/acceptance sender;
it is not a server wallet for production agents. `preflight.mjs` reads the
dedicated mainnet funding plan without loading keys or sending transactions.

The encrypted SQLite journal commits signed bytes before broadcast, fences
unresolved sends by account, pins the signing key and policy, retains a nonce
highwater, and recovers the same original transaction. A gas reserve is an
estimate, not a chain gas-price ceiling. Actual overrun blocks new sends.

With Node 24, run `node --test test/*.test.mjs p3/test/*.test.mjs` from the parent
directory. The component tests cover a lost ACK, a fresh Node process reopening
SQLite, concurrent preparation, stale RPC nonce, key/budget changes, failed
evidence, pending-account fences and read-only funding checks. They do not
constitute real-provider or real-payment acceptance.

The explicit `testnet-mpp.mjs <private-directory> <stable-case-id>` harness runs
the official HTTP MPP SDK with real testnet native payments and merchant refunds.
`testnet-reconcile.mjs <private-directory>` independently refunds expired,
unfulfilled cases using their original payment and refund journals. Neither
script connects the original Market cash authority or a real inference model.
Only testnet credentials are accepted. Historical FINAL RPC snapshots may be
cached for repeated verification; current account balances and unresolved
transactions are never cached. Send calls have a timeout and no hidden retry.

The recorded real testnet run and independent no-cache reviews are under
`docs/acceptance/2026-11-14-testnet-mpp*`.

The original Market earmarked-money admission/settlement hooks, shared browser
payment/withdrawal fence, real tool qualification, task transport and merchant
refund worker still need live integration and end-to-end evidence before merge
or deployment. See the [run plan](../../../docs/specs/2026-11-14-agent-mpp-p3-run-plan.md).
