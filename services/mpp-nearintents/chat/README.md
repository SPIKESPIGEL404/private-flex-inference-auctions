# Paid Chat Completions

`POST /v1/chat/completions` → official MPP 402 → agent pays → same POST with
Credential → provider completion + `Payment-Receipt`. No platform funding step.
The first contract is a disclosed fixed request price with an output ceiling;
successful requests do not receive usage rebates. Failed delivery retains a full
merchant refund liability for manual reconciliation and closes new quotes.

See the [scope and contract](../../../docs/specs/2026-11-15-nearintents-chat-charge.md)
before selecting this separate mode. It is not yet wired to the existing auction
or browser UI. Existing native NEAR payments are unchanged.

## Controlled verification

Node 24+ is recommended when also testing the existing fx task runtime.

```sh
npm ci --ignore-scripts --no-audit --no-fund --prefix services/mpp-nearintents
npm ci --ignore-scripts --no-audit --no-fund --prefix services/mpp-near-direct
CHAT_TEST_DATABASE_URL='postgresql:///postgres?host=/tmp' \
CHAT_TEST_TASK_RUNTIME=1 npm test --prefix services/mpp-nearintents
```

The database user needs permission to create/drop test schemas. Every test owns
a random schema and removes only that schema. Without `CHAT_TEST_DATABASE_URL`,
PG tests are explicitly skipped; without `CHAT_TEST_TASK_RUNTIME=1`, the fx task
test is skipped. Fixture payments and provider responses never leave loopback.

## Configuration

Copy `payment.example.json` into an operator directory. Replace the placeholder
merchant, token hash, provider URL and future run deadline. Amounts are decimal
strings in the relevant asset's smallest unit. The example prices/caps are
illustrative and must be checked against current 1Click quotes and provider costs.
Public payment configuration never contains keys. The source/destination pair
must have a valid 1Click quote; token-list membership alone is insufficient.

A private launch file refers to separate mode-0600 secret files:

```json
{
  "paymentConfigFile": "/private/payment.json",
  "databaseUrlFile": "/private/database-url",
  "mppSecretFile": "/private/mpp-secret",
  "providerApiKeyFile": "/private/provider-api-key",
  "oneClickJwtFile": "/private/oneclick-jwt",
  "port": 3002
}
```

Omit `oneClickJwtFile` to use unauthenticated 1Click quotations; fees come from
the actual quote. Keep all state across restarts. The server listens on loopback;
publish through the project's HTTPS ingress, preserving the payment headers and
allowing settlement plus inference response time. No permissive browser CORS is
installed.

```sh
node services/mpp-nearintents/chat/serve.mjs /private/launch.json --plan
ENABLE_NEARINTENTS_CHAT='<reviewed planHash>' \
  node services/mpp-nearintents/chat/serve.mjs /private/launch.json
```

The first command performs no quote, payment or provider call. Configuration,
caps and HMAC secret are pinned in PG. A restart cannot rotate them or refill
budgets. All issued quotes conservatively retain their source/provider allowance
for the bounded run, even when abandoned. This intentionally favors bounded
exposure over production throughput.

## Agent wallet and API client

Generate an unfunded normal EVM wallet and independent API token into a new
private file. Only the address and token hash are printed. Use the hash in the
server agent configuration; use a distinct wallet/file/journal for each agent.

```sh
node services/mpp-nearintents/chat/agent.mjs keygen /private/agent-wallet.json
```

Copy `agent.example.json`, bind its refund address to that wallet, and set the
same source asset in both the signer configuration and payment policy. Fund the
wallet with the source token and native source-chain gas before an approved live
run. The auth token does not grant the server access to the wallet private key.

```sh
node services/mpp-nearintents/chat/agent.mjs /private/agent.json --plan
ENABLE_NEARINTENTS_AGENT='<reviewed agent planHash>' \
  node services/mpp-nearintents/chat/agent.mjs \
  /private/agent.json /private/request.json stable-logical-call-id
```

Keep the same logical call ID and identical request file when recovering a lost
response. New IDs mean new purchases. `paidChatTransport(...).invoke` also plugs
directly into `createMemoryTask`'s injected transport; a controlled two-inference
fx/just-bash test verifies the resulting file independently.

The wallet journal is private and durably stores the original signed bytes before
broadcast. A timeout may re-broadcast those identical bytes, which cannot create
a second transaction. It never changes nonce or gas price to replace the payment.
A crash-left `.lock` deliberately stops automatic signing. Stop all processes
using that wallet, inspect its original journal/hash and chain state, and only
then remove the specific stale lock to recover the same operation. Never delete
the journal or use the same agent key with another writer.

## Failure and evidence

- `402`: original payable offer; `terms.usageRebate=false` discloses the price.
- `200`: exact cached completion, official payment receipt and order ID.
- `202`: original provider effect pending; retry the same request/credential.
- `409`: conflict, failed/refunded swap, expired payment or original delivery
  requiring reconciliation. It never authorizes another payment for this ID.

`chat_calls`, `chat_payment_attempts` and `chat_events` retain original evidence.
`refund_due>0` is a liability in the **merchant's destination asset**, not proof of
an executed refund to the source chain. There is no operator shortcut in this
version that marks that liability settled without implementing and verifying an
actual refund. Unknown dispatches cannot be regenerated after a process crash.
The production operating procedure for those cases is still a release gate.

SDK settlement verification trusts the configured official 1Click status service;
it is not an independent source/destination RPC proof or trustless bridge proof.
The EVM outbox's signature tests do not establish live RPC/provider behavior.
