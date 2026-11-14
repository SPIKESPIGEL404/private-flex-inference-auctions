# Agent API gas-key verification and MVP decision

Checked: 2026-11-14. Scope: public documentation, live public OpenAPI, published
SDK and owning public signing implementation. No wallet was created or changed;
no signature, transfer, funding or deployment was requested. This is capability
research, not acceptance of a real payment or of the unfinished P3 integration.

## Findings

1. NEAR supports gas keys. Gas is charged to a separate key balance; native
   transfers and attached deposits debit the account balance. Transaction signing
   needs the gas-key nonce lane, rather than an ordinary access-key nonce.
   [Protocol documentation](https://docs.near.org/protocol/accounts-contracts/gas-keys).
2. The current public Agent API contract exposes NEAR `sign-message`, `transfer`
   and `call`. Transfer accepts only `to` and `amount`; call has execution `gas`
   but no gas-payer/key/lane selector. Both reject additional request properties
   in the published schema. There is no public NEAR transaction-signing,
   access-key management or custody-key export route in that contract.
   [Live OpenAPI](https://api.agentsonintents.com/openapi.json).
   Download SHA-256:
   `e3903669d7195101cbefb8efc12e2d360e50182d058ffb56f17b35b7963a4372`.
3. Latest published `@near-intents-agent-api/sdk` is `0.9.1`. Its native methods
   forward those requests to the API; it does not construct gas-key transactions.
   The repository head checked was `4e108eff3f015fe55f27fe6f0f64b48525e99b52`.
   [Official SDK](https://github.com/NEAR-Intents-Agent-API/sdk-typescript/tree/4e108eff3f015fe55f27fe6f0f64b48525e99b52).
4. Official native-account documentation assigns transfer/call gas to the agent
   account. NEP-413 message signing is not transaction signing. Native transfers
   require an active grant and allowed destination; asset limits and action-rate
   limits apply, while USD budget and owner-approval controls do not.
   [Native accounts](https://docs.agentsonintents.com/integration/agent-api/native-accounts).
5. This is stronger than merely finding no API parameter: the public OutLayer
   native signer at `2d50bfab14389857e6e50e84e76d5652b944e1cc` constructs
   `Transaction::V0` with `rpc_nonce + 1`. Its Transfer and Call operations use
   that helper. Its access-key query extracts only the ordinary nonce, not the
   gas-key permission or nonce lanes.
   [Signer](https://github.com/out-layer/outlayer/blob/2d50bfab14389857e6e50e84e76d5652b944e1cc/keystore-worker/src/api.rs#L5394-L5499),
   [callers](https://github.com/out-layer/outlayer/blob/2d50bfab14389857e6e50e84e76d5652b944e1cc/keystore-worker/src/api.rs#L5652-L5711),
   [nonce query](https://github.com/out-layer/outlayer/blob/2d50bfab14389857e6e50e84e76d5652b944e1cc/keystore-worker/src/near.rs#L649-L680).

At the running-node source pin, nearcore rejects ordinary-nonce transactions
signed with a gas key as `InvalidNonceIndex`. This confirms why changing only
the key permission cannot make that V0 signer work with gas keys.
[Verifier](https://github.com/near/nearcore/blob/0ad2bdb2630e85bbacecab2a3b77072c78b46bc6/runtime/runtime/src/verifier.rs#L328-L334).

The live OpenAPI identifies OutLayer as custody and describes its native-policy
checks. This associates the public signer with the service architecture; it does
not prove which worker binary is deployed. Agent API server source is not yet
public according to its [TEE documentation](https://docs.agentsonintents.com/integration/agent-api/tee).
The public OutLayer worker also contains an internal hash-pinned raw NEAR signing
operation, but it is not an Agent API public endpoint or a qualified adapter.

**Conclusion:** there is no verified, publicly usable Agent API gas-key route
today. Public native signing uses the ordinary transaction path. Reconfiguring
or funding a key alone is not sufficient for that implementation. We have not
proven that the private deployed backend has no unpublished capability; that
would require an upstream-supported interface and a bounded transaction test.

## MVP recommendation and subsequent user decision

The user subsequently selected: **agent pays both principal and payment gas**.
This selects the existing Agent API native-transfer route and supersedes the
pending-choice status below. The gas-key alternatives remain research only.

Prefer the existing Agent API `nativeNearTransfer` path with agent-paid principal
and gas. Preserve the principal product proof: each independently funded agent
buys inference through MPP and completes its task. Funding preparation can use
Intents; each inference payment uses native NEAR. Keep a bounded gas reserve per
agent, and report inference charges, payment gas and merchant-funded refund gas
separately. Execution gas is not part of refundable inference prepayment.

This changes G1: it cannot claim project-sponsored payment gas. Existing v2
fixtures cannot qualify this replacement. Payment execution must persist the
original API request, idempotency key and correlation ID, hold unresolved
operations, and independently verify the eventual transaction. It cannot claim
to possess raw signed bytes that the public API does not return. Task/run totals
still need application controls in addition to the provider's native limits.

If project-sponsored gas is mandatory for the MVP, independent project-hosted
gas keys remain a candidate. They satisfy the principal/gas split at protocol
level, but require new account/key provisioning, key custody, recovery and
operational qualification. `GasKeyFullAccess` gives full account authority;
merchant and task restrictions are not an on-chain allowlist. This custody
change has not been selected or authorized by the user.

Waiting for an upstream gas-key integration is the other option. Qualifying it
requires an explicit key provisioning/funding interface, TransactionV1 gas-key
signing, durable nonce/idempotency recovery, and FINAL evidence that the account
pays only principal while a project-funded key pays gas. Gas keys alone do not
establish a latency improvement.

P3 integration resumes on that native route. The local integration edits remain
unfinished and unaccepted; prior gas-key component-review evidence is not
acceptance of the native route or those later edits.

An independent `gpt-6-astra` reviewer reached the same public-capability and
deployment-boundary conclusions. This research does not lift P3's
`NOT_ACCEPTED` status. The subsequent explicit user choice changes G1 to native
agent-paid principal and gas; it does not itself pass G1.
