# Mainnet canary proposal — funding not authorized

The Cloud key passed a real SDK inference test. Mainnet funding and transactions
remain unapproved. This document prepares the next review; it does not activate
the live gate or modify the CVM.

Dedicated, unfunded merchant:

`6a20d31551e1e2649941da974315437b0cccf8bfc03333d961b97e7ae19746db`

A FINAL read confirmed that this implicit account does not exist yet. Its private
key stays outside the repository. A separate owner was generated using
`near-cli-rs 0.31.1 account create-account fund-later use-auto-generation`:

`042411fa708fe2dadb55c9a43a5604ec18853b9d4203fb2cd28d6e194252e040`

The owner key is saved in a private 0600 file outside the repository; offline
key/address binding verification passed. A FINAL read also returned
`UNKNOWN_ACCOUNT`, confirming it remains an unfunded implicit address. Actual
agent addresses and policy deposits will be reviewed after owner setup. CLI
acceptance does not establish wallet-extension/browser signing UX.

Proposed native allocation:

| Item | NEAR |
| --- | ---: |
| Dedicated merchant seed | 0.01 |
| Two agent wallets, 0.01 each | 0.02 |
| Initial and exit policy deposits, at most four × 0.02 | 0.08 |
| Owner transaction gas allowance | 0.01 |
| Proposed total operational budget | **0.12** |

Funding is not all spent: it includes agent/merchant balances and policy storage.
Agent payment/exit gas comes from each agent's own 0.01 NEAR. Per-call principal
is bounded at 0.002 NEAR, agent payment gas reserve at 0.002 NEAR and merchant
refund gas reserve at 0.0002 NEAR. Historical OutLayer Testnet payment gas was
about 0.000835 NEAR; Mainnet actual fees still require measurement. An overrun is
recorded and stops new purchases. These gas allowances are local guards, not a
chain-enforced fee cap. A policy quote above 0.02 NEAR stops setup rather than
automatically raising the frontend's limit. Prior policy receipt evidence
contains a 0.01146 NEAR deposit, so the old 0.01 guard rejected a valid observed
quote. The candidate now has an explicit 0.02 limit and shows it before signing.

The combined project Cloud allowance is proposed at $0.01, including the already
verified $0.000043 key test. The runtime receives the remaining 9,957 microUSD and
at most eight paid provider requests, including its startup probe; the combined
maximum is nine POSTs including the completed standalone test. Unknown effects
retain their reservation. Allowances are local admission limits, not an upstream
invoice or provider-enforced spending cap.

The proposal has two agent slots, $0.05 per-agent financial budget, $0.10 owner
budget and $0.005 per-call cap. These budget scopes include priced gas and differ
from the project Cloud allowance. The text/bash service class allows at most
32,000 qualified input tokens and 512 output tokens. Actual usage settles at the
frozen contract; outside-contract verified usage yields a full principal refund.

For the canary, use the 1Click public token list's `nep141:wrap.near` reference
price. The API documents `price` as USD and provides `priceUpdatedAt`:
[official token reference](https://docs.agentsonintents.com/api-reference/oneclick/get-supported-tokens).
Use that provider timestamp as `observedAtMs`, reject future/missing timestamps,
expire the observation after 90 seconds, and convert the decimal price to integer
nanoUSD without binary floating-point arithmetic. Require NEAR chain, 24 decimals
and `wrap.near` identity. Enable the packaged `oneclick-reference-v1` reader to
refresh every 15 seconds without SSH; the current production CVM rejected operator
SSH during preflight. Each allocation freezes its own snapshot; stale data stops new purchases. This is a
reference conversion, not an executable swap quote. No Intents swap/payment is
required or authorized. The legacy `priceoracle.near` returned null prices during
preflight and is not used for a sale.

The proposed dedicated entry uses port 3001 on the existing CVM and the immutable
candidate image. The additive manifest was rendered against a freshly retrieved
manifest: all four existing services, ten volumes and five sealed environment
names are preserved. It adds only `mainnet-auction`, its private network/data
volume, and one sealed Mainnet credential envelope. No pre-launch script is used.
The prior candidate source was `69a2a40eeefd642a851111f9e79abb4d0ab8059a`;
the final candidate source is `379ced72b4af8ad18c7db4ed5beebd9811f01e19`,
published as `ghcr.io/spikespigel404/private-flex-inference-auctions@sha256:d3f3f6e45858a7f20be10dd090fc95464ac865fc57c3b398b1ea0e2c5ebf26c2`.
[Publication CI](https://github.com/SPIKESPIGEL404/private-flex-inference-auctions/actions/runs/43672778947)
verified unchanged Rust inputs/binary bytes and offline bootstrap. Only current
Node/UI components were repackaged over the accepted immutable Mainnet base.
Existing sealed values were retained verbatim in a private deployment envelope;
the owner private key is excluded from the service envelope.

The exact generated deadline, plan hash and rendered deployment diff are stored
in the private deployment directory. Recheck expiry and the live manifest before
requesting final activation approval. No financial state has been initialized
from this proposal; an expired draft can be regenerated before approval.

Next: finish exact policy/funding transaction review for this owner, then
request approval of the concrete Mainnet amounts. Fund only after approval.
Collect two independent browser task/tool results, FINAL principal/gas/refund
proofs and restart replay with no extra effects before merge/public rollout.
