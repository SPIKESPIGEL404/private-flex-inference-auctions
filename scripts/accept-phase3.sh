#!/usr/bin/env bash
set -euo pipefail
phase3_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$phase3_root"

cargo fmt --all -- --check
cargo test --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
python3 - <<'PY'
from pathlib import Path
import subprocess, tempfile
with tempfile.TemporaryDirectory(prefix="flex-phase3-") as directory:
    subprocess.run(["cargo", "run", "--locked", "--example", "phase3_spool", "--", "--db", str(Path(directory)/"journal.sqlite")], check=True)
PY
