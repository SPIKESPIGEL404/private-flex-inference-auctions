# Public phase-one fixtures

These files contain synthetic input and a public test identity. They are not
BitRouter production plans, GPU calibration data, credentials, or attestation.

- `config.json`: two in-flight requests, one ordered stream, fixed integer limits.
- `plan-001.json`: ordered requests `exec-1-1`, `exec-1-2`.
- `plan-002.json`: successor containing `exec-2-1`, bound to plan one's digest.

The fixture-only Ed25519 seed is 32 bytes of `0x07`; it is deliberately public.
Only the public verification key enters the scheduler configuration. Never trust
this identity in a real deployment. No secret signing key is accepted by the core.

Regenerate the exact plans with `cargo run --locked --example generate_fixtures`.
The acceptance tests check that the committed files match their deterministic
definitions and that their signatures verify.
