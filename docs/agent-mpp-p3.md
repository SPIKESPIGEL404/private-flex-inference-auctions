# OutLayer P3 implementation and acceptance

This opt-in runtime replaces Agent API custody with an independent OutLayer wallet per agent. The connected NEAR owner controls the policy; each agent pays native NEAR principal **and gas**. Merchant refunds return native NEAR to the original agent, with merchant-paid gas. The existing Market writer, credit/escrow ledger, reservations, usage authority, response journal and virtual tool workspace remain authoritative.

## Entry points

- `services/mpp-near-direct/p3/launch.mjs`: setup, then the frozen run on the same origin.
- `clients/agent-playground/p3.html`: separate P3 wallet/policy/funding/task UI. Existing production entry points remain available.
- `scripts/prepare-agent-mpp-p3.mjs`: private setup config from an initialized original Market and explicit public run settings.
- `scripts/accept-agent-mpp-p3.sh`: local acceptance, with no real transfers/provider calls.
- `scripts/accept-agent-mpp-p3-testnet.mjs`: explicitly opted-in, bounded real testnet payment/refund component canary. Never run its example journal twice or use a mainnet key.

No Agent API key, NEP-366 delegation or project-funded agent gas signer is required. OutLayer credentials are server-side private files, separate from the public run plan and model input. Registration handoff URLs and API keys are never returned to the browser.

## Owner flow

1. Connect a NEAR wallet and sign the server-issued NEP-413 login challenge.
2. Create each of two independent, unbound agent wallets. Lost registration ACK leaves an unfunded `register_unknown` candidate.
3. Review the transfer-only policy: native NEAR, exact merchant whitelist, per-transfer principal maximum, MPP signing recipient, and no raw signing/swap/Intents/cross-chain capabilities.
4. Sign the ordinary owner `store_wallet_policy` transaction. Independently read back owner, ciphertext hash, version and unlocked/unfrozen state from FINAL RPC; also check the hosted API's displayed policy semantics. A cached installed policy is reconciled rather than stored again.
5. Fund each agent with an owner-signed native NEAR Transfer. The source-send marker is durable before displaying a transaction. After a lost wallet ACK, restore the original transaction hash; do not click/send a replacement. Only an exact FINAL transfer proof activates funding.
6. Activate the immutable run. The merchant policy and refund gas balance must also verify. Sign separate owner spending and project provider-cost approvals, even when both roles use the same account.
7. Run the two agent tasks. Each libfx request calls proxy `/v1/chat/completions`; the MPP client handles 402, native payment, exact original NEP-413 binding and retry. Virtual bash effects and responses retain original IDs through interruption.
8. Pause a task, revoke either run authorization or request an on-chain freeze. Use **Resume task** to resume after pausing; revoked spending requires fresh run authorization first. Resume checks the latest task revision before claiming the original runtime. Freeze preparation pauses/fences local work first. Already dispatched effects remain unresolved until independently reconciled. An agent can receive refunds while frozen.

The optional 1Click adapter creates two immutable source funding legs and requires both vendor original-operation correlation and a rooted FINAL **native** NEAR transfer receipt. A wrapped-token balance or vendor SUCCESS alone is insufficient. The UI displays the source deposit instructions and accepts original deposit/destination evidence; it does not automatically sign arbitrary source-chain wallet transactions. Testnet has no proven solver route; mainnet cross-chain funding remains an external acceptance gate.

## Request qualification and budgets

The original Market validates exact token count and output scope. The real path calls a pinned local model tokenizer for every distinct tool round. It appends the request's profile to the same physical scope, authority and unresolved-request quota, under the original PG writer. The append-only extension preserves existing membership, reports and occupancy; duplicate members or changed physical quotas/authority are rejected. It does not create independent capacity by renaming the backend.

A bounded project-funded calibration call runs **before agent payment** and qualifies that exact scope with the original Rust collector/meter. This is a trusted collector sample (`n=1`), not a provider SLA or independent execution proof. Calibration tool calls are inspected, never executed. The paid response is the one delivered to libfx. Two two-round tasks normally require four calibration plus four paid provider calls. One shared durable project call/USD allowance covers both; paid calls conservatively reserve the full service cap, including platform fees. Failed/ambiguous calibration retains its reservation, blocks that source, and never repeats the POST automatically.

Qualification retries reuse their original profile slot; only a new profile allocates a bounded offering ID under the source lock. After native admission, response recovery uses the Market's authenticated request-event endpoint by original request ID, independently of the active supply profile. A later unknown calibration does not prevent replay of an earlier paid result or release the unknown calibration's reservation.

Principal and payment gas are separate liabilities. Principal uses `P=C+H+W+R`; real gas is charged once under the frozen conversion rate, is never counted as service principal, and is not erased by refunds. Gas reserve is an estimate/stop threshold, not an on-chain hard fee ceiling. Any observed overrun is recorded in full and prevents further purchases. A failed chain transaction's fee proof does not by itself prove the deposit has returned; absent that proof, principal stays held for reconciliation.

## Running a bounded real integration

Prerequisites: Node >=24; Cargo/Rust >=1.93; private loopback PostgreSQL and Redis; a real HTTPS provider/model with tool support and bounded rates; a local model-specific tokenizer using pinned tokenizer files; a funded merchant OutLayer wallet with a project-controlled policy; an independently selected HTTPS NEAR RPC. This runtime is not added to deployment manifests.

```sh
python3 scripts/materialize-market-p3.py
CARGO_TARGET_DIR="$PWD/target/outlayer-p3" cargo build --locked --manifest-path crates/private-market-p3/Cargo.toml
npm ci --prefix services/mpp-near-direct --ignore-scripts
npm ci --prefix clients/agent-playground --ignore-scripts
npm run build:p3 --prefix clients/agent-playground
```

Initialize a **new isolated** original Market with `PRIVATE_MARKET_AGENT_P3=bounded` and `private-market-host-p3 init-live <private-state-directory> <registration.json>`. The version-1 registration is the existing `live::Registration` schema: explicit project supply/cost responsibility, HTTPS origin/model/revision, tokenizer URL/reference/file hashes, a seed token scope, output/context limits, integer input/cache/output rates, request digest, provider budget, `maximum_upstream_calls:4` (legacy registration field) and an offer deadline at most one hour away. P3 separately enforces the aggregate calibration+execution call limit. Do not start a second independent root `serve` process: the Node P3 runtime owns the active native child and the single original PG writer.

Prepare public run settings containing `network`, `ownerAccount`, `projectAccount`, `origin` (including its explicit port), `realm`, HTTPS `rpcUrl`, absolute `hostBinary`, `providerCredentialEnvironment`, verified public `merchantBinding`, `funding`, `agent` and `limits`. Set all caps explicitly; there is no default paid allowance:

```json
{
  "funding": {"kind":"native","perAgentYocto":"100000000000000000000000"},
  "agent": {"principalCapYocto":"10000000000000000000000","taskBudgetNano":"20000000","callCapNano":"3000000"},
  "limits": {
    "maximumProviderCalls":8,"grantDurationMs":600000,
    "gasReserveYocto":"1000000000000000000000","gasFloorYocto":"1000000000000000000000",
    "merchantGasFloorYocto":"1000000000000000000000","merchantGasBudgetYocto":"10000000000000000000000",
    "providerBudgetMicro":"100000","rateNanoPerNear":"2000000000"
  }
}
```

Values above are illustrative test configuration, **not approval to spend**. Conversion is frozen in the signed run; the operator must choose/approve current rates. Generate into a directory with mode 0700:

```sh
node scripts/prepare-agent-mpp-p3.mjs /absolute/private-state /absolute/public-run-settings.json /absolute/private-run/setup.json
node services/mpp-near-direct/p3/launch.mjs /absolute/private-run/setup.json
```

Install the merchant credential as `<credentialDirectory>/<merchantBinding.credentialRef>.json`, mode0600, containing its wallet ID and API key; never commit it or paste it into run settings. Set the provider key through the referenced process environment. Setup writes a private `activated.json`; restart that exact file to recover the frozen run. Root/state, PG, Redis, credential directory and profile journal must persist together. Never restore just a wallet file into a new financial ledger to clear Unknown.

`p3/outlayer-preflight.mjs` checks wallet identity/policy/native balances only. Its `canPurchase:false` deliberately does not certify grants, provider qualification, task completion or deployment. Readiness is established at each original authorization/dispatch/admission fence. Expired runs remain readable/refundable; they cannot make fresh purchases. Startup restores the active original native host for recovery. A missing native ACK without request identity remains review/held; hosted same-key retry guarantees are not assumed.

## Evidence and remaining gates

- [Local five-case matrix](acceptance/2026-11-14-outlayer-p3-matrix.json): actual PG/Redis/original Market, two libfx engines, native-shaped payment/gas double, tool continuations, refunds, restart, lost ACK, signature failure, owner/project revocation and private-plan access.
- [Request-specific qualification](acceptance/2026-11-14-outlayer-p3-native.json): actual Rust qualification and one physical scope, distinct input token counts, bounded calibration+execution, restart, unknown calibration with no payment/repost. Provider and chain are local doubles.
- [Setup integration](acceptance/2026-11-14-outlayer-p3-setup.json): actual auth/PG/HTTP setup through activation/task, policy ACK recovery, duplicate-funding refusal, CSRF rejection and cookie invalidation; wallet and chain are doubles.
- [Real testnet component](acceptance/2026-11-14-outlayer-p3-real-testnet.json): actual OutLayer ordinary Transfer, agent-paid gas, exact NEP-413 and full merchant refund after agent freeze. No real model, Market integration or browser owner in this component.
- [Earlier real wallet policy matrix](acceptance/2026-11-14-outlayer-wallet-policy-evidence.json): allowed payment, excessive amount, non-whitelist destination and frozen wallet behavior.
- [P1](acceptance/2026-11-14-outlayer-p3-p1-regression.json) / [P2](acceptance/2026-11-14-outlayer-p3-p2-regression.json) regression evidence retains its controlled scope.

Still unaccepted: a real browser owner wallet end-to-end; real provider inference joined with real chain payments/refunds; mainnet 1Click funding; hosted OutLayer native idempotency fault injection; production deployment. No independent reviewer was launched: this side conversation prohibits subagents. These gates must not be described as P3 real-money acceptance or gpt-6-astra approval.

Initial local validation before PR review fixes: 84 Node tests, 15 original Market tests, 5 existing Mono UI tests, 22 P1 scenarios, 15 P2 scenarios and 8 P3 integration scenarios passed. Both P3 and canonical Mono browser builds passed. The first P1 Redis-pause run timed out during balance-repair startup under concurrent acceptance load; its complete rerun passed 22/22. This timeout is retained in the validation manifest rather than counted as a clean first run.

[PR #20 review-fix validation](acceptance/2026-11-14-outlayer-p3-review-fixes.json): 84 Node tests, four P3 UI handler tests, six controlled payment/task scenarios, five native-profile scenarios and the owner-setup scenario passed, along with the P3 browser build. New cases cover paid-response journal failure followed by profile replacement or unknown calibration and restart, 40 qualification retries preserving slots for the next agent, and pause/revoke/reauthorize/resume after a tool effect committed. The original Rust binary is unchanged and was verified against the earlier manifest's SHA-256. These checks use local provider/chain doubles; browser wallet and real-provider acceptance remain outstanding.
