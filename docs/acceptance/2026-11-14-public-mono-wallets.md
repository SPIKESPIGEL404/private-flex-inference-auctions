# Public Mono workspace and ordinary NEAR wallets

Scope: one canonical `market-playground` UI, public owner-isolated controlled P2
workspaces, and optional ordinary NEAR mainnet wallets held in the browser.
Agent API credentials and access-code login are absent from the public path.
Real agent-paid inference remains unqualified; this is not P3 acceptance.

## Verification

- TypeScript and Vite production build passed.
- P0/P1/P2 and buyer-gateway Node tests: 83/83 passed. Includes real Ed25519
  NEP-413 verification with a mocked FINAL key query, one-use challenges,
  cancellation during key lookup, cross-owner journal key collisions, concurrent
  holds, old same-amount transaction rejection and known-hash persistence.
- Native wallet controller tests: 5/5 passed. Exact 24-digit amounts, independent
  keys, encrypted backup recovery with a server-side pending journal, two-tab
  serialization, disconnect before broadcast and late login rejection.
- Independent GPT-6-Astra review also exercised known-hash recovery, exact signed
  withdrawal replay and disconnect while auth verification was already in flight.
  Its scope is source and controlled/mock execution, not real transfers.
- Existing controlled P2 integration matrix: 15/15 passed, runner exit 0. This
  preserves native MPP procurement, tool deduplication, pause/manual bid handling,
  refund recovery, shared-agent budgets and unknown-outcome custody.
- Public edge tests: 3/3; install/update preservation tests: 2/2.

## Container and browser evidence

The Linux amd64 container ran with the deployment's read-only root, uid 10001,
1536 MiB memory limit, one CPU, dropped capabilities and isolated data volume.
Two controlled owner sessions were provisioned only inside the owned QA container;
they do not demonstrate a real wallet signing in on mainnet.

- Anonymous agents API and legacy code login rejected with 401.
- Two owners each received distinct agents/sessions. Cross-owner session reads
  and task creation were rejected. Reconnect retained the same allocations.
- The real wallet connector rendered its supported-wallet chooser.
- Two browser fx tasks completed: result files `42` and `19`; four inference
  orders ended refunded, two tools committed, total virtual spend 3,150,000 nanoUSD.
- Browser-generated implicit addresses were distinct. Mainnet read-only RPC
  reported their accounts were not funded. Encrypted backup downloaded; funding
  stayed disabled until backup and explicit real-money acknowledgement.
- Restarting the same container/volume preserved two completed tasks, four orders,
  four refunds, two tools, four claimed slots, 124 unused slots and identical spend.
  No balances or task counts were replenished.

An early QA run exposed malformed new-buyer credentials. They were corrected to
Cloud's original `brk_<credential>.<secret>` format and checked before startup.
The clean container evidence above comes from a fresh test pool after this fix;
no authentication or qualification rule was weakened.

## Persistent and financial boundaries

The public runner uses a new database, state directory and Redis DB 1 inside the
preview volume. The original private preview database/state remain archived;
original gateway services, ledger volumes and sealed environment names are
preserved by the overlay. The initial public pool supports 64 owners, two agents
each, with permanent claims and finite controlled budgets.

Agent private keys are encrypted in owner-scoped IndexedDB using a nonextractable
AES key. Password-encrypted backups use PBKDF2-SHA256 (310,000 iterations), a random
salt and AES-GCM. Public registration verifies possession and cannot replace an
existing agent address. Web Locks serialize local writes; transfer holds and
original transaction associations persist in the server's encrypted journal.

Funding is an owner-confirmed native Transfer, capped at 0.1 NEAR per request.
Returning funds signs locally from the agent to its owner and retains 0.002 NEAR
for storage and gas. Pending transfers cannot be replaced; old same-amount
transactions cannot discharge a newer hold. A withdrawal can resend only its
original signed bytes. A cancelled/unknown wallet submission with no hash remains
held pending wallet-history reconciliation; the app does not infer non-payment.

No real mainnet funding, withdrawal, inference payment, refund or provider
inference was executed for this acceptance. Compatibility of every advertised
wallet has not been tested. The Phala preview's HTTPS termination does not
establish end-to-end TEE TLS. Hosted image, revision and retained-gateway quote
identity are checked separately in the release receipt.
