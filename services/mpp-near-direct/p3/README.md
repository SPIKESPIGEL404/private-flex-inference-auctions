# Ordinary-wallet P3 components

Status: **NOT_ACCEPTED — no live proxy or browser payment integration yet.**

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

The original Market earmarked-money admission/settlement hooks, shared browser
payment/withdrawal fence, real tool qualification, task transport and merchant
refund worker still need live integration and end-to-end evidence before merge
or deployment. See the [run plan](../../../docs/specs/2026-11-14-agent-mpp-p3-run-plan.md).
