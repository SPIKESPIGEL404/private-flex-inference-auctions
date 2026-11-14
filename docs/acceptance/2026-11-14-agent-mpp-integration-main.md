# Main-targeted agent MPP consolidation

Date: 2026-11-14, America/New_York.
Result: **SCOPED_CONTROLLED_INTEGRATION_ACCEPTED** by an independent
`gpt-6-astra` reviewer. Real G1/P3 and production deployment are not accepted.

The tested code snapshot is `fbbbbcfa538490f6da3f37d0905fa2956a3a0414`.
The subsequent Rust change is formatter-only (the same `token_ids` expression
collapsed to one line); the review record verifies whitespace-normalized source
equality. Acceptance documents are added separately from that code snapshot.

## Included changes and main preservation

The branch contains the original heads of PR #4 (`69be964`), PR #5 (`863b6a5`)
and PR #6 (`ce10314`), plus P0/P1/P2 commits `0ffa72a`, `ce3c56d` and `2660db1`.
It incorporates current main `154581f` and resolves its integration conflicts.
The three old PR heads are ancestors of the consolidation head, so closing them
as superseded does not discard their code or commit history.

The main attestation, purchase-authentication and catalog modules, and the
deployment directory, are byte-unchanged. Startup retains both catalog identity
checks and the signed-purchase middleware. Procurement routes merge before
attestation/authentication mounting. Sealed deployment refuses experimental MPP
modes before database/workers start. P1/P2 remain controlled and loopback-only.

The P2 bootstrap regression found during consolidation is fixed: its lab fixture
records bootstrap elapsed time while keeping a synthetic 1ms observation window.
The deploy catalog remains deterministic and ignores P2 fixture selection.

## Validation

| Check | Result |
| --- | --- |
| Locked root/P1/P2 Rust builds | PASS |
| Root Rust test suite; binary tests after catalog fix | PASS |
| Root Clippy with warnings denied; Rust formatting | PASS |
| MPP P0/P1/P2 Node tests | 62 passed |
| Wallet gateway Node tests | 15 passed |
| Buyer verification Node tests | 4 passed |
| Legacy MPP configuration Node tests | 2 passed |
| Both frontend clean installs and production builds | PASS; existing WASM bundle warning retained |
| P1 controlled fault matrix | [22 passed](2026-11-14-agent-mpp-integration-p1.json) |
| P2 controlled task/recovery matrix | [15 passed](2026-11-14-agent-mpp-integration-p2.json) |
| Legacy official MPP SDK/PG/Redis regression | [21 checks passed](2026-11-14-agent-mpp-integration-nearintents.json) |
| ACI/TLS and signed purchases | [18 refusal cases, including 8 signed-purchase refusals; successful purchase and idempotent retry](2026-11-14-agent-mpp-integration-identity.json) |
| Independent deploy negative checks | [6 init configuration rejections and 4 missing-golden fail-closed checks](2026-11-14-agent-mpp-integration-deploy-gates.json) |
| Independent golden regeneration | [Ordinary and P2 environments both byte-identical](2026-11-14-agent-mpp-integration-golden.json) |
| Pinned materialized-source tamper repair, documentation links, diff check | PASS |

The independent [review record](2026-11-14-agent-mpp-integration-review.json)
distinguishes directly executed checks from runner artifacts reviewed by Astra,
and includes their hashes. Historical acceptance files are retained unchanged.
Dependency installation found three existing low-severity findings in the
unchanged `clients/market-buyer` lockfile; the other five installed packages
reported zero. No dependency upgrade is included in this consolidation.

## Evidence limits

All chain/payment/provider activity in these new matrices is controlled:
**zero real chain transactions, zero real provider calls and zero external
spending**. P1/P2's historical NEP-366 fixture assigns principal incorrectly for
real NEAR; its PASS establishes controlled wiring/accounting, not real economics.
The current contract selects agent-paid native principal and payment gas,
merchant-paid refund gas, and requires a new native-route G1 qualification.

P2 happy-path task snapshots are captured before waiting for four refund chain
actions. An embedded order may still be `refund_due`; the fixture-chain count
does not prove all final ledger confirmations in those earlier snapshots.

The independent sealed `serve` checks exit at the earlier missing
`/etc/market/catalog.json` check. Its later MPP-specific rejection branch is
source-reviewed, not dynamically reached on this machine. The golden bytes were
independently regenerated in fresh isolated services without changing `/etc`.

Wallet onboarding and controlled inference remain separate UI entry points.
Unfinished P3 native-wallet/gas-key/runtime prototypes are excluded. This record
does not establish a connected real-money UI, real funding, provider quality,
hardware deployment or production readiness.
