#!/usr/bin/env python3
"""Sentinel minting, multi-encoding search, and allowlisted no-leak scanning."""
from __future__ import annotations

import argparse
import base64
import json
import os
import random
import re
import secrets
import sys
import urllib.parse
import uuid
from pathlib import Path
from typing import Iterable

SENTINEL_NAMES = (
    "provider_cap",
    "total_cap",
    "buyer_bearer",
    "idempotency_key",
    "buyer_signature",
    "buyer_nonce",
    "prompt_marker",
    "provider_key",
)


# Lab cash raised in the no-leak script; must not substring-match sentinel caps.
LAB_BALANCE_MICRO_USD = 9_876_543_210_000


def mint_sentinels() -> dict:
    """Fresh distinctive sentinels. Caps are ≥9 digit ints that still settle."""
    bal = str(LAB_BALANCE_MICRO_USD)
    while True:
        provider_cap = random.randint(100_000_000, 899_999_999)
        total_cap = provider_cap + random.randint(100, 9999)
        if str(provider_cap) not in bal and str(total_cap) not in bal:
            break
    marker = "NOLEAK_PROMPT_" + uuid.uuid4().hex
    token_id = uuid.uuid4().hex
    bearer = f"brk_{token_id}.{token_id}{token_id}"
    return {
        "provider_cap": provider_cap,
        "total_cap": total_cap,
        "buyer_bearer": bearer,
        "idempotency_key": "noleak-idem-" + uuid.uuid4().hex,
        "prompt_marker": marker,
        "provider_key": "sk_noleak_" + secrets.token_hex(24),
        # Filled after the successful signed purchase:
        "buyer_signature": None,
        "buyer_nonce": None,
    }


def encodings_for(name: str, value) -> dict[str, str]:
    """Return encoding_name -> needle string (all searchable as substrings)."""
    out: dict[str, str] = {}
    if isinstance(value, int):
        dec = str(value)
        out["decimal"] = dec
        out["json_number"] = dec
        out["json_string"] = json.dumps(dec)[1:-1]  # escaped contents if any
        raw = dec.encode("utf-8")
    else:
        text = str(value)
        out["raw"] = text
        raw = text.encode("utf-8")
        out["json_string"] = json.dumps(text)[1:-1]
    out["hex"] = raw.hex()
    out["base64"] = base64.b64encode(raw).decode("ascii")
    if not isinstance(value, int):
        out["url"] = urllib.parse.quote(str(value), safe="")
    else:
        out["url"] = urllib.parse.quote(str(value), safe="")
        out["raw"] = str(value)
    return out


def all_needles(sentinels: dict) -> list[tuple[str, str, str]]:
    """List of (sentinel_name, encoding, needle). Skips unset sentinels."""
    rows = []
    for name in SENTINEL_NAMES:
        value = sentinels.get(name)
        if value is None or value == "":
            continue
        for enc, needle in encodings_for(name, value).items():
            if needle:
                rows.append((name, enc, needle))
    return rows


def find_hits(blob: bytes | str, sentinels: dict) -> list[tuple[str, str]]:
    if isinstance(blob, str):
        text = blob
        raw = blob.encode("utf-8", errors="surrogateescape")
    else:
        raw = blob
        text = blob.decode("utf-8", errors="surrogateescape")
    hits = []
    seen = set()
    for name, enc, needle in all_needles(sentinels):
        key = (name, enc)
        if key in seen:
            continue
        found = False
        if enc in ("hex", "base64"):
            # Search both text and raw ascii views.
            if needle in text or needle.encode("ascii") in raw:
                found = True
        else:
            if needle in text:
                found = True
            else:
                try:
                    if needle.encode("utf-8") in raw:
                        found = True
                except UnicodeEncodeError:
                    pass
        if found:
            seen.add(key)
            hits.append((name, enc))
    return hits


# Exact carve-out paths (market container). Trailing slash = directory prefix.
MARKET_SECRETS_DIR = "/var/lib/market/secrets/"
PG_DATA_DIR = "/var/lib/postgresql"
SELLER_CAPTURE = "/var/lib/market/state/seller-capture.jsonl"


def path_carved_out(path: str, *, container: str) -> bool:
    if path == PG_DATA_DIR or path.startswith(PG_DATA_DIR + "/"):
        return True
    if container == "market":
        if path == SELLER_CAPTURE:
            return True
        if path == MARKET_SECRETS_DIR.rstrip("/") or path.startswith(MARKET_SECRETS_DIR):
            return True
    return False


def allow_hit(
    *,
    surface: str,
    sentinel: str,
    container: str | None = None,
    path: str | None = None,
    http_label: str | None = None,
) -> bool:
    """Return True when this hit is an explicitly allowed location."""
    if surface == "positive_control":
        return True
    if surface == "seller_capture":
        return sentinel in ("prompt_marker", "provider_key")
    if surface == "http" and http_label == "buyer1_success":
        # Own SSE may only echo buyer-owned values; fixture returns "verified".
        return False
    if surface == "http" and http_label == "buyer1_receipt":
        # Receipt is that buyer's own committed record (caps/fees/idempotency).
        return sentinel in (
            "idempotency_key",
            "provider_cap",
            "total_cap",
        )
    if surface == "market_environ":
        return sentinel in ("buyer_bearer", "provider_key")
    if surface == "file" and container == "market" and path is not None:
        if path_carved_out(path, container="market"):
            # Secrets may hold bearer? Bearer is env-only; provider_key is seller_key file.
            if path.startswith(MARKET_SECRETS_DIR) or path == MARKET_SECRETS_DIR.rstrip("/"):
                return sentinel == "provider_key"
            if path == SELLER_CAPTURE:
                return sentinel in ("prompt_marker", "provider_key")
    return False


def scan_blob(
    blob: bytes | str,
    sentinels: dict,
    *,
    surface: str,
    container: str | None = None,
    path: str | None = None,
    http_label: str | None = None,
    phase: str,
) -> list[dict]:
    findings = []
    for name, enc in find_hits(blob, sentinels):
        if allow_hit(
            surface=surface,
            sentinel=name,
            container=container,
            path=path,
            http_label=http_label,
        ):
            continue
        findings.append(
            {
                "phase": phase,
                "surface": surface,
                "container": container,
                "path": path,
                "http_label": http_label,
                "sentinel": name,
                "encoding": enc,
            }
        )
    return findings


def assert_positive_control(probe_text: str, sentinel_value: str) -> None:
    hits = find_hits(probe_text, {"prompt_marker": sentinel_value})
    if not hits:
        raise SystemExit("positive control failed: scanner did not detect planted sentinel")


def check_deploy_compose_clean(root: Path) -> None:
    """Rendered production compose + allowed_envs must not mention capture env."""
    sys.path.insert(0, str(root / "scripts"))
    # Inline check without importing side effects: read files directly.
    compose = (root / "deploy" / "market" / "docker-compose.yml").read_text(encoding="utf-8")
    if "PRIVATE_MARKET_SELLER_CAPTURE" in compose:
        raise SystemExit("deploy docker-compose.yml must not contain PRIVATE_MARKET_SELLER_CAPTURE")
    render = (root / "scripts" / "render-market-compose-hash.py").read_text(encoding="utf-8")
    # allowed_envs is defined in the renderer.
    m = re.search(r"ALLOWED_ENVS\s*=\s*\[(.*?)\]", render, re.S)
    if not m:
        raise SystemExit("ALLOWED_ENVS not found in render-market-compose-hash.py")
    if "PRIVATE_MARKET_SELLER_CAPTURE" in m.group(0):
        raise SystemExit("allowed_envs must not contain PRIVATE_MARKET_SELLER_CAPTURE")
    # Also render once if buyers.public.json exists.
    buyers = root / "deploy" / "market" / "buyers.public.json"
    if buyers.is_file():
        import subprocess

        out = subprocess.check_output(
            [
                sys.executable,
                str(root / "scripts" / "render-market-compose-hash.py"),
                "--market-image",
                "private-market-host@sha256:" + ("ab" * 32),
                "--domain",
                "demo.bitrouter.ai",
                "--buyers-public",
                str(buyers),
                "--out-dir",
                str(root / ".accept-work" / "no-leak-compose-check"),
            ],
            text=True,
        )
        rendered_dir = root / ".accept-work" / "no-leak-compose-check"
        for path in rendered_dir.rglob("*"):
            if path.is_file():
                text = path.read_text(encoding="utf-8", errors="replace")
                if "PRIVATE_MARKET_SELLER_CAPTURE" in text:
                    raise SystemExit(f"rendered deploy artifact contains capture env: {path}")


def p3_check_capture(capture_text: str, sentinels: dict) -> list[dict]:
    """Upstream capture may only contain native chat fields + provider credential."""
    findings = []
    for line in capture_text.splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            findings.append(
                {
                    "phase": "success",
                    "surface": "seller_capture",
                    "sentinel": "parse",
                    "encoding": "raw",
                    "detail": "invalid_jsonl",
                }
            )
            continue
        headers = {k.lower(): v for k, v in (entry.get("headers") or {}).items()}
        body = entry.get("body") or {}
        # Forbidden headers
        for hk in list(headers):
            if hk.startswith("x-buyer-") or hk.startswith("x-e2ee-") or hk in (
                "x-client-pub-key",
                "x-model-pub-key",
                "idempotency-key",
            ):
                findings.append(
                    {
                        "phase": "success",
                        "surface": "seller_capture",
                        "sentinel": "forbidden_header",
                        "encoding": "raw",
                        "detail": hk,
                    }
                )
        if isinstance(body, dict):
            for key in body:
                if str(key).startswith("bitrouter_") or key == "background":
                    findings.append(
                        {
                            "phase": "success",
                            "surface": "seller_capture",
                            "sentinel": "forbidden_field",
                            "encoding": "raw",
                            "detail": key,
                        }
                    )
        # Sentinel scan with allowlist for prompt + provider key only.
        findings.extend(
            scan_blob(
                line,
                sentinels,
                surface="seller_capture",
                phase="success",
            )
        )
    return findings


def summary_line(
    *,
    surfaces: int,
    sentinels: int,
    encodings: int,
    hits: int,
    phases: list[str],
) -> str:
    return json.dumps(
        {
            "market_no_leak": "pass" if hits == 0 else "fail",
            "surfaces_scanned": surfaces,
            "sentinels": sentinels,
            "encodings": encodings,
            "hits": hits,
            "phases": phases,
        },
        separators=(",", ":"),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_mint = sub.add_parser("mint")
    p_mint.add_argument("--out", type=Path, required=True)

    p_pos = sub.add_parser("positive-control")
    p_pos.add_argument("--sentinel", required=True)
    p_pos.add_argument("--probe-file", type=Path, required=True)

    p_check = sub.add_parser("check-deploy-compose")
    p_check.add_argument("--root", type=Path, required=True)

    p_scan = sub.add_parser("scan-file")
    p_scan.add_argument("--sentinels", type=Path, required=True)
    p_scan.add_argument("--phase", required=True)
    p_scan.add_argument("--surface", required=True)
    p_scan.add_argument("--path", type=Path, required=True)
    p_scan.add_argument("--container", default=None)
    p_scan.add_argument("--file-path", default=None, help="path inside container for carve-outs")
    p_scan.add_argument("--http-label", default=None)
    p_scan.add_argument("--findings-out", type=Path, required=True)

    p_p3 = sub.add_parser("p3-capture")
    p_p3.add_argument("--sentinels", type=Path, required=True)
    p_p3.add_argument("--capture", type=Path, required=True)
    p_p3.add_argument("--findings-out", type=Path, required=True)

    p_sum = sub.add_parser("summary")
    p_sum.add_argument("--findings", type=Path, required=True)
    p_sum.add_argument("--surfaces", type=int, required=True)
    p_sum.add_argument("--sentinels", type=int, required=True)
    p_sum.add_argument("--encodings", type=int, required=True)
    p_sum.add_argument("--phases", default="success,failure")

    args = parser.parse_args(argv)

    if args.cmd == "mint":
        data = mint_sentinels()
        args.out.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.chmod(args.out, 0o600)
        return 0

    if args.cmd == "positive-control":
        text = args.probe_file.read_text(encoding="utf-8", errors="replace")
        assert_positive_control(text, args.sentinel)
        print(json.dumps({"positive_control": "pass"}))
        return 0

    if args.cmd == "check-deploy-compose":
        check_deploy_compose_clean(args.root)
        print(json.dumps({"deploy_compose_capture": "absent"}))
        return 0

    if args.cmd == "scan-file":
        sentinels = json.loads(args.sentinels.read_text(encoding="utf-8"))
        blob = args.path.read_bytes()
        findings = scan_blob(
            blob,
            sentinels,
            surface=args.surface,
            container=args.container,
            path=args.file_path,
            http_label=args.http_label,
            phase=args.phase,
        )
        existing = []
        if args.findings_out.is_file():
            existing = json.loads(args.findings_out.read_text(encoding="utf-8") or "[]")
        existing.extend(findings)
        args.findings_out.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"new_hits": len(findings)}))
        return 0

    if args.cmd == "p3-capture":
        sentinels = json.loads(args.sentinels.read_text(encoding="utf-8"))
        text = args.capture.read_text(encoding="utf-8", errors="replace")
        findings = p3_check_capture(text, sentinels)
        existing = []
        if args.findings_out.is_file():
            existing = json.loads(args.findings_out.read_text(encoding="utf-8") or "[]")
        existing.extend(findings)
        args.findings_out.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"new_hits": len(findings)}))
        return 0

    if args.cmd == "summary":
        findings = json.loads(args.findings.read_text(encoding="utf-8") or "[]")
        # Drop positive_control surface from hit count (should be empty after filter).
        real = [f for f in findings if f.get("surface") != "positive_control"]
        line = summary_line(
            surfaces=args.surfaces,
            sentinels=args.sentinels,
            encodings=args.encodings,
            hits=len(real),
            phases=args.phases.split(","),
        )
        print(line)
        if real:
            # Report sentinel names only — never values.
            for f in real:
                print(
                    json.dumps(
                        {
                            "leak": True,
                            "phase": f.get("phase"),
                            "surface": f.get("surface"),
                            "container": f.get("container"),
                            "path": f.get("path"),
                            "http_label": f.get("http_label"),
                            "sentinel": f.get("sentinel"),
                            "encoding": f.get("encoding"),
                            "detail": f.get("detail"),
                        }
                    ),
                    file=sys.stderr,
                )
            return 1
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
