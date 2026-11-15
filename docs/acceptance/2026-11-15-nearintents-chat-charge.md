# Direct inference MPP charge — controlled acceptance

The candidate passes **23/23 tests, zero skipped** on Node 24.22.1 and local
PostgreSQL 18.6. The [machine-readable evidence](2026-11-15-nearintents-chat-charge.json)
records source SHA-256 hashes, exact SDK versions and test names. Seven unchanged
native task/client transport regression tests also passed.

The request path is `POST /v1/chat/completions` → standard 402 → official
`nearintents` hash Credential → original chat request → completion/SSE and
official `Payment-Receipt`. It does not use the old funding/credit endpoint.

The official client/server SDK and real PG transactions participate. A real
fx/just-bash runtime makes two separately paid inference calls, executes its local
tool, and independently verifies `{sum:42,count:3}`. Model responses, 1Click and
EVM RPC responses are owned fixtures. Real cryptographic EVM signatures are
generated and decoded; no blockchain transaction is broadcast.

Checks cover request/agent isolation, distinct per-call deposit addresses,
concurrent presentation, replay after restart, atomic SDK consumption rollback,
captured-result write retry, dispatch-crash fencing, lost signer/HTTP ACKs,
same-signed-byte/nonce recovery, source and destination price caps, source gas
caps per transfer and in total, merchant/refund binding, agent speed rejection,
23-digit NEAR atomic precision independent of 6-decimal USDC, and retained
failed-delivery refund liability. CLI tests verify private file permissions,
secret-free review output and the live-start fingerprint gate.

Successful delivery uses the disclosed `fixed-request-v1` price. Usage is recorded
but there is no usage rebate. Provider failure retains the full merchant-asset
refund liability and prevents new quotes; no automatic refund is claimed.

No external paid inference, real source/destination chain settlement, native
NEAR unwrapping, live fee/latency, browser wallet flow, auction-price integration,
new image or deployment was accepted here. The first client supports ordinary
EVM wallets; it is not an all-chain signer. The generic upstream adapter verifies
delivery over transport and does not establish a TEE/model-weight proof.

Reproduce from the repository root with Node 24+ and the two service dependencies
installed:

```sh
CHAT_TEST_DATABASE_URL='postgresql:///postgres?host=/tmp' \
CHAT_TEST_TASK_RUNTIME=1 node --test \
  services/mpp-nearintents/test/*.test.mjs
```

The API implementation and operational limitations are described in
[Paid Chat Completions](../../services/mpp-nearintents/chat/README.md) and the
[contract spec](../specs/2026-11-15-nearintents-chat-charge.md).
