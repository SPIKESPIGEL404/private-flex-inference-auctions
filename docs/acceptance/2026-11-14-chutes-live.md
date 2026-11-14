# Chutes single-model live deployment — 2026-11-14

> Historical live run of the pre-integration Linux binary
> `73742831654a037c48cc088483755d8f32f16c0a89300db6246b6eedd2d50107`.
> The Chutes PR is rebased onto main `154581f`, retaining its signed purchases
> and catalog-digest checks. This report is not live acceptance of that newer
> PR build. Its controlled verification is recorded separately. The historical
> unsigned deployment and buyer policy are not deployment templates for main.


**PASS — scoped live single-model integration.** Real Phala hardware/TLS,
Chutes hardware/E2EE, public procurement, test-credit settlement and full CVM
restart replay passed. The retained early Unknown test remains unresolved.

## Public contract

The only public model is `qwen3.8-27b`, mapped to private
`Qwen/Qwen3.8-27B-FP8`, revision
`017b9c7af6b5689d5dd426a76e0bc077eb5ca20a`. The Chute source version is
`1dd34c0e-e472-5a33-8c7a-cadbbd349267`, SHA-256
`c0941990f3dd63bb0152708463ca15150ffdbb29820de21c7e069878d383679f`.
It is private, TEE, one GPU per instance, maximum one active instance, and
3600-second idle retention. No Chutes hourly selector or task-total price cap
is applied, following the user's explicit superseding authorization.

The API uses the existing Phala app and TLS-passthrough hostname, at
`/market/v1`. Native Chat uses project test-credit procurement, not anonymous
OpenAI proxying. Messages, Responses, native model names and other models are
not public products.

## Verification achieved

A real strict preflight verified Intel-root DCAP, UpToDate TCB, no advisories,
debug off, pinned MRTD and all four RTMRs, fresh nonce/ML-KEM key binding, and
NVIDIA NRAS ES384 signatures, detached token digests and device security claims.
A real encrypted native call completed with 59 input tokens and 28 output
tokens, with authenticated native usage and encrypted `[DONE]`.

The live provider sends cumulative usage on choice frames and encrypts its
native terminator. The adapter validates the cumulative counts, suppresses only
intermediate choice-frame usage, forwards the actual final empty-choice usage,
and emits the public terminator after validation. Eight transport/policy tests
pass on macOS and the deployed Linux image. The full owned PG/Redis Market
scenario passes with this exact normalizer, including settlement, replay and
host restart. Controlled tests alone are not live acceptance.

The Chutes reference registry is a pinned vendor-published policy, not an
independently reproduced OS build. Model source/version/revision/image comes
from the authenticated control plane. Loaded model weights and CPU/GPU session
topology are not independently hardware-proven. Recorded preflight reports are
not per-request ACI execution receipts. The buyer SDK must continue to report
`upstream_verified: false` for that stronger ACI receipt contract.

## Accepted live path

The public model list contains only `qwen3.8-27b`; native, NEAR and unknown model
names were rejected. The buyer verified production boot measurements, the
reviewed app-compose/image, a fresh challenge and the actual TLS SPKI before
opening its credential file or submitting its synthetic prompt.

Request `6565ab34-72d2-402f-bc40-e8a7ffcb559d` returned an `OK` final answer,
59 prompt tokens and 30 completion tokens. Project-seller test-credit charge:
389 micro-USD, platform fee zero, settlement committed and held balance zero.
This is **not a Chutes GPU wall-clock invoice**. Buyer isolation returned 404 to
a different buyer. Original-key replay was byte-identical.

The production recorded upstream preflight was independently reverified while
fresh: Intel-root DCAP and pinned measurements, nonce/ML-KEM binding, and NVIDIA
NRAS signatures. Instance `bedbc503-9a61-4720-a350-b12b78875ea2`, evidence session
`6fa7bc5e729d57e39554ce22894647c9717f0565d9d568d4742ae98fa8908fae`.
The public evidence index is `/market/v1/provider-evidence/`; individual records
use the hash without `.json`. These remain recorded preflights, not execution
receipts binding a model result to a buyer request.

A full CVM restart changed the RAM-only TLS key. The buyer acquired and verified
the new attested identity, then replayed the same request with identical SSE
SHA-256 `646ba5910066e4e86c73c5df2381ca95ac979715ac46509dee2991547b2750e8`.
Settlement and fees were unchanged. Exactly two native preflight records remained
(the calibration and the original buyer call); restart/replay did not requalify
or submit another native inference.

## Retained interrupted test

The first Market purchase `b803efe3-7e05-45d0-a19b-f43ffa92fb82` encountered the
continuous-usage incompatibility. It remains **Unknown**, settlement unavailable,
with **10,000 micro-USD of isolated test credit held**. It was not retried as a
new request, refunded, settled from a replacement inference, or cleared by
rewriting the ledger. Its volume `dstack_market-chutes-qwen38-20261114` is retained
read-only. The original NEAR ledger is likewise retained read-only.

The old Chutes instance `ddeea6f0-bbf8-4372-b550-56efd43d219d` was disabled, and
the authenticated control plane confirmed no remaining instances before a new
activation. This is control-plane termination evidence, not original usage or
financial-settlement evidence. The corrected acceptance has a separately named
market, independent test identities/credits and the volume
`dstack_market-chutes-qwen38-verified-20261114`; no old cash state is adopted.

## Measured release

The following values were prepared before deployment. The platform returned
matching compose, pre-launch and complete app-compose hashes:

- Docker image ID: `sha256:8ef09a1a577ca51e306f7819165c07a9d44a0334074c7ed0df07b692b81cff15`
- Linux binary SHA-256: `73742831654a037c48cc088483755d8f32f16c0a89300db6246b6eedd2d50107`
- Compose SHA-256: `0826a1d19659996aa96c8ea7cc4327b60686a4de040150cd2daf277c2a59ef17`
- Pre-launch SHA-256: `d45c5550c9c3dcc7732080316081117c4a79d2c402b100229c5d529daef94fe4`
- Complete app-compose SHA-256: `116b2fb45bf9e39c80bb4fd671d3d06a8c58c99a24371b075f12f21a9a19d3a3`
- Measured seed SHA-256: `781d7af63e43f263fea01d9e565caf50712efe55a3600217fbff5915dcdade08`

The OS remains production `dstack-0.6.4`. Serial boot evidence verifies encrypted
and plaintext archive digests before image loading, plus the seed and nginx
hashes. Credentials are delivered as sealed environment values, not in the image
or public seed. Only credential hashes are measured. The deployment archive is
encrypted and stored in a private draft release; no GitHub account token is sent
to the CVM. Public logs, public sysinfo and SSH remain disabled.

The retained Market bootstrap has three finite one-use offers, qualification
expiry and project test credits. Uncapped Chutes costs do not imply unlimited
buyer credit, perpetual supply or production-funded settlement.

See [machine evidence](2026-11-14-chutes-live-evidence.json) and the
[run guide](../chutes-gateway.md). Private captures remain under
`.market-runs/chutes-gateway/`; credentials are outside the repository.
