#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Keep immutable upstream test files byte-identical; lint the owned host.
bash scripts/accept-market-a.sh
source_report=$(mktemp)
trap 'rm -f -- "$source_report"' EXIT
python3 scripts/market-source-tests.py --evidence "$source_report"
python3 scripts/accept-market-b.py "${CARGO_TARGET_DIR:-crates/private-market-host/target}/debug/private-market-host" --source-evidence "$source_report" "$@"
