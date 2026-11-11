#!/usr/bin/env python3
"""Run migrated source suites sequentially; discard only their build artifacts."""
import json
import os
from pathlib import Path
import re
import subprocess
import argparse
import hashlib

root = Path(__file__).resolve().parents[1]
package = root / "crates/private-market-host"
env = dict(os.environ, CARGO_INCREMENTAL="0")
results = {}
parser = argparse.ArgumentParser()
parser.add_argument("--evidence", type=Path)
args = parser.parse_args()
expected = json.loads((package / "upstream/kernel-test-sha256.json").read_text())
for name, digest in expected.items():
    assert hashlib.sha256((package / "tests" / name).read_bytes()).hexdigest() == digest, name
for source in sorted((package / "tests").glob("*.rs")):
    if source.read_text().startswith('#![cfg(feature = "sqlite-tools")]'):
        continue  # Standalone SQLite tools, not the migrated PG implementation.
    result = subprocess.run(["cargo", "test", "--locked", "--manifest-path", str(package / "Cargo.toml"),
                             "--test", source.stem, "-j", "1", "--message-format=json"],
                            env=env, capture_output=True, text=True)
    artifacts = []
    dependency_files = []
    for line in result.stdout.splitlines():
        if line.startswith('{"reason":'):
            item = json.loads(line)
            if item.get("reason") == "compiler-artifact":
                target = item.get("target", {})
                executable = item.get("executable")
                if "test" in target.get("kind", []) and Path(target["src_path"]).resolve() == source.resolve() and executable:
                    artifacts.append(Path(executable))
                elif executable is None:
                    dependency_files.extend(Path(p) for p in item["filenames"] if Path(p).exists())
    # These are generated test executables, not source, state, or dependencies.
    for path in artifacts:
        path.unlink(missing_ok=True)
    assert all(path.exists() for path in dependency_files), "test cleanup removed a dependency artifact"
    if result.returncode:
        print(result.stderr)
        print(result.stdout)
        raise SystemExit(result.returncode)
    counts = re.findall(r"test result: ok\. (\d+) passed", result.stdout)
    assert len(counts) == 1 and int(counts[0]) > 0, source
    results[source.stem] = int(counts[0])
    print(f"{source.stem}: {counts[0]} passed", flush=True)
metadata = json.loads(subprocess.check_output(["cargo", "metadata", "--locked", "--manifest-path", str(package / "Cargo.toml"), "--format-version", "1"], text=True))
kernel = next(p for p in metadata["packages"] if p["name"] == "bitrouter-market")
assert "244177cafa26e8c8b001e61297cf4e7f89ac8de9" in kernel["source"]
result = subprocess.run(["cargo", "test", "--manifest-path", kernel["manifest_path"], "--lib", "--locked", "-j", "1",
                         "--target-dir", str(package / "target"), "--message-format=json"], env=env, capture_output=True, text=True)
for line in result.stdout.splitlines():
    if line.startswith('{"reason":'):
        item = json.loads(line)
        if (item.get("reason") == "compiler-artifact" and item.get("profile", {}).get("test")
                and item.get("executable") and Path(item["target"]["src_path"]).resolve() == Path(kernel["manifest_path"]).parent / "lib.rs"):
            Path(item["executable"]).unlink(missing_ok=True)
assert result.returncode == 0, result.stderr + result.stdout
count = re.findall(r"test result: ok\. (\d+) passed", result.stdout)
assert count == ["17"], count
results["kernel_unit"] = 17
assert results["inference_source"] == 24
assert sum(n for name, n in results.items() if name != "inference_source") == 219
evidence = {"source_suites": results, "total": sum(results.values())}
if args.evidence:
    args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
print(json.dumps(evidence, indent=2))
