#!/usr/bin/env python3
"""Actual host process + newly owned PG/Redis + controlled native seller.

Creates no external model calls, never uses a pre-existing database or Redis.
Optional --evidence writes only an allowlisted, non-secret acceptance summary.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid


def run(*args, env=None):
    return subprocess.run(args, env=env, check=True, capture_output=True, text=True).stdout


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for(check, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(0.05)
    raise AssertionError("local acceptance timed out")


HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http(url, token=None, body=None, key=None):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if key:
        headers["Idempotency-Key"] = key
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        response = HTTP.open(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.read().decode()


def native_evidence(output):
    frames = [json.loads(line[6:]) for line in output.splitlines()
              if line.startswith("data: {")]
    assert any(choice.get("finish_reason") == "stop"
               for frame in frames for choice in frame.get("choices", [])), "missing native stop"
    assert any(frame.get("usage", {}).get("prompt_tokens") == 2
               and frame["usage"].get("completion_tokens") == 3
               and frame["usage"].get("total_tokens") == 5
               for frame in frames if frame.get("usage")), "missing requested native usage"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    binary = str(args.binary.resolve())
    for command in ["initdb", "pg_ctl", "createdb", "psql", "redis-server", "redis-cli"]:
        if not shutil.which(command):
            raise SystemExit(f"required local tool: {command}")
    with tempfile.TemporaryDirectory(prefix="private-market-a-") as temp:
        root = Path(temp)
        pg = root / "pg"
        pg_port, redis_port = free_port(), free_port()
        assert pg_port != redis_port
        user = os.environ.get("USER", "market")
        name = "private_market_" + uuid.uuid4().hex
        env = {k: v for k, v in os.environ.items() if not k.startswith(("RAILWAY_", "BITROUTER_", "DATABASE_", "REDIS_", "PRIVATE_MARKET_", "INFERENCE_MARKET_"))}
        state = root / "state"
        env.update({"DATABASE_URL": f"postgres://{user}@127.0.0.1:{pg_port}/{name}",
                    "REDIS_URL": f"redis://127.0.0.1:{redis_port}",
                    "BITROUTER_PREVIEW_BOOTSTRAP_BINDING": name,
                    "REDIS_BALANCE_CUTOVER_TOKEN": uuid.uuid4().hex,
                    "PRIVATE_MARKET_SELLER_KEY": uuid.uuid4().hex,
                    "DATABASE_MIN_CONNECTIONS": "1", "DATABASE_MAX_CONNECTIONS": "12",
                    "INFERENCE_MARKET_CONFIG_PATH": str(state / "catalog.json")})
        host = redis = None
        pg_started = False
        log = (root / "host.log").open("w+")
        try:
            run("initdb", "-D", str(pg), "-U", user, "-A", "trust", "--no-locale", "-E", "UTF8")
            run("pg_ctl", "-D", str(pg), "-l", str(root / "pg.log"), "-o", f"-h 127.0.0.1 -p {pg_port} -k {root}", "-w", "start")
            pg_started = True
            run("createdb", "-h", "127.0.0.1", "-p", str(pg_port), "-U", user, name)
            redis = subprocess.Popen(["redis-server", "--bind", "127.0.0.1", "--port", str(redis_port), "--save", "", "--appendonly", "no", "--maxmemory-policy", "noeviction"], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
            wait_for(lambda: subprocess.run(["redis-cli", "-p", str(redis_port), "ping"], capture_output=True).stdout.strip() == b"PONG")
            initialized = json.loads(run(binary, "init", str(state), env=env))
            assert initialized["initialized"] and initialized["buyers"] == 3
            assert (state.stat().st_mode & 0o777) == 0o700
            assert ((state / "state.json").stat().st_mode & 0o777) == 0o600
            repeat = subprocess.run([binary, "init", str(state)], env=env, capture_output=True)
            assert repeat.returncode != 0, "initialization must not refill an old market"
            data = json.loads((state / "state.json").read_text())
            host = subprocess.Popen([binary, "serve", str(state)], env=env, stdout=log, stderr=log)

            def started():
                assert host.poll() is None, "host exited before readiness"
                lines = (root / "host.log").read_text().splitlines()
                return next((json.loads(line)["url"] for line in lines if line.startswith('{') and '"url"' in line), None)

            url = wait_for(started, 30)
            assert json.loads(http(url + "/healthz")[1])["attested"] is False
            buyers = data["buyers"]
            endpoint = url + "/market/v1/chat/completions"
            body = {"model": "m/external", "messages": [{"role": "user", "content": "Batch A public synthetic prompt"}],
                    "max_completion_tokens": 64, "stream": True, "background": True,
                    "stream_options": {"include_usage": True},
                    "bitrouter_purchase": {"service_type": "on_demand", "provider_cap_micro_usd": 4500, "total_cap_micro_usd": 4510},
                    "bitrouter_delivery": {"auto_fallback": "off"}}
            assert http(endpoint, body=body, key="unauthenticated")[0] == 401
            assert http(endpoint, token=buyers[0]["token"] + "wrong", body=body, key="forged")[0] == 401

            def sql(query):
                return run("psql", env["DATABASE_URL"], "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query).strip()

            receipts = []
            for index, buyer in enumerate(buyers):
                key = f"batch-a-{index}"
                status, output = http(endpoint, buyer["token"], body, key)
                assert status == 200, (index, status, output)
                assert "verified" in output and output.endswith("data: [DONE]\n\n"), output
                native_evidence(output)
                receipt = wait_for(lambda: json.loads(sql(f"SELECT coalesce((SELECT r.receipt FROM market_inference_requests s JOIN market_inference_receipts r USING(request_id,revision) WHERE s.idempotency_key='{key}' AND r.receipt->'financial' IS NOT NULL),'null'::jsonb)")), 10)
                assert receipt["financial"]["provider_micro_usd"] == 35, receipt
                request_id = receipt["request_id"]
                status_url = url + "/market/v1/requests/" + request_id
                owner_status, owner = http(status_url, buyer["token"])
                assert owner_status == 200 and json.loads(owner)["fees"]["provider_micro_usd"] == 35
                assert http(status_url, buyers[(index + 1) % 3]["token"])[0] == 404
                assert http(status_url + "/events", buyers[(index + 1) % 3]["token"])[0] == 404
                assert http(status_url + "/cancel", buyers[(index + 1) % 3]["token"], {})[0] == 404
                replay_status, replay = http(status_url + "/events", buyer["token"])
                assert replay_status == 200 and "verified" in replay and replay.endswith("data: [DONE]\n\n")
                native_evidence(replay)
                assert replay == output, "replay changed the original native event sequence"
                duplicate_status, _ = http(endpoint, buyer["token"], body, key)
                assert duplicate_status == 200
                changed = copy.deepcopy(body)
                changed["bitrouter_purchase"]["provider_cap_micro_usd"] = 4499
                assert http(endpoint, buyer["token"], changed, key)[0] == 409
                fees = receipt["financial"]
                balance = int(sql(f"SELECT balance_micro_usd FROM credit_accounts WHERE user_id='{buyer['user']}'"))
                assert balance == 25000 - fees["cash_micro_usd"], (balance, fees)
                receipts.append({"provider_micro_usd": fees["provider_micro_usd"], "platform_micro_usd": fees["platform_micro_usd"], "cash_micro_usd": fees["cash_micro_usd"], "remaining_micro_usd": balance})
            assert int(sql("SELECT count(*) FROM market_inference_outbox WHERE kind='submit'")) == 3
            assert int(sql("SELECT count(*) FROM market_inference_requests")) == 3
            assert sql("SELECT count(*)=0 FROM redis_balance_mutations WHERE state<>'applied'") == "t"
            host.send_signal(signal.SIGINT)
            assert host.wait(timeout=15) == 0
            host = None
            evidence = {"batch": "A", "result": "pass", "cloud_commit": "244177cafa26e8c8b001e61297cf4e7f89ac8de9", "provider": "controlled-loopback-native-chat", "attested": False, "real_provider": False, "scheduler_dependency": False, "buyers": 3, "submit_effects": 3, "receipts": receipts, "checks": ["isolated-bootstrap", "no-refill", "verified-test-identity", "forged-credential-denial", "native-sse-terminal", "opted-in-usage-and-stop", "buyer-isolation", "event-replay", "idempotent-submit", "conflicting-submit-denial", "single-cash-ledger", "redis-confirmed", "owned-graceful-shutdown"]}
            if args.evidence:
                args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
            print(json.dumps(evidence, indent=2))
        except Exception:
            log.flush()
            print((root / "host.log").read_text())
            raise
        finally:
            if host is not None and host.poll() is None:
                host.send_signal(signal.SIGINT)
                try:
                    host.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    host.kill()
                    host.wait()
            if redis is not None:
                redis.terminate()
                redis.wait(timeout=5)
            if pg_started:
                run("pg_ctl", "-D", str(pg), "-m", "immediate", "-w", "stop")
            log.close()


if __name__ == "__main__":
    main()
