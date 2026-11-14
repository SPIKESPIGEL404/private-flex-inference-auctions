"""Prepare a private, pinned Chutes Gateway run; makes zero inference calls."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import urllib.request
import uuid

from huggingface_hub import hf_hub_download
from gateway import CHUTE_ID, NATIVE_MODEL, PUBLIC_MODEL, ORIGIN, API, canonical, load_config

REVISION = "017b9c7af6b5689d5dd426a76e0bc077eb5ca20a"
IMAGE = "6e46a33c-329a-5b55-a1dd-c9a5c9866943"


def save(path, value):
    raw = value if isinstance(value, bytes) else canonical(value)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(raw); output.flush(); os.fsync(output.fileno())


def prepare(args):
    root = Path(args.output).resolve()
    root.mkdir(mode=0o700)
    key_file = Path(args.key_file).expanduser().resolve()
    assert key_file.stat().st_mode & 0o077 == 0
    key = key_file.read_text().strip()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs): return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def get(path):
        with opener.open(urllib.request.Request(API + path, headers={"Authorization": "Bearer " + key}), timeout=30) as response:
            return json.load(response)
    metadata = get("/chutes/" + CHUTE_ID)
    assert metadata["chute_id"] == CHUTE_ID and metadata["tee"] and not metadata["public"]
    assert metadata["revision"] == REVISION and metadata["image"]["image_id"] == IMAGE
    receipt = json.loads(Path(args.deployment_receipt).read_bytes())
    source_sha = hashlib.sha256(Path(__file__).with_name("market_chute.py").read_bytes()).hexdigest()
    assert receipt["applied"] and receipt["chute_id"] == CHUTE_ID and receipt["source_sha256"] == source_sha
    assert receipt["version"] == metadata["version"]
    assert "/v1/chat/completions" in {c["public_api_path"] for c in metadata["cords"]}
    # Trust inputs come from the vendor's reference registry, NEVER from the
    # instance quote being verified. Freeze the exact reference snapshot locally.
    published = get("/servers/tee/measurements")
    accepted_gpus = set(metadata["node_selector"]["include"])
    profiles = [p for p in published if p.get("expected_gpus")
        and set(p["expected_gpus"]) <= accepted_gpus]
    assert profiles
    save(root / "measurement-reference.json", published)
    save(root / "local-secret", secrets.token_hex(32).encode())
    files = {name: hf_hub_download(NATIVE_MODEL, name, revision=REVISION)
        for name in ["tokenizer.json", "tokenizer_config.json"]}
    configuration = json.loads(Path(files["tokenizer_config.json"]).read_bytes())
    if not configuration.get("chat_template"):
        files["chat_template.jinja"] = hf_hub_download(NATIVE_MODEL, "chat_template.jinja", revision=REVISION)
    paths = {}
    for name, source in files.items():
        destination = root / name
        save(destination, Path(source).read_bytes())
        paths[name] = str(destination)
    hashes = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in paths.items()}
    config = {"version": 1, "public_model": PUBLIC_MODEL, "native_model": NATIVE_MODEL,
        "chute_id": CHUTE_ID, "origin": ORIGIN, "chute_image": IMAGE, "model_revision": REVISION,
        "chute_version": metadata["version"], "chute_code_sha256": source_sha,
        "approved_measurement_policy": True, "measurement_profiles": profiles,
        "measurement_policy_source": "Chutes-published reference profiles, pinned before instance verification; vendor policy trust, not an independent reproducible-build audit",
        "measurement_reference_sha256": hashlib.sha256(canonical(published)).hexdigest(),
        "key_file": str(key_file), "local_secret_file": str(root / "local-secret"),
        "evidence_directory": str(root / "provider-evidence"), "min_gpu_count": 1, "max_gpu_count": 8}
    save(root / "gateway.json", config)
    load_config(root / "gateway.json")
    plan = {"version": 1, "market_id": "private_market_chutes_" + uuid.uuid4().hex,
        "public_model": PUBLIC_MODEL, "native_model": NATIVE_MODEL,
        "tokenizer_files": paths, "tokenizer_files_sha256": hashes,
        "tokenizer_ref": "hf/" + REVISION + "/native-default-v1", "model_revision_ref": NATIVE_MODEL + "@" + REVISION,
        "max_output_tokens": 512, "context_window_tokens": 32768,
        "rates": {"input": 1_000_000, "cache_input": 1_000_000, "output": 11_000_000},
        "price_scope": "explicit project-seller test-credit rates; GPU wall-clock billing is separate",
        "gateway_config": str(root / "gateway.json"),
        "upstream_budget_micro_usd": 18446744073709551615,
        "chutes_spend_cap_micro_usd": None,
        "upstream_cost_authorization": "User explicitly removed Chutes spending limits and requested completion",
        "maximum_upstream_calls": 4, "finite_offers": 3}
    save(root / "plan.json", plan)
    print(json.dumps({"prepared": True, "model": PUBLIC_MODEL,
        "plan_sha256": hashlib.sha256((root / "plan.json").read_bytes()).hexdigest(),
        "inference_calls": 0, "reference_profiles": len(profiles)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--deployment-receipt", required=True)
    parser.add_argument("--output", required=True)
    os.umask(0o077)
    prepare(parser.parse_args())
