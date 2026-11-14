# Chutes port onto current main — 2026-11-14

Controlled acceptance passed on base `154581f` (merged security PR #3).
This is separate from the [older live binary's evidence](2026-11-14-chutes-live.md).
The PR head has not been deployed or newly accepted against paid inference.

The port retains mandatory signed purchases with ACI, accepted catalog policy
digests, golden controlled-deployment checks and offline buyer signing keys.
`init-live-deploy` combines native registration with externally supplied buyer
verifying keys and sealed bearer tokens, without a deployment signing directory.
The optional Phala profile puts reviewed TLS/proxy configuration inside its
hash-pinned public seed and materializes it in RAM.

Validation completed:

- Strict Clippy and Rust source formatting; four binary unit tests including
  the two original catalog/golden checks and two single-model checks.
- Nine Python transport/seed tests: real controlled ML-KEM/AEAD and NRAS
  signatures, negative proof policy, continuous/final native usage, no invoke
  after failed proof, and exclusion of bearer/signing secrets from public seeds.
- Full owned PG/Redis single-model scenario: offline verifying keys, no signing
  secrets in Market state, unsigned/tampered/captured-nonce denial before provider
  contact, other model denial, native mapping, settlement, exact original replay
  and signed replay after host restart with one provider fixture invocation.
- Existing controlled identity/TLS acceptance: 18 refusal cases, eight signed
  purchase refusals and idempotent signed retry; zero external inference calls.
- Five buyer unit tests, five TLS lifecycle tests and ten historical scheduler
  contract tests.
- Dockerfile static check and Compose example rendering. These are not a fresh
  full Linux image build or a new Phala deployment.

The historical Unknown test hold is preserved in its evidence. Neither this PR
nor controlled acceptance claims to adjudicate it. Loaded weights, CPU/GPU
session topology, per-request ACI execution receipts, durable upstream Chat
reattachment, production funding and perpetual supply remain outside this scope.
