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

## Deployed runtime

- Runtime source: `364264085636bb79c2ae7c01a24ef1ad8dc6f78d`.
- CI publishing run: `43678771991` (passed).
- Preview image: `ghcr.io/spikespigel404/private-flex-inference-auctions@sha256:9fec33917d55903f1c3d53fe967ac1f8520b02b032ef27a0b3bb59aa87e72deb`.
- Native binary SHA256: `662ccb26dacc39d1967e033a0835619d4c095a9dae3734b574daa2c13b446a97`.
- CVM compose hash: `be73cd94f0fe837c341749be4ae8b732814dbf7426a230793cd88ced9606aa0b`.
- Linux staged runtime passed 24 inferences / 12 task attempts, including the
  restart after inference 16. First-run deadlines, lost payment/refund replies
  and unknown execution custody also passed. The published image's native
  bytes were independently compared to that tested binary.
- The public health endpoint reports the exact runtime revision, controlled
  mode and `realPayment: false`.
- Full fetched manifest comparison passed: only the preview image and its
  revision environment value changed. All ten volume definitions, bindings,
  other service images and manifest metadata were preserved. No pre-launch
  or initialization script was introduced.

## Hosted browser acceptance

Verified in the existing authenticated browser session after deployment:

1. The original two `no_supply` attempts and their transcripts survived the
   CVM update. They displayed expiration and retained their previous records.
2. Reset all replaced both visible attempts with fresh ready workspaces.
3. Run all completed both tasks with `end_turn`, verified `result.txt: 42`
   and $0.001575 spend per attempt. Temporary supply waiting was visible.
4. Clicking Run all again from those completed panes installed two different
   attempt IDs, automatically started them and completed both with the same
   verified fixture result. The final visible state is two completed panes.

The hosted checks exercised virtual controlled procurement only. They did
not initiate wallet funding, withdraw NEAR or enable real inference payments.
