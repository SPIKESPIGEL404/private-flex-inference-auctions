#!/usr/bin/env python3
"""Render the exact dstack app-compose.json and its compose hash.

dstack does NOT hash docker-compose.yml alone. It hashes the canonical JSON
form of app-compose.json, which embeds the full compose file as the string
field docker_compose_file, plus metadata (runner, allowed_envs, kms_enabled,
gateway_enabled, public_logs, public_sysinfo, pre_launch_script, ...).

Canonicalization matches dstack's published rules:
  - recursively sort object keys
  - compact separators (',' ':')
  - UTF-8 (ensure_ascii=False)
  - NaN/Inf -> null

The resulting 64-hex digest is what buyers put in acceptedComposeHashes and
what appears in the RTMR3 compose-hash event. Deploy MUST upload this exact
rendered app-compose.json so the locally computed hash equals the measured one.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "deploy" / "market"

# Encrypted secrets only. Public buyer keys are literals in the compose file.
# DNS is Namecheap (see dstack-ingress DNS_PROVIDERS.md). ACME_EMAIL replaces
# legacy CERTBOT_EMAIL.
ALLOWED_ENVS = [
    "BUYER_0_TOKEN",
    "BUYER_1_TOKEN",
    "BUYER_2_TOKEN",
    "NAMECHEAP_USERNAME",
    "NAMECHEAP_API_KEY",
    "NAMECHEAP_CLIENT_IP",
    "ACME_EMAIL",
]


def handle_nan_inf(obj):
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
        return None
    raise TypeError(f"Object of type {obj.__class__.__name__} is not JSON serializable")


def deterministic_json(value) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
        default=handle_nan_inf,
    )


def compose_hash(app_compose: dict) -> str:
    return hashlib.sha256(deterministic_json(app_compose).encode("utf-8")).hexdigest()


def load_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def render_compose(market_image: str, domain: str, buyers_json: str) -> str:
    template = load_text(DEPLOY / "docker-compose.yml")
    # Replace the market image placeholder and domain defaults with deploy values.
    rendered = template.replace(
        "${MARKET_IMAGE:-private-market-host:local}",
        market_image,
    )
    rendered = rendered.replace("${PRIVATE_MARKET_DOMAIN:-market.example.com}", domain)
    rendered = rendered.replace("${PRIVATE_MARKET_ENABLE_ATTESTATION:-1}", "1")
    # Buyer public config is mounted from the deploy directory; ensure the
    # measured compose references the committed public file name only.
    if '"public_keys"' not in buyers_json:
        raise SystemExit("buyers.public.json must contain public_keys")
    return rendered


def build_app_compose(docker_compose_file: str, pre_launch_script: str) -> dict:
    # Fields are set explicitly so Phala/dashboard defaults cannot silently
    # change the measured manifest. public_logs/public_sysinfo stay false.
    return {
        "manifest_version": 2,
        "name": "private-market",
        "runner": "docker-compose",
        "docker_compose_file": docker_compose_file,
        "docker_config": {},
        "kms_enabled": True,
        "gateway_enabled": True,
        "public_logs": False,
        "public_sysinfo": False,
        "public_tcbinfo": True,
        "local_key_provider_enabled": False,
        "allowed_envs": ALLOWED_ENVS,
        "no_instance_id": False,
        "secure_time": True,
        "pre_launch_script": pre_launch_script,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--market-image",
        required=True,
        help="Market image reference pinned by digest, e.g. ghcr.io/org/private-market-host@sha256:…",
    )
    parser.add_argument("--domain", required=True, help="Public HTTPS domain")
    parser.add_argument(
        "--buyers-public",
        type=Path,
        default=DEPLOY / "buyers.public.json",
        help="Public buyer verifying-key file (measured via image/compose mount path)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEPLOY / "rendered",
        help="Directory for app-compose.json and compose.hash",
    )
    args = parser.parse_args()
    if "@sha256:" not in args.market_image:
        raise SystemExit("market image must be pinned by @sha256 digest")
    buyers = args.buyers_public.read_text(encoding="utf-8")
    json.loads(buyers)  # structural check; contents are public keys only
    docker_compose = render_compose(args.market_image, args.domain, buyers)
    pre_launch = load_text(DEPLOY / "pre_launch.sh")
    app_compose = build_app_compose(docker_compose, pre_launch)
    digest = compose_hash(app_compose)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    app_path = args.out_dir / "app-compose.json"
    # Write the exact JSON object (pretty for operators). The hash uses the
    # canonical compact form, not this pretty encoding.
    app_path.write_text(json.dumps(app_compose, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (args.out_dir / "app-compose.canonical.json").write_text(
        deterministic_json(app_compose) + "\n", encoding="utf-8"
    )
    (args.out_dir / "compose.hash").write_text(digest + "\n", encoding="utf-8")
    (args.out_dir / "docker-compose.rendered.yml").write_text(docker_compose, encoding="utf-8")
    print(
        json.dumps(
            {
                "compose_hash": digest,
                "app_compose": str(app_path),
                "canonical": str(args.out_dir / "app-compose.canonical.json"),
                "allowed_envs": ALLOWED_ENVS,
                "public_logs": False,
                "public_sysinfo": False,
                "note": "Deploy this exact app-compose.json. Buyers pin compose_hash.",
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
