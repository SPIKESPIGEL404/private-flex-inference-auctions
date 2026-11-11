"""Read-only warmup/profile probes. Never submits inference or retries a generation."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import time
import aiohttp
from manage import call, CHUTE_ID

BASE = "https://kelsen-qwen-qwen3-8-27b-fp8.chutes.ai"


async def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--session", type=Path, required=True)
    parser.add_argument("--release", default="phase4-4")
    args = parser.parse_args()
    if args.session.exists():
        raise SystemExit("Session output must be new")
    key = args.key_file.expanduser().read_text().strip()
    deadline = time.monotonic() + 1800
    async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + key}, timeout=aiohttp.ClientTimeout(total=20), trust_env=False) as client:
        while time.monotonic() < deadline:
            try:
                async with client.post(BASE + "/scheduler/profile", json={}) as response:
                    if response.status == 200:
                        profile = await response.json()
                        async with client.post(BASE + "/scheduler/state", json={}) as state_response:
                            if state_response.status == 200:
                                state = await state_response.json()
                                if state["release"] == args.release and state["engine_epoch"] == profile["engine_epoch"] and state["accepting"]:
                                    with args.session.open("x") as file:
                                        json.dump(profile, file, indent=2)
                                    print(json.dumps({"ready": True, "release": state["release"], "engine_epoch": profile["engine_epoch"], "trace_count": len(state["traces"])}), flush=True)
                                    return
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
                pass
            status, warm = call(key, "/chutes/warmup/" + CHUTE_ID + "?quick=true")
            print(json.dumps({"ready": False, "status": status, "warmup": warm.get("status"), "instances": [{k: i.get(k) for k in ("instance_id", "active", "verified")} for i in warm.get("instances", [])]}), flush=True)
            await asyncio.sleep(10)
    raise SystemExit("Readiness deadline expired; no inference submitted")


if __name__ == "__main__":
    asyncio.run(main())
