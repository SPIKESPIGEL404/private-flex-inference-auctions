"""Materialize a measured release once, then resume the same persistent ledger."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import time
import urllib.request


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def install(path, raw):
    if path.exists():
        assert path.read_bytes() == raw, "persistent release input differs"
        return
    temporary = path.with_name(path.name + ".new")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(raw); out.flush(); os.fsync(out.fileno())
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", required=True)
    parser.add_argument("--seed-sha256", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    raw = Path(args.seed).read_bytes()
    assert digest(raw) == args.seed_sha256, "unapproved deployment seed"
    seed = json.loads(raw)
    root = Path("/data/chutes-run")
    root.mkdir(mode=0o700, exist_ok=True)
    for name in ("gateway.json", "plan.json", "buyers.public.json"):
        install(root / name, seed["files"][name].encode())
    plan = json.loads((root / "plan.json").read_bytes())
    config = json.loads((root / "gateway.json").read_bytes())
    assert config["key_file"] == str(root / "chutes.key")
    assert config["local_secret_file"] == str(root / "local-secret")
    key = os.environ.pop("CHUTES_API_KEY", "").strip()
    os.environ.pop("MARKET_ARTIFACT_KEY", None)
    buyer_keys = base64.b64decode(os.environ.pop("MARKET_BUYER_KEYS_B64", ""), validate=True)
    assert digest(buyer_keys) == seed["buyer_tokens_sha256"], "buyer credential seed differs from release"
    install(root / "buyer-tokens.json", buyer_keys)
    if key:
        assert "\n" not in key and "\r" not in key
        install(root / "chutes.key", key.encode())
    assert (root / "chutes.key").is_file(), "sealed provider credential is missing"
    if not (root / "local-secret").exists():
        install(root / "local-secret", secrets.token_hex(32).encode())
    for name, expected in plan["tokenizer_files_sha256"].items():
        path = root / name
        assert plan["tokenizer_files"][name] == str(path)
        if not path.exists():
            # These are public tokenizer assets, with exact preapproved hashes.
            url = seed["tokenizer_urls"][name]
            assert url.startswith("https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/")
            with urllib.request.urlopen(url, timeout=180) as response:
                data = response.read(32 * 1024 * 1024 + 1)
            assert digest(data) == expected, "tokenizer asset differs from release"
            install(path, data)
        assert digest(path.read_bytes()) == expected, "persistent tokenizer changed"
    # Public TLS/proxy configuration is bound by the measured seed, not
    # trusted merely because a file lives on persistent encrypted storage.
    for name in ("attestation.json", "nginx.conf"):
        install(Path("/run/market-tls") / name, seed["files"][name].encode())
    command = [sys.executable, "/opt/market/runtime_chutes.py", "--run-directory", str(root),
        "--approved-plan-sha256", digest((root / "plan.json").read_bytes()),
        "--approved-config-sha256", digest((root / "gateway.json").read_bytes()),
        "--buyer-key-file", str(root / "buyer-tokens.json"),
        "--buyer-public-keys", str(root / "buyers.public.json"),
        "--tls-config", "/run/market-tls/attestation.json", "--nginx-config", "/run/market-tls/nginx.conf"]
    if not (root / "runtime.json").exists():
        assert not (root / "state").exists(), "partial bootstrap requires investigation"
        # Wait for capacity BEFORE creating any financial state or inference
        # intent. Repeated warmup is a metadata operation, never a completion.
        key = (root / "chutes.key").read_text().strip()
        for _ in range(60):
            try:
                request = urllib.request.Request("https://api.chutes.ai/chutes/warmup/5f5b67f2-139e-5857-bdfb-94a30e03a526?quick=true",
                    headers={"Authorization": "Bearer " + key})
                with urllib.request.urlopen(request, timeout=30) as response:
                    status = json.load(response)
                if any(instance.get("active") for instance in status.get("instances", [])):
                    break
            except Exception:
                pass
            time.sleep(30)
        else:
            raise RuntimeError("private Chute capacity is not ready; no ledger was created")
        command.append("--initialize")
    elif not (root / "state/catalog.json").exists() and seed.get("resume_calibration_attempt"):
        command.extend(["--resume-calibration-attempt", seed["resume_calibration_attempt"]])
    # No automatic requalification, replacement buyer token, or offer refill.
    os.execv(sys.executable, command)


if __name__ == "__main__":
    main()
