# Controlled supply and task lifecycle repair

The hosted playground exhausted its initial one-use seller authorizations.
The independent Chutes readiness banner did not describe that inventory.
Tasks also expired three minutes after creation, before the first Run.

## Resulting behavior

- The preview runner explicitly enables `PRIVATE_MARKET_P2_CONTINUOUS_SUPPLY=1`
  together with `PRIVATE_MARKET_AGENT_P2=controlled`. Other runtimes retain
  their original finite-seller behavior.
- The serialized Market writer uses existing inventory first. Below two
  available sales it publishes at most one new finite authorization per
  collection, using the original controlled seller terms. Closed generations
  stay immutable. No generation replaces unresolved shared physical capacity.
- Candidate collection reads current source, service and observation bindings.
  An interrupted publication can finish from its durable source generation.
  Synthetic observations remain explicitly synthetic and use a 1ms window.
- Controlled native procurement waits up to the original 15-second Market
  allowance, bounded by its original paid order expiry. Retries retain the
  first frozen window; they cannot reopen an original closed purchase.
- The three-minute task window begins atomically with the first writer claim.
  A durable operation records this even if engine startup fails before the
  first journal entry. Pause, resume, handoff and retries do not renew it.
- Completed and expired panes support Run again and Run all through a new
  attempt. Reset fences the old writer and waits for original settlement.
  Journals, effects, charges and the parent agent budget remain durable.
- The UI distinguishes supply waiting, expiration, interrupted writers and
  the independent Chutes provider observation.

## Validation

The controlled matrix uses real Market, PostgreSQL, Redis, libfx and virtual
just-bash. Seller execution, wallet and chain are local fixtures. It proves
neither real Chutes inference nor real NEAR payments.

Local validation completed:

- 12 task attempts / 24 inference executions in one database, with a full
  service restart after execution 16. Exactly 12 tool effects; original result
  receipts survive. Parent spend is 18,900,000 nanoUSD out of 20,000,000.
- First Run begins the deadline; pause/resume cannot renew it; expired claims
  fail explicitly.
- Repeated reset, operation replay, active-task limits and stale writer fencing.
- No-supply waiting can be paused and resumed. Restart preserves the original
  call start and deadline.
- Unknown execution retains money and dispatch custody, blocks reset and makes
  a second agent wait without a second payment or execution.
- Playground TypeScript/Vite build; 5 client tests; 12 P2 Node tests;
  materialized-source fingerprint and tamper-repair check.

The publishing workflow requires a native binary SHA256 and a release bound
to its exact source commit. Deployment and final Linux-image validation
receipts are recorded separately after publishing. The update must preserve
all existing volume bindings and all other service images and configuration.
