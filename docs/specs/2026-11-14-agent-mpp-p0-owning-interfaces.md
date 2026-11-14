# P0 owning interfaces and integration boundaries

Status: proposed narrow interfaces; not new public APIs already present in the
pinned dependencies. Payment contract and controlled implementation:
[P0 v1](2026-11-14-agent-mpp-p0-contract.md).

2026-11-14 amendment: agent pays inference principal; project pays payment and
service-refund gas. Order expiry stops new operations/admission, while original
in-flight or unknown payments continue reconciliation. The proposed interfaces
below reflect this user-approved change. Historical v1 code/acceptance remains
the old snapshot; no sponsor implementation is implied by this document.

## Fixed owning sources inspected

| Owner | Current source | Finding and P1 change |
| --- | --- | --- |
| Browser and wallet | PR #5 `863b6a54cc05e0ed276b15706dba2633dabd28dd`, `clients/market-playground/src/runtime.ts:122`, `clients/buyer-gateway/src/onboarding.mjs:20` | Old `/buyer-api/inference` wrapper, new UUID per request, confidential Intents funding/policy. Replace transport with native Proxy chat and stable logical calls; add a distinct native-chain funding/grant path, retaining owner authentication. |
| Procurement revision | PR #6 `ce103148278090f52fb8578fa7e2dab611e430df`, `crates/private-market-host/src/procurement/bids.rs:95` | `admission_enabled:false`, `provider_dispatched:false`; revision/tick/cancel do not establish supply or execution. Preserve CAS, add reservation/admission command identity. |
| Payment/ledger bridge | Same #6, `services/mpp-nearintents/bridge.mjs:80`, `:259`, `:437` | SDK Store + original ledger/outbox transaction and pre-verification journal are reusable principles. Existing `purchase` credit is general USD funding: it cannot receive raw NEAR or become order-specific merely through metadata. New method must not call this credit path. |
| Request and settlement | Cloud `244177cafa26e8c8b001e61297cf4e7f89ac8de9`, `src/market/inference/contract.rs:42`, `:177`, `:542` | Controls/provider MicroUsd and total NanoUsd; fee frozen by meter; actual provider charge + platform fee. Keep these authoritative; add original-asset/FX/order-purpose funding association, not a replacement ledger. |
| Admission / money writer | Same Cloud, `src/market/pg/coordinator.rs:139`, original `src/market/pg/` money/writer and durable Redis mutation code | Public admit alone does not expose an atomic pre-payment lease + order-purpose native credit + task authorization transaction. Add a narrow owning command and reconcile existing cash/admission fencing. Do not patch cached dependency or claim host HTTP order is atomic. |
| Native identity/recovery | OSS `f206ca9a6f472b079167c9992c1c1ce1688725af`, as pinned by Cloud; original native request/event mappings | Fingerprints include procurement controls. Keep logical native body separate from bid revisions; freeze unique original dispatch identity at admission. Changing an admitted body/cap cannot reuse native idempotency. |

These PRs remain open and this worktree is based on #6. #4 is an ancestor of
#5; #5 browser/wallet code has been inspected at its fixed commit, **not merged
or rewired here**. Current `origin/main` includes later security work; P0 does
not claim that integration has been completed or deployed. No upstream source
or original cash writer is modified in this phase.

## Required commands, not standalone financial stores

All IDs below are durable and authenticated. Agent/task context comes from
server-side owner/grant binding, never model-supplied metadata. Reference money
units must be encoded in type/field names.

```text
prepare_payable_call(
  owner_binding_version, task_authorization_id, logical_call_id,
  native_body_hash, bid_revision, offer_id, expected_offer_revision,
  service_cap_nano_usd, provider_cap_micro_usd, platform_meter_ref,
  principal_yocto_near, fx_quote_ref,
  sponsor_policy_version, sponsor_operation_id,
  payment_start_deadline, credential_expires_at, latest_admission, task_deadline
) -> original_result | {order_ref, supply_lease, task_reservation,
                       sponsorship_reservation, frozen_terms_hash,
                       challenge_record}

record_native_payment_presentation(order_ref, credential_bytes, hash)
  -> durable_journal_ref

consume_native_payment(order_ref, verified_movement, journal_ref)
  -> original_result | {money_commit_ref, original_ledger_entry,
                       purpose_lock, redis_outbox_ref, financial_state}

admit_paid_call(order_ref, original_admission_command_id,
               expected_bid_revision, expected_lease_revision)
  -> original_admission | rejected_with_preserved_liability | unknown

settle_or_hold_order(order_ref, original_terminal_evidence_ref)
  -> {P,C,H,W,R, provider_cost_ref, refund_operation_ids}

confirm_original_refund(operation_id, final_native_movement)
  -> original_result | {confirmed_R, remaining_W, task_release}
```

`prepare_payable_call` must run under one logical writer ordering the original
agent wallet fence, task budget reservation and real supply lease. It rechecks
current owner/task/native permissions, immutable body, aggregate limits, actual
agent spendable native principal, project sponsorship availability and separate
new-payment/admission deadlines. Reserve project gas operational allowance
separately from the buyer's principal; it cannot expand the buyer's debit.
Persist before exposing the 402. If existing
owning stores cannot compose this command, extend them; a best-effort sequence
of HTTP calls is not an implementation. Lease release and money obligations
must remain independently recoverable.

`record_native_payment_presentation` commits before external RPC. Protect raw
credential storage from logs/browser/tool context. Then `consume_native_payment`
uses one original PG transaction: global movement uniqueness, original order
asset/FX record, cash ledger association, purpose restriction and durable
projection outbox. Do not expose cash to ordinary purchases or other orders.
Money arriving for a stale lease remains a liability. No second spendable
gateway wallet is introduced. The test SQLite `purpose` table is **only** a
demonstration of rollback ordering, not this owning implementation.

The purpose restriction needs a constraint or fenced money check that *all*
spend paths honor. Adding an annotation to `credit_ledger_entries.metadata`
does not enforce it. USD cash and native principal must be reconcilable at the
original frozen rate, with explicit rounding surplus/liability treatment.

`admit_paid_call` rechecks exact bid/lease/task authorization revision and
projection readiness, then commits one original admission command. Replays
return original execution/event IDs. If cancellation and admission race, one
writer order wins; after admission it is cancellation of existing execution,
not permission to refund all or launch another request. Payment unknown is
never permission to release the budget, replace the lease and pay again.

## Budget and wallet writer

One logical agent money authority arbitrates *all* task reservations; different
tasks cannot independently see the same native balance. The same task's
committed expense + maximum remaining liabilities cannot exceed its hard cap.
Owner wallet binding and task authorization versions are part of every command.
The soft 25% future reserve cannot release hard reservations. Querying balance,
then sending without a serialized reserve is invalid.

The wallet route accepts an immutable operation containing network, original
agent principal payer, merchant, exact amount/hard principal cap, new-operation
deadline, native policy/grant revision and original idempotency key. It associates
a project sponsorship operation and exposes original signed-action/transaction
recovery. No newly created operation may pass an expired procurement window.
Recovery of the original signed/dispatched/unknown operation can continue after
that window; it does not authorize a second principal transfer.

The sponsor separately owns fee-payer identity, project funding/operational
allowance, relay parameters, its original transaction mapping and actual gas
cost. No additional fee debit/advance by the agent is allowed. Sponsor failure
cannot switch the route back to an agent-paid gas transfer. A configured fee
estimate is not a protocol hard cap. Keep project expenses outside the buyer
cash balance, task authorization and principal conservation equation.

If the route delegates execution, verify original agent authorization, nonce,
inner transfer/merchant receipt and project fee payer; outer relayer signer or
hash alone cannot establish the principal payer. Version the method/route and
evidence schema. The old `nativeNearTransfer`/plain-Transfer verifier is not a
sponsored implementation; NEP-413 cannot stand in for a delegated signature.
See superseded F1 and current G1 in the P0 contract.

Order/MPP expiry and chain validity are distinct. Continue to verify the chain's
nonce/validity rules, but do not require its expiry to equal quote/task wall time.
Known unsigned/unsent operations may close under the original fence; signed,
possibly sent and unknown operations retain principal and sponsorship liability.
Once admission is no longer valid, confirmed money cannot revive the old order:
preserve actual movement evidence and queue a full principal refund. Already
admitted executions retain their original recovery/adjudication semantics.

## Refund and reconciliation writer

Project pays inference payment and service-refund gas, including gas for failed
or late payments; do not reduce the agent's refund or debit another gas amount.
Record original sponsorship/send references and actual project fees separately
from `P/C/H/W/R`. Agent grant revocation does not cancel merchant refund duty.

Under the original order lock, move eligible `H` to `W` and reserve an immutable
refund operation, maximum amount, original merchant sender and versioned agent
destination. Total refund commitments cannot exceed `W`. Persist outbox before
merchant send. On ambiguous ACK recover original signed transaction/operation,
not a new nonce/key. Confirm only with final successful exact reverse native
movement; atomically consume refund movement and move `W` to `R` once. Only then
release corresponding task liability, subject to actual wallet availability.

A revoked buyer grant cannot block merchant refunds. Cross-chain allocation
refunds have separate operation IDs, source asset/destination and 1Click
authority; they never satisfy an inference refund obligation. Wrong asset,
underpayment, overpayment, unassigned and late money enter reconciliation with
actual received amounts; normal method rejection must not delete them.

## Mandatory P1 implementation evidence

Real PG/Redis authority, zero cash bootstrap, order-purpose enforced on every
spend ingress, task/wallet contention, real pre-payment supply lease and
admission race, rollback/COMMIT ACK recovery, projection lag, native body/tool
fingerprint enforcement, expiry reconciliation, merchant refund outbox and
original transaction recovery. The P0 harness passes none of these as a
production integration claim. Under the amended contract, G1 requires the
selected sponsored route to prove agent principal/project gas separation and
original-operation/late-payment recovery. P1 must include controlled sponsor
outages, unknown sends, expiry and late full-refund cases; fixtures do not pass
the live-route gate. Historical F1 no longer describes the selected product
contract, and changing this spec does not retroactively accept new code.
