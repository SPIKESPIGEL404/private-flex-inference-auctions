# User-funded NEAR Intents tasks enabled on Phala

The user authorized **user-initiated funding and autonomous agent payment**.
The [existing canary entry](https://e83279da3fa5b47453cc62317df738b70fedf08c-3001.dstack-pha1-prod9.phala.network/)
is active. This supersedes the earlier [paused deployment](2026-11-15-nearintents-phala-canary.md).
Automatic paid readiness probes and automatic paid canary tests remain off.

- Runtime source: `d7520499cc43011353676156cc3364dd3960e208`, feature branch
  `codex/nearintents-chat-charge`; no main merge was performed in this run.
- Immutable image:
  `ghcr.io/spikespigel404/private-flex-inference-auctions@sha256:43c72addfb1d3616377ebdfed78390cd96e82981493b634370a1edd94ee75a45`.
- [CI publication](https://github.com/SPIKESPIGEL404/private-flex-inference-auctions/actions/runs/43763427107)
  passed source/binary checks, five activation checks without networking, native
  bootstrap, and Intents fresh-volume/restart bootstrap without networking.
- CVM: `c93b6999-4d41-4567-acdf-0e77d8e7a76f`; compose hash
  `2ea2f6d818548f15d3dcd3f3308fab34fb3cd7c65bc398984c12dbd774c35a9a`.

See the [machine-readable receipt](2026-11-15-nearintents-user-payments.json).

## Enabled behavior

NEAR owner message-signature login opens a private workspace. The user creates
ordinary Arbitrum agent wallets and confirms USDC/ETH funding in their own wallet.
Only a user-started, authorized task may bid through Chat Completions, pay the
winning MPP challenge from its agent wallet, and invoke the provider after
payment confirmation. Agent keys remain in the trusted service.

`ENABLE_NEARINTENTS_USER_PAYMENTS` matches the existing reviewed plan hash.
`ENABLE_NEARINTENTS_PAID_PROBE` remains absent. Free supply checks validate
attestation, authenticated catalog, reviewed rates, fresh FX and remaining
provider budget. **They do not verify usable Cloud credit.** The first real
user task establishes actual paid delivery; billing refusal remains fenced and
failed paid delivery requires refund reconciliation. An unresolved original
paid probe cannot be bypassed by disabling its switch.

The initial two live tasks use 3× / 3.2× starting bids with a 3.2× ceiling and
$0.02 task caps, clamped to agent authorization. New task forms suggest 3× / 3.2×
and $0.02. User-edited existing tasks retain their choices. No task is run by
page refresh; no automatic minimum-price surcharge is added. Every payment
uses a fresh executable quote and remains subject to bridge minimums.

## Verified deployment

The exact manifest differs only in the new entry's image and user-payment flag.
All four original services, eleven volumes, networks, sealed environment names,
plan identity, budget limits and runtime resource/rate settings are preserved.
No pre-launch script or replacement financial state was supplied.

The Phala CLI wait returned an early `Update failed: no error message`. We did
not submit another deployment. The API already contained the exact expected
manifest and reported the update in progress. Observation then confirmed the
same update reached `running`, with the expected healthy image. Market and the
original preview are healthy; domain services are running.

Hosted capabilities report `paymentsPaused: false`. Health reports
`automaticPaidProbeEnabled: false`, `providerReady: true`, read-only readiness
source `near-cloud-attestation-and-catalog`, and `providerCredit: unverified`.
All 26 static files match the final local build byte-for-byte. Proposal returns
200. Unauthenticated chat and agent creation both return 401. Browser reload
shows the active USDC → NEAR banner and user-funding/task-start instructions.
No wallet was selected or signed in by the assistant.

Controlled verification passed **84 checks**: 20 Intents, 40 native regression,
17 playground, and 7 packaging/preservation checks. These use owned fixtures,
not live financial acceptance. No real transfer or paid model request was
initiated by the assistant during this run.

## Retained canary limits and incomplete live acceptance

This remains the bounded canary, with **two agents globally**, **five provider
calls globally**, and a **$0.01 provider allowance**. New purchases stop at
**2026-11-16 15:29:12 America/New_York** (20:29:12 UTC). Existing recovery and
withdrawal paths must remain available; limits cannot be renewed by erasing
financial state or journals.

Real owner login, source funding, MPP settlement, paid model completion,
failed-delivery reconciliation and source withdrawal have not been exercised
on real funds in this run. Successful fixed-price bundles have no usage rebate;
no automatic merchant refund is claimed.
