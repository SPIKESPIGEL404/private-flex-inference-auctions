#!/usr/bin/env python3
"""Package synthetic acceptance evidence with consistent SQLite backups.

Only explicit acceptance paths are included. Check the private credential is
absent from every member before writing the reproducible tar.gz artifact.
"""
import argparse
from contextlib import closing
import gzip
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--recovery-dir", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    key = args.key_file.expanduser().read_bytes().strip()
    live = json.loads((args.run_dir / "acceptance.json").read_text())
    items = {}

    def include(path, name):
        if path.suffix == ".sqlite":
            with tempfile.TemporaryDirectory() as temporary:
                backup = Path(temporary) / "journal.sqlite"
                with closing(sqlite3.connect("file:" + str(path.resolve()) + "?mode=ro", uri=True)) as source:
                    with closing(sqlite3.connect(backup)) as destination:
                        source.backup(destination)
                data = backup.read_bytes()
        else:
            data = path.read_bytes()
        assert key not in data and b"cpk_" not in data, "Credential-like content in evidence"
        items[name] = data

    for name in ("session.json", "prompt.json", "prompt.provenance.json", "tokenizer-control.json", "deployment.json", "acceptance.json"):
        include(args.run_dir / name, "accept/" + name)
    for result in live["calibration"] + live["cache_namespace_checks"]:
        directory = args.run_dir / result["run"]
        for path in sorted(directory.rglob("*")):
            if path.is_file() and (path.name in {"config.json", "plan.json", "journal.sqlite", "before.prom", "after.prom", "run.json", "summary.json"} or path.name.startswith("native-peak-") or path.parent.name == "sink"):
                include(path, "accept/" + str(path.relative_to(args.run_dir)))
    for name in ("config.json", "plan.json", "journal.sqlite", "session.json", "prompt.json", "interrupted.json", "recovered-result.json", "recovery.json", "isolation.json", "isolation.prepared.json", "isolation.removed.json"):
        include(args.recovery_dir / name, "recovery/" + name)
    manifest = {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} for name, data in sorted(items.items())}
    items["MANIFEST.json"] = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode()
    with args.output.open("xb") as target:
        with gzip.GzipFile(filename="", fileobj=target, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                for name, data in sorted(items.items()):
                    metadata = tarfile.TarInfo(name)
                    metadata.size, metadata.mode, metadata.mtime = len(data), 0o600, 0
                    archive.addfile(metadata, io.BytesIO(data))
    print(json.dumps({"archive": str(args.output), "members": len(items), "bytes": args.output.stat().st_size,
                      "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(), "credential_scan": "passed"}))


if __name__ == "__main__":
    main()
