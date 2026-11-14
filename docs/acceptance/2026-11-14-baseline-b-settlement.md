# Fixed B: settlement and supply readiness

This extends PR #17's operator A/B harness with actual Market credit-ledger
settlement projection and a read-only provider readiness path. It does not turn
the public controlled agent workspace into native-chain inference payment.

The receipt route is now scoped to the live catalog market ID. The client checks
signature, request ID, idempotency key, committed terminal state, integer money
arithmetic and authorization bounds before exposing a service charge. Provider
service charge, platform charge, promo, cash debit and released hold remain
separate. Public verification keys and verifier identity are retained with private
journal evidence. Late receipts reconcile after expiry without a new dispatch.

The gateway observes pinned deployment metadata and fresh CPU/GPU evidence. A
verified instance must also match active supply. Offline, warming, failed and
expired observations are ineligible. Both client and Market gate dispatch;
Market checks before any ledger reservation. Public UI reads a cached, expiring
snapshot. Neither UI polling nor a readiness read starts a GPU. An explicit
operator warmup remains a potentially billable action. Infinite background
warmup has been removed.

## Local acceptance

- 26 comparison Node tests pass, including actual receipt arithmetic, late
  reconciliation and warming supply with no purchase claim.
- 30 Chutes Python tests pass, including readiness freshness and provider usage
  decimal arithmetic. Provider usage is explicitly not a private GPU-time invoice.
- 13 P2 Rust unit tests pass.
- The two-Market integration passes with real PG/Redis, signed encrypted
  purchases, final signed receipts, actual monetary projection and restart
  reconciliation. While warming, even a direct signed purchase returns 503 with
  no submit effect, no upstream call and no balance change. Hardware and upstream
  inference in this test remain controlled fixtures.
- Two baseline deployment-overlay tests, three original preview-overlay tests,
  and four edge tests pass. Ledgers, owner configuration, sealed environment
  settings and ingress services are preserved.
- Frontend build passes. Live Chutes metadata, source pin and CPU/GPU preflight
  have been checked read-only; this preflight invokes no model.

Commands and original evidence remain recorded outside git in the private
release directory. The release's hosted acceptance artifact must provide the
actual deployment/receipt verification; this document does not infer hosted
success from local tests.

## Deployment contract

The updated B host uses a new `/data/baseline-b-v2` namespace and three offline
buyer verifying keys. Original `/data/chutes-run` and its histories remain intact;
existing preview users, wallets and balances remain in their original volume.
Legacy sealed provider and bearer credentials may be read only through the
explicit reviewed source-directory migration option. Signing secrets stay on the
operator's machine. B retains the finite three-offer qualification contract;
restart neither refills offers nor resets balances.

The Mono preview retains its pinned controlled-runtime binary from
`6f9ee5e68d4d1776f04aa03d2f9b1f6717ec2676`; this update replaces frontend assets and
the read-only status edge. The B host binary is rebuilt from the current source.
Release provenance must identify these components separately.

The deployment overlay preserves existing domain ingress routing, certificate
bindings and diagnostics. Existing domain TLS faults are not evidence that the
retained Phala endpoint or the independently verified Market path is unavailable.

## Financial evidence limits

Actual Market charges are USD credit-ledger entries funded by the operator for
this experiment. Released credit reservations are not on-chain NEAR refunds.
Native agent-wallet payment remains a separate phase. Chutes private GPU runtime
cost and per-invocation usage records are distinct: a zero invocation charge does
not prove a free GPU. The export records the provider's authenticated usage
snapshot and leaves per-request GPU invoice amounts unknown.
