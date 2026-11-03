"""Prepare/review or update the existing private replica; never accepts a new deployment fee."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import runpy
from urllib.request import Request, urlopen
from urllib.error import HTTPError

BASE = "https://api.chutes.ai"
CHUTE_ID = "5f5b67f2-139e-5857-bdfb-94a30e03a526"


def call(key, path, body=None, method="GET"):
    headers = {"Authorization": "Bearer " + key, "X-Chutes-Version": importlib.metadata.version("chutes")}
    if body is not None:
        headers["Content-Type"] = "application/json"
    try:
        with urlopen(Request(BASE + path, headers=headers, data=body, method=method), timeout=50) as response:
            raw=response.read()
            return response.status, json.loads(raw) if raw else {}
    except HTTPError as error:
        return error.code, json.loads(error.read())


def prepare():
    source = Path(__file__).with_name("chute.py")
    app = runpy.run_path(str(source))["chute"].chute
    assert app.uid == CHUTE_ID and app.max_instances == 1 and app.tee
    assert app.node_selector.include == ["pro_6000"]
    assert app.standard_template == "vllm" and app.lock_modules is True
    assert {c.public_api_path for c in app.cords} == {"/scheduler/profile", "/scheduler/tokenize", "/scheduler/completions", "/scheduler/state", "/scheduler/seal", "/metrics"}
    body = {
        "name": app.name, "tagline": app.tagline, "readme": app.readme, "logo_id": None,
        "image": app.image, "public": False, "standard_template": app.standard_template,
        "node_selector": app.node_selector.model_dump(), "filename": "chute.py", "ref_str": "chute:chute", "code": source.read_text(),
        "concurrency": app.concurrency, "max_instances": app.max_instances, "scaling_threshold": app.scaling_threshold,
        "shutdown_after_seconds": app.shutdown_after_seconds, "allow_external_egress": app.allow_external_egress,
        "encrypted_fs": app.encrypted_fs, "tee": app.tee, "lock_modules": app.lock_modules,
        "revision": app.revision, "use_rolling_update": False,
        "cords": [{"method": c._method, "path": c.path, "public_api_path": c.public_api_path, "public_api_method": c._public_api_method,
                   "stream": c._stream, "function": c._func.__name__, "input_schema": c.input_schema, "output_schema": c.output_schema,
                   "output_content_type": c.output_content_type, "minimal_input_schema": c.minimal_input_schema, "passthrough": c._passthrough} for c in app.cords], "jobs": [],
    }
    return body


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    key = args.key_file.expanduser().read_text().strip()
    args.output.mkdir(parents=True, exist_ok=True)
    status, current = call(key, "/chutes/" + CHUTE_ID)
    if status != 200 or current.get("public") or current.get("user", {}).get("username", "kelsen") != "kelsen":
        raise SystemExit("Existing private replica verification failed")
    status, prices = call(key, "/pricing")
    if status != 200 or prices["gpu_price_estimates"]["pro_6000"]["usd"]["hour"] > 2.25:
        raise SystemExit("Current GPU estimate exceeds the existing $2.25/hour ceiling")
    body = prepare()
    (args.output / "request.json").write_text(json.dumps(body, indent=2) + "\n")
    before = {k: current.get(k) for k in ("chute_id", "version", "image", "revision", "max_instances", "node_selector", "cords", "instances")}
    (args.output / "before.json").write_text(json.dumps(before, indent=2) + "\n")
    result = {"applied": False, "chute_id": CHUTE_ID, "source_sha256": hashlib.sha256(body["code"].encode()).hexdigest(), "accept_fee": False}
    if args.apply:
        status, response = call(key, "/chutes/?accept_fee=false", json.dumps(body).encode(), "POST")
        result.update({"applied": status in (200, 201), "http_status": status, "version": response.get("version"), "detail": response.get("detail")})
        (args.output / "update.json").write_text(json.dumps(result, indent=2) + "\n")
        if not result["applied"]:
            raise SystemExit(json.dumps(result))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
