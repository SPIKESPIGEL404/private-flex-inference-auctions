# B bootstrap recovery

The first B rollout failed before Market registration: the runtime used its market
ID (`baseline_b_v2_…`) as a PostgreSQL database name. The host only accepts names
beginning with `private_market_`. Initialization therefore stopped before creating
its state directory or sending the calibration request. Later restarts correctly
refused to repeat the incomplete initialization.

New runtime initialization derives a stable, bounded database name from the market
ID. Existing runtimes validate their saved name; they do not silently change
which database contains their ledger.

The deployment recovery uses an explicitly allowed `baseline-b-v3` directory on
the same persistent volume. The failed v2 directory and every previous ledger
remain intact. Only the legacy provider and buyer credentials are copied into the
new directory. Before activating recovery, a read-only guard checks the exact
failed market/database and refuses any state directory (including a dangling
symlink), calibration/measurement file, or host log. The prior container must be
stopped before this guard runs.

Validation: three database contract tests, three recovery guard tests, and three
overlay tests pass. The deployed Rust binary rejects the old name; a new derived
name passes its database-name check in an isolated container with networking
unavailable. Live deployment health and the final compose hash are separate
rollout evidence.

For the operational rollout, the existing runtime image can be retained with
SHA-256-pinned, read-only mounts of the reviewed `bootstrap_chutes.py` and
`runtime_chutes.py`. Those source overrides must be recorded separately from the
image digest. This recovery does not enable native-funded B or browser MPP
inference; the public playground remains controlled P2.
