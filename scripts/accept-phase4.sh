#!/usr/bin/env bash
set -euo pipefail
phase4_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$phase4_root"

cargo fmt --all -- --check
cargo test --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
"${CHUTES_PYTHON:-python3}" -m unittest discover -s deploy/chutes -p test_chute.py -v

if [[ "${1:-}" == "--live" ]]; then
    shift
    cargo run --locked --example phase4_chutes -- "$@"
elif [[ $# -ne 0 ]]; then
    echo "usage: accept-phase4.sh [--live --key-file PATH --out NEW_DIR --mode accept|interrupt|resume ...]" >&2
    exit 2
fi
