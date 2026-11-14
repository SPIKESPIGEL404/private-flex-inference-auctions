#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --ignore-scripts --no-audit --no-fund --prefix services/mpp-nearintents
npm test --prefix services/mpp-nearintents
cargo build --locked --manifest-path crates/private-market-host/Cargo.toml --bin private-market-host
python3 scripts/accept-market-nearintents.py "${CARGO_TARGET_DIR:-crates/private-market-host/target}/debug/private-market-host" "$@"
