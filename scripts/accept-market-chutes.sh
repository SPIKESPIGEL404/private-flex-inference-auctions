#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
manifest=crates/private-market-host/Cargo.toml
python="${CHUTES_GATEWAY_PYTHON:-.market-runs/chutes-gateway/venv/bin/python}"
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
rustfmt --edition 2024 --check crates/private-market-host/src/main.rs
cargo clippy --locked --manifest-path "$manifest" --bin private-market-host -- -D warnings
cargo test --locked --manifest-path "$manifest" --bin private-market-host single_model
cargo build --locked --manifest-path "$manifest" --bin private-market-host
"$python" -m unittest discover -s deploy/chutes -p 'test_*gateway.py' -v
"$python" scripts/accept-market-chutes.py "${CARGO_TARGET_DIR:-crates/private-market-host/target}/debug/private-market-host"
