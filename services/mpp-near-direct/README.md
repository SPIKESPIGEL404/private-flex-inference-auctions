# NEAR direct MPP: P0 contract and feasibility prototype

This package implements the **P0 payment contract**, integer finance rules,
deterministic cost/speed policy, and independent read-only native-NEAR verifier.
It has no server listener, wallet executor, provider dispatch, deployment command,
or production cash store. Importing it cannot broadcast. The SQLite authority in
`test/` is a controlled feasibility harness, not the Market ledger.

Use Node **24+**, matching Agent API SDK 0.9.1:

```sh
cd services/mpp-near-direct
npm ci --ignore-scripts
npm test
```

From the repository root, `node scripts/accept-agent-mpp-p0.mjs` runs the same
checks and records source hashes and scoped evidence. Tests use generated
Ed25519 keys, controlled RPC/SDK responses, and temporary SQLite files. No
credentials or external funds are needed. SQLite emits Node's experimental
feature warning.

## Frozen v1 proposal

- Method: `bitrouter-near-direct`, intent `charge`, request version 1. Project
  method; no claim of an official NEAR method or NEAR AI merchant integration.
- Asset: native NEAR, 24 decimal places. One plain Transfer action to the
  reviewed merchant. FT, function calls, action batches, and self-payments reject.
- Order binding: a NEP-413 signature from the transaction's full-access Ed25519
  key over `canonical([method,1,realm,challenge.id,SHA256(request),txHash])`.
  The nonce and relying party come from the original server challenge. No callback
  URL. The native policy permits only that relying party and merchant transfer.
- The complete request schema is in `contract.mjs`; unknown wire fields reject.
  mppx's route-level `expires` option is admitted only when equal to
  `expiresAtMs`, and is removed from method wire data. SDK-derived metadata must
  exactly match authenticated `opaque`.
- Refund destination equals the payer in an authenticated versioned binding.
  Credential `source` has no authority. Native signatures authenticate this
  payment/order assignment; they do not create task authorization or supply.
- `nativeReadyBalance` requires finalized, fresh, correctly scoped NEAR-chain
  native-balance evidence after storage locks and project reservations. Intents
  and wNEAR FT balances cannot satisfy it. Evidence is supplied by a trusted
  chain reader/wallet authority, not by a browser or Credential label.
- New Agent policies keep `confidential:true` for API compatibility, but enable
  no Intents spend actions (`actions:[]`). Native permissions are separate; this
  flag does not make native transfers private. Official Policy schema is pinned
  in `test/fixtures/agent-api-policy-contract.json` and validated with AJV.
- A payer could sign two assignments for one transfer. The global money writer
  must accept at most one; there is no intrinsic invoice memo on a plain NEAR
  Transfer. This method chooses **signed assignment + global consumption**, not
  on-chain invoice enforcement. The trusted executor persists the chosen order
  before broadcast and must never reassign it under ambiguity.
- Verify through a configured trusted RPC: correct chain, FINAL, actual signer,
  merchant, one exact Transfer, successful complete receipt graph, actual
  merchant receipt, and full-access key at the finalized inclusion block.
  This trusts that RPC; it is not a NEAR light client or trustless inclusion proof.
- Consumption identity: `near:<network>:<txHash>:<merchantReceiptId>:0`, globally
  unique across methods, wrappers, orders and agents. Same-order replay recovers;
  another order cannot claim the movement even with a second valid signature.
- Late matching money produces a liability, not admission. Expired MPP credential
  recovery needs the separate authenticated reconciliation path, because mppx
  normally rejects expiry before invoking method verification.
- Refund confirmation requires the durable original merchant send operation,
  matching immutable plan hash, operation/key and transaction hash, plus final
  exact reverse movement. An unrelated identical payout is insufficient.

`clientMethod` presents only a recovered persisted original payment. It never
sends on 402. `serverMethod` journals proof before RPC and requires an injected
owning authority to commit consumption, original ledger/outbox and order purpose.
It cannot be used as a complete chat endpoint: auth, native body binding,
budget/supply reservation and unique admission remain mandatory owning seams.
The real Agent API is mainnet-only in the documented beta; testnet objects here
are controlled fixtures, not a claim that the hosted API supports testnet.

## P0 boundaries

Native NEAR / metered prepay-refund were **confirmed by the user** on 2026-11-14.
Other numeric policy defaults are versioned P0 proposals for review, not measured
provider performance. See the
[P0 contract](../../docs/specs/2026-11-14-agent-mpp-p0-contract.md) and
[owning interfaces](../../docs/specs/2026-11-14-agent-mpp-p0-owning-interfaces.md).

The pinned Agent API transfer request has no per-operation maximum fee/fee
ceiling. A wallet balance check or gas estimate cannot enforce a strict gas
authorization. **Real broadcast stays blocked** until a wallet route can enforce
the frozen fee bound before signing, or the user explicitly changes that hard
contract. This prototype does not weaken it or claim P1 readiness.
