# Paused NEAR Intents canary deployed to Phala

The user selected **deployment only, no real spending** for this run. The new
[canary entry](https://e83279da3fa5b47453cc62317df738b70fedf08c-3001.dstack-pha1-prod9.phala.network/)
is deployed and visibly says **paid inference paused**. The original preview
on port 3000 and the existing Market/domain services remain in place.

- Runtime source: `e0559daaec22b755307b3fd059e2715848450c60`, branch
  `codex/nearintents-chat-charge`; this is a feature-branch canary, not a main merge.
- Immutable image:
  `ghcr.io/spikespigel404/private-flex-inference-auctions@sha256:cf0c3de65ce687869d29a3cba4a3441fac5d5e2d15b2e3c24847d29a7a9e03ff`.
- [CI publication and bootstrap checks](https://github.com/SPIKESPIGEL404/private-flex-inference-auctions/actions/runs/43760483201)
  built the current source on CI and verified the reused Rust binary, native
  startup, and fresh-volume/restart startup for Intents with networking disabled.
- CVM: `c93b6999-4d41-4567-acdf-0e77d8e7a76f`;
  final compose hash `53c264751e2db1095146f1301cfb79e29d3f6fa48f99bd56e45074b977b29251`.

See the [machine-readable receipt](2026-11-15-nearintents-phala-canary.json).

## Accepted evidence

The deployed manifest exactly matches the reviewed preservation update. All
four original service definitions, ten original volumes and original sealed
environment names are preserved. The new service uses its own database, volume
and network. The final update changes only its image and preserves the original
canary plan and credentials. There is no pre-launch script or data cleanup.

The new container, original preview and original Market report healthy. The
original preview still serves revision
`364264085636bb79c2ae7c01a24ef1ad8dc6f78d`. All **26 static files** match the
locally built current source byte-for-byte. Root, Proposal, health and capability
routes return HTTP 200; an unauthenticated Chat Completions POST returns 401.

Browser inspection confirmed the Mainnet Intents profile, explicit paused
message, and the ordinary NEAR wallet selector. No wallet was chosen, no login
message was signed, no agent was funded, and no task was started. The leftover
native-wallet instruction to install a merchant policy was removed for the
Intents profile. Source-token funding and task purchase controls honor the
pause; gas funding for recovery remains separate.

Controlled suites pass: 15 Intents/plan checks, 40 native regression checks,
16 playground checks and 6 activation/preservation checks. The unchanged
standalone charge suite previously passed 23 checks. Live blockchain settlement
and paid model delivery were **not** accepted by these tests.

## Spending remains disabled

`ENABLE_NEARINTENTS_PAID_PROBE` is absent from the deployed service. Public
capabilities report `paymentsPaused: true`; the runtime refuses a new paid
readiness probe without that exact-plan gate. No real transfer or paid inference
was initiated in this run. Health `ready: true` means the web process is running;
the configured `realPayment` capability is not evidence of an executed payment
or usable provider credit.

Earlier read-only preflight found that a 1× bundle was below 1Click's bridge
minimum. The user selected 3× / 3.2× bids for a future finite canary. Dry quotes
were approximately 0.006042 / 0.006444 USDC with an estimated 27-second
settlement time; these are neither current executable offers nor measured
latencies. The original auction formula was preserved. No minimum-price
surcharge was introduced.

The proposed source funding and Cloud allowance were not approved. Actual owner
login, funding, paid readiness, model tasks, source/destination evidence,
unwrapping behavior and source exits still require a newly authorized real run.
No automatic merchant refund is claimed.

The frozen canary plan expires at **2026-11-16 20:29:12 UTC**. Expiry stops new
purchases and must not be bypassed by clearing its financial state or journals.
