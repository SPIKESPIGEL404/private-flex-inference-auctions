#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_INCREMENTAL=0
manifest=crates/private-market-host/Cargo.toml
rustfmt --edition 2024 --check crates/private-market-host/src/main.rs
cargo clippy --locked -j 2 --manifest-path "$manifest" --bin private-market-host -- -D warnings
cargo build --locked -j 2 --manifest-path "$manifest"
npm ci --ignore-scripts --no-audit --no-fund --prefix clients/market-buyer
npm test --prefix clients/market-buyer
python3 scripts/accept-market-identity.py "${CARGO_TARGET_DIR:-crates/private-market-host/target}/debug/private-market-host"
