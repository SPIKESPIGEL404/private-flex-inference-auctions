#!/usr/bin/env bash
set -euo pipefail
phase2_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$phase2_root"
phase2_tmp="$(mktemp -d "${TMPDIR:-/tmp}/flex-phase2.XXXXXXXX")"
trap 'rm -rf "$phase2_tmp"' EXIT

cargo fmt --all -- --check
cargo test --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo run --locked --example phase2_mock -- --db "$phase2_tmp/journal.sqlite"
