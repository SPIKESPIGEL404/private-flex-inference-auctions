#!/usr/bin/env bash
set -euo pipefail
phase1_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$phase1_root"
phase1_tmp="$(mktemp -d "${TMPDIR:-/tmp}/flex-phase1.XXXXXXXX")"
trap 'rm -rf "$phase1_tmp"' EXIT

cargo fmt --all -- --check
cargo test --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo run --locked --example phase1_fixture -- --db "$phase1_tmp/journal.sqlite"
