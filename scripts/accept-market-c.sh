#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
manifest=crates/private-market-host/Cargo.toml
rustfmt --edition 2024 --check crates/private-market-host/src/main.rs
cargo clippy --locked --manifest-path "$manifest" --bin private-market-host -- -D warnings
cargo build --locked --manifest-path "$manifest"
python3 scripts/accept-market-c-offline.py "${CARGO_TARGET_DIR:-crates/private-market-host/target}/debug/private-market-host"
# This wrapper never contacts an inference endpoint. A captured real run is
# audited separately; creating a new one needs its own explicit plan approval.
