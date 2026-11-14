#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export P1_NODE="${P1_NODE:-$(command -v node)}"
export PATH="$(dirname "$P1_NODE"):$PATH"
"$P1_NODE" -e 'if(Number(process.versions.node.split(".")[0])<24)throw Error("Node >=24 required")'
for tool in cargo patch git initdb pg_ctl psql redis-server redis-cli; do command -v "$tool" >/dev/null; done
npm ci --prefix services/mpp-near-direct --ignore-scripts
npm ci --prefix clients/agent-playground --ignore-scripts
python3 scripts/materialize-market-p3.py
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target/outlayer-p3}"
cargo build --locked --manifest-path crates/private-market-p3/Cargo.toml
cargo test --locked --manifest-path crates/private-market-p3/Cargo.toml --test scope-members
npm run build --prefix clients/agent-playground
"$P1_NODE" --test --test-reporter=tap services/mpp-near-direct/test/*.test.mjs services/mpp-near-direct/p1/test/*.test.mjs services/mpp-near-direct/p2/test/*.test.mjs services/mpp-near-direct/p3/test/*.test.mjs \
 | tee docs/acceptance/2026-11-14-outlayer-p3-tests.tap
python3 scripts/accept-agent-mpp-p3.py "$CARGO_TARGET_DIR/debug/private-market-host-p3"

python3 scripts/accept-agent-mpp-p3-native.py "$CARGO_TARGET_DIR/debug/private-market-host-p3"
python3 scripts/accept-agent-mpp-p3-setup.py "$CARGO_TARGET_DIR/debug/private-market-host-p3"
