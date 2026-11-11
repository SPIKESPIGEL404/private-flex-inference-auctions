# Buyer-to-Market verification: local acceptance

- Date: 2026-11-11, America/New_York.
- Scope: first-hop ACI protocol/identity, reviewed buyer policy and actual TLS
  channel integration. The user explicitly chose verification without deployment.
- Status: local controlled integration PASS. Hardware acceptance and full batch D
  remain incomplete. No independent model reviewer was requested for this step.

The [run guide](../market-buyer-verification.md) describes dependencies,
configuration, commands and boundaries. The optional endpoint is assembled into
the existing host; there is no added provider proxy, alternate money authority or
gateway failover loop. With attestation disabled, existing A–C entry points remain.

## Observations

Eight rejection scenarios passed: altered keyset, expired keyset, wrong challenge,
unaccepted compose, unaccepted boot profile, a different real TLS key, production
client rejection of fake hardware, and host startup rejection of a different
quote report-data slot. Before the success case there were zero sensitive POSTs
and zero Market submit effects. Additional client policy tests reject debug TDX,
wrong boot fields, unsupported quote layouts, missing allowlists and HTTP or
unexpected endpoints.

One successful **controlled** purchase passed actual TLS SPKI binding and original
ACI nonce/keyset/compose checks through a test-only identity seam which explicitly
skips the hardware root. The Market, PG, Redis and native controlled seller ran
their actual implementations. One native submit, one committed receipt, provider
35 + platform 2 test microUSD, and final balance 24,963 were observed. No external
inference calls or paid deployment occurred.

The production CLI has no simulation flag or injectable hardware verifier. It
rejected the fake evidence without reading the nonexistent credential/request
files or transmitting a procurement. Its actual bootstrap requires a real Intel
root quote and `UpToDate` status, non-debug TDX v4, reviewed boot measurements and
compose; the pinned client then checks fresh nonce, keyset expiry and actual TLS.
These extra policy checks run on each identity acquisition/renewal.

## Validation and limits

Formatting, Clippy with warnings denied, locked build, both Node policy tests and
the controlled end-to-end script passed. The final A baseline, all 243 source
tests, all 17 B host cases (`partial: false`), and C offline registration checks
also passed. These components were run sequentially, rather than claiming a new
paid C run or another hardware acceptance. See the
[machine evidence](market-buyer-verification-evidence.json). The full source/fault suites
are distinct from the first-hop controlled proof and do not establish hardware
authenticity. No new gpt-6-astra review is implied by earlier A–C reports.

The initial user-supplied deployment key was rejected by the official Phala
Cloud read API with 401. No CVM create request was sent, and the user then chose
not to deploy. The credential remains outside Git and was not used for inference.

Actual confidential deployment, production OS release selection, TLS private-key
custody, protected storage/logs, state freshness and rollback policy need a real
environment before D can pass. The endpoint and client report availability and
verification separately. NEAR/upstream verification, signed ACI exchange receipts
and field-level E2EE remain future work; financial receipts retain their A–C role.
