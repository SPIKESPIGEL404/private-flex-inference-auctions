#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --locked --manifest-path crates/private-market-host/Cargo.toml --bin private-market-host
python3 scripts/accept-market-mpp.py "${CARGO_TARGET_DIR:-crates/private-market-host/target}/debug/private-market-host" "$@"
