#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export P1_NODE="${P1_NODE:-$(command -v node)}"
export PATH="$(dirname "$P1_NODE"):$PATH"
"$P1_NODE" -e 'if(Number(process.versions.node.split(".")[0])<24)throw Error("Node >=24 required; set P1_NODE")'
for tool in cargo patch git initdb pg_ctl psql redis-server redis-cli; do command -v "$tool" >/dev/null; done
npm ci --prefix services/mpp-near-direct --ignore-scripts
python3 scripts/materialize-market-p1.py
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target/agent-mpp-p1}"
cargo build --locked --manifest-path crates/private-market-p1/Cargo.toml
"$P1_NODE" --test --test-reporter=tap services/mpp-near-direct/test/*.test.mjs services/mpp-near-direct/p1/test/*.test.mjs \
  | tee docs/acceptance/2026-11-14-agent-mpp-p1-tests.tap
python3 scripts/accept-agent-mpp-p1.py "$CARGO_TARGET_DIR/debug/private-market-host-p1" \
  --evidence docs/acceptance/2026-11-14-agent-mpp-p1-matrix.json
python3 scripts/agent-mpp-p1-evidence.py "$CARGO_TARGET_DIR/debug/private-market-host-p1"
