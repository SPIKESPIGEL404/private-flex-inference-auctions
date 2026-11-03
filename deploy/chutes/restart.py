"""Explicit live recovery: seal old boot, verify native idle, disable this
private single-instance Chute, then enable and wait for a new instance/epoch.
Requires a completed phase4_chutes --mode interrupt run. Never resends inference.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
import aiohttp
from manage import call, CHUTE_ID

BASE = "https://kelsen-qwen-qwen3-8-27b-fp8.chutes.ai"


def durable_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(value, file, indent=2)
        file.flush()
        os.fsync(file.fileno())
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def native_idle(metrics):
    found = {}
    for line in metrics.splitlines():
        if line.startswith(("vllm:num_requests_running{", "vllm:num_requests_waiting{")):
            label, value = line.rsplit(" ", 1)
            name = label.split("{")[0]
            found[name] = found.get(name, 0) + float(value)
    return found == {"vllm:num_requests_running": 0.0, "vllm:num_requests_waiting": 0.0}


async def control_post(session, path, payload):
    async with session.post(BASE + path, json=payload) as response:
        if response.status != 200:
            raise RuntimeError("Control endpoint refused: HTTP " + str(response.status))
        return await response.json()


def replacement_candidate(current, old_id):
    if current.get("public") or current.get("disabled") or current.get("max_instances") != 1:
        raise RuntimeError("Private single-instance deployment policy changed")
    instances = current.get("instances", [])
    if len(instances) != 1:
        return None
    instance = instances[0]
    return instance if instance["instance_id"] != old_id and instance.get("active") and instance.get("verified") else None


async def wait_replacement(args, key, old, prepared, session):
    old_id = prepared["old_instance_id"]
    deadline = time.monotonic() + 1800
    while True:
        status, current = call(key, "/chutes/" + CHUTE_ID)
        if status != 200:
            raise RuntimeError("Management state unavailable after deletion")
        instances = current.get("instances", [])
        absent = all(i["instance_id"] != old_id for i in instances)
        candidate = replacement_candidate(current, old_id)
        if absent and candidate:
            try:
                fresh = await control_post(session, "/scheduler/profile", {})
            except (RuntimeError, aiohttp.ClientError, asyncio.TimeoutError):
                fresh = None
            if fresh and fresh["engine_epoch"] != old["engine_epoch"] and fresh["profile"] == old["profile"] and fresh["accepting"]:
                status, checked = call(key, "/chutes/" + CHUTE_ID)
                checked_candidate = replacement_candidate(checked, old_id) if status == 200 else None
                if not checked_candidate or checked_candidate["instance_id"] != candidate["instance_id"] or checked.get("version") != current.get("version"):
                    raise RuntimeError("Instance set changed across replacement profile probe; remain in recovery")
                proof = {**prepared, "old_instance_absent": True, "single_replacement_instance": True, "new_instance_id": candidate["instance_id"], "new_engine_epoch": fresh["engine_epoch"], "chute_id": CHUTE_ID, "chute_version": current["version"], "checked_at": datetime.now(timezone.utc).isoformat()}
                durable_json(args.evidence, proof)
                print(json.dumps(proof), flush=True)
                return
        if time.monotonic() >= deadline:
            raise RuntimeError("Replacement did not become ready; keep local scheduler in recovery")
        # Readiness/warmup GET only. No generation POST is retried.
        call(key, "/chutes/warmup/" + CHUTE_ID + "?quick=true")
        print(json.dumps({"phase": "waiting-for-replacement", "old_absent": absent, "instances": [{k: i.get(k) for k in ("instance_id", "active", "verified")} for i in instances]}), flush=True)
        await asyncio.sleep(10)


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--wait-replacement", action="store_true", help="Read-only resume from inspected .removed.json; never repeats disable/enable")
    args = parser.parse_args()
    if args.evidence.exists():
        raise SystemExit("Evidence path already exists; never repeat an uninspected restart")
    old = json.loads((args.run_dir / "session.json").read_text())
    interruption = json.loads((args.run_dir / "interrupted.json").read_text())
    assert interruption["snapshot"]["mode"] == "RECOVERY_REQUIRED"
    key = args.key_file.expanduser().read_text().strip()
    if args.wait_replacement:
        prepared = json.loads(args.evidence.with_suffix(".removed.json").read_text())
        assert prepared["old_engine_epoch"] == old["engine_epoch"]
        assert prepared["old_admission_sealed"] and prepared["old_native_idle"] and prepared["old_instance_absent"]
        assert prepared["owner_private_chute_disable"] and prepared["native_idle_samples"] >= 3
        async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + key}, timeout=aiohttp.ClientTimeout(total=30)) as session:
            await wait_replacement(args, key, old, prepared, session)
        return
    status, before = call(key, "/chutes/" + CHUTE_ID)
    instances = before.get("instances", [])
    if status != 200 or before.get("public") or before.get("max_instances") != 1 or len(instances) != 1 or not instances[0]["active"] or not instances[0]["verified"]:
        raise SystemExit("Expected exactly one active verified old instance")
    old_id = instances[0]["instance_id"]
    async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + key}, timeout=aiohttp.ClientTimeout(total=30)) as session:
        async def post(path, payload):
            async with session.post(BASE + path, json=payload) as response:
                if response.status != 200:
                    raise RuntimeError("Control endpoint refused: HTTP " + str(response.status))
                return await response.json()
        seal = await post("/scheduler/seal", {"engine_epoch": old["engine_epoch"]})
        assert not seal["accepting"] and seal["engine_epoch"] == old["engine_epoch"]
        deadline = time.monotonic() + 120
        idle_samples = 0
        while idle_samples < 3:
            state = await post("/scheduler/state", {})
            async with session.get(BASE + "/metrics") as response:
                if response.status != 200:
                    raise RuntimeError("Native metrics unavailable")
                idle = native_idle(await response.text())
            assert not state["accepting"] and state["engine_epoch"] == old["engine_epoch"]
            idle_samples = idle_samples + 1 if idle else 0
            if time.monotonic() >= deadline:
                raise RuntimeError("Old engine did not drain; admission remains sealed")
            await asyncio.sleep(1)
        print(json.dumps({"phase": "old-admission-sealed-and-native-idle", "instance_id": old_id}), flush=True)
        # A disconnected Cord may retain frontend bookkeeping in the SDK's
        # bounded producer queue. Record it honestly; only actual old-instance
        # removal below supplies the isolation proof, never these idle samples.
        prepared = {"old_engine_epoch": old["engine_epoch"], "old_instance_id": old_id, "old_admission_sealed": True, "old_native_idle": True, "old_frontdoor_active": state["active"], "native_idle_samples": idle_samples, "sealed_at": datetime.now(timezone.utc).isoformat()}
        pending = args.evidence.with_suffix(".prepared.json")
        durable_json(pending, prepared)
        status, checked = call(key, "/chutes/" + CHUTE_ID)
        if status != 200 or checked.get("public") or checked.get("version") != before.get("version") or [i["instance_id"] for i in checked.get("instances", [])] != [old_id]:
            raise RuntimeError("Instance set changed before isolation; inspect prepared evidence")
        # Owner API: miner-only /instances DELETE cannot be used with an owner
        # API key. Disabling a private Chute terminates its instances. We have
        # just checked there is exactly one and that it is the expected old boot.
        status, response = call(key, "/chutes/" + CHUTE_ID, b'{"disabled":true}', method="PUT")
        if status != 200 or not response.get("disabled"):
            raise RuntimeError("Private Chute disable refused: HTTP " + str(status))
        status, disabled = call(key, "/chutes/" + CHUTE_ID)
        if status != 200 or not disabled.get("disabled") or disabled.get("instances"):
            raise RuntimeError("Old instance removal not verified; Chute remains disabled")
        durable_json(args.evidence.with_suffix(".removed.json"), {**prepared, "old_instance_absent": True, "owner_private_chute_disable": True})
        status, response = call(key, "/chutes/" + CHUTE_ID, b'{"disabled":false}', method="PUT")
        if status != 200 or response.get("disabled"):
            raise RuntimeError("Private Chute enable refused: HTTP " + str(status))
        await wait_replacement(args, key, old, prepared, session)


if __name__ == "__main__":
    asyncio.run(main())
