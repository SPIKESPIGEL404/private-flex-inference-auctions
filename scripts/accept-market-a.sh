#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
manifest=crates/private-market-host/Cargo.toml
rustfmt --edition 2024 --check crates/private-market-host/src/main.rs
cargo clippy --locked --manifest-path "$manifest" --bin private-market-host -- -D warnings
cargo build --locked --manifest-path "$manifest"
python3 scripts/accept-market-a.py "${CARGO_TARGET_DIR:-crates/private-market-host/target}/debug/private-market-host" "$@"
