# Cloud key validation before Mainnet funding

One real `Qwen/Qwen3.8-27B` SDK call succeeded with HTTP 200 and a verified
`provider_tee` response signature. Native usage was 61 input / 30 output tokens,
including 27 reasoning tokens. Frozen-catalog usage cost was 43 microUSD
($0.000043); the pre-call reservation was 501 microUSD, within a 2,000 microUSD
test allowance. This measures usage at the quoted tariff, not a provider invoice.

The private encrypted original-effect journal was written before the one paid
POST. A second process with Docker networking disabled returned the same response
digest and usage, with zero additional POSTs. The tested image was the published
Mainnet candidate from source `69a2a40eeefd642a851111f9e79abb4d0ab8059a`.

The credential is stored only in a local 0600 file outside the repository. It is
absent from browser/model inputs, image layers and this evidence. No key is needed
to inspect the adjacent sanitized JSON.

This was a standalone Cloud key check. It did not exercise AuctionMarket
procurement, native MPP payment, refund, a browser wallet, or a Mainnet task. Zero
wallets were registered and zero NEAR transfers were broadcast by this check.
The integrated runtime still requires its own project probe under its immutable
plan and owning PostgreSQL budget.
