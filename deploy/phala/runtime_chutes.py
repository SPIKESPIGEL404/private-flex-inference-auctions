"""Owned persistent Market + in-CVM Chutes verifier/transport.

--initialize is an explicit, one-time bounded qualification, never a boot action.
Ordinary restarts resume the same ledger and never refill its finite offers.
"""
import argparse
import fcntl
import json
import os
import re
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "chutes"))
from gateway import PUBLIC_MODEL, NATIVE_MODEL, ORIGIN, canonical, sha, private_file, load_config
from prepare_gateway import save
from tokenizer import Server

STOP = threading.Event()


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0)); return sock.getsockname()[1]


def run(*args, env=None):
    result = subprocess.run(args, env=env, capture_output=True)
    if result.returncode:
        raise RuntimeError("owned command failed: " + Path(str(args[0])).name)
    return result.stdout


def ready(url, child):
    for _ in range(300):
        if child.poll() is not None: raise RuntimeError("owned worker exited before readiness")
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200: return
        except OSError: pass
        time.sleep(0.1)
    raise RuntimeError("owned worker readiness timed out")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-directory", default="/data/chutes-run")
    parser.add_argument("--binary", default="/usr/local/bin/private-market-host")
    parser.add_argument("--initialize", action="store_true")
    parser.add_argument("--approved-plan-sha256")
    parser.add_argument("--approved-config-sha256", required=True)
    parser.add_argument("--listen", default="127.0.0.1:3000")
    parser.add_argument("--tls-config")
    parser.add_argument("--nginx-config")
    parser.add_argument("--buyer-key-file")
    parser.add_argument("--buyer-public-keys")
    parser.add_argument("--resume-calibration-attempt")
    args = parser.parse_args()
    assert bool(args.buyer_key_file) == bool(args.buyer_public_keys), "bearer tokens require offline buyer verifying keys"
    if args.buyer_key_file:
        assert Path(args.buyer_key_file).stat().st_mode & 0o077 == 0, "bearer token file must be private"
    for name in ("CHUTES_API_KEY", "MARKET_ARTIFACT_KEY", "MARKET_BUYER_KEYS_B64"):
        os.environ.pop(name, None)
    assert not (args.initialize and args.resume_calibration_attempt)
    if args.resume_calibration_attempt:
        assert re.fullmatch(r"[a-z0-9-]{1,64}", args.resume_calibration_attempt)
    if args.tls_config:
        assert args.buyer_key_file and args.buyer_public_keys, "deployment needs offline buyer verifying keys and sealed bearer tokens"
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    signal.signal(signal.SIGINT, lambda *_: STOP.set())
    root = Path(args.run_directory).resolve()
    lock = open(root / "owner.lock", "a"); fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    plan = json.loads((root / "plan.json").read_bytes())
    assert args.approved_plan_sha256 == sha((root / "plan.json").read_bytes()), "plan differs from the approved release"
    assert args.approved_config_sha256 == sha(Path(plan["gateway_config"]).read_bytes()), "provider policy differs from the approved release"
    config = load_config(plan["gateway_config"])
    assert plan["public_model"] == PUBLIC_MODEL and plan["native_model"] == NATIVE_MODEL
    private_file(config["key_file"])
    secret = private_file(config["local_secret_file"])
    state = root / "state"
    if args.initialize:
        assert not state.exists() and not (root / "runtime.json").exists(), "never repeat an incomplete qualification"
        assert args.approved_plan_sha256 == sha((root / "plan.json").read_bytes()), "approve this exact plan"
        assert plan.get("chutes_spend_cap_micro_usd") is None, "this plan must carry the explicit uncapped Chutes authorization"
        assert plan["upstream_budget_micro_usd"] == 18446744073709551615
        assert plan["maximum_upstream_calls"] == 4 and plan["finite_offers"] == 3
        settings = {"pg_port": port(), "redis_port": port(), "tokenizer_port": port(), "bridge_port": port(),
            "database": plan["market_id"], "binding": uuid.uuid4().hex, "cutover": uuid.uuid4().hex}
        save(root / "runtime.json", settings)
    else:
        assert (state / "catalog.json").exists() or args.resume_calibration_attempt, "first run needs explicit qualification approval"
        if args.resume_calibration_attempt:
            assert not (state / "catalog.json").exists(), "never recalibrate a qualified ledger"
            assert (root / "calibration-intent.json").exists(), "no original calibration to resume"
        settings = json.loads((root / "runtime.json").read_bytes())
    user = os.environ.get("USER", "market")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("RAILWAY_", "BITROUTER_", "DATABASE_", "REDIS_", "PRIVATE_MARKET_", "INFERENCE_MARKET_"))}
    env.update(DATABASE_URL=f"postgres://{user}@127.0.0.1:{settings['pg_port']}/{settings['database']}",
        REDIS_URL=f"redis://127.0.0.1:{settings['redis_port']}", BITROUTER_PREVIEW_BOOTSTRAP_BINDING=settings["binding"],
        REDIS_BALANCE_CUTOVER_TOKEN=settings["cutover"], PRIVATE_MARKET_SELLER_KEY=secret,
        PRIVATE_MARKET_PUBLIC_MODEL=PUBLIC_MODEL, PRIVATE_MARKET_LISTEN=args.listen,
        PRIVATE_MARKET_CHUTES_EVIDENCE_DIR=config["evidence_directory"],
        DATABASE_MIN_CONNECTIONS="1", DATABASE_MAX_CONNECTIONS="12", INFERENCE_MARKET_CONFIG_PATH=str(state / "catalog.json"))
    if os.environ.get("PRIVATE_MARKET_ATTESTATION_CONFIG"):
        env["PRIVATE_MARKET_ATTESTATION_CONFIG"] = os.environ["PRIVATE_MARKET_ATTESTATION_CONFIG"]
    if args.tls_config:
        assert args.nginx_config, "TLS serving needs its measured nginx configuration"
        from tls import prepare as prepare_tls
        prepare_tls(args.tls_config)
        env["PRIVATE_MARKET_ATTESTATION_CONFIG"] = args.tls_config
    children, logs, qualifier, pg_started = [], [], None, False
    def spawn(name, argv, worker_env=None):
        log = open(root / (name + ".log"), "ab"); logs.append(log)
        child = subprocess.Popen(argv, env=worker_env, stdout=log, stderr=log); children.append(child)
        return child
    try:
        if args.initialize:
            run("initdb", "-D", str(root / "pg"), "-U", user, "-A", "trust", "--no-locale", "-E", "UTF8")
        run("pg_ctl", "-D", str(root / "pg"), "-l", str(root / "pg.log"), "-o",
            f"-h 127.0.0.1 -p {settings['pg_port']} -k /tmp", "-w", "start")
        pg_started = True
        if args.initialize: run("createdb", "-h", "127.0.0.1", "-p", str(settings["pg_port"]), "-U", user, settings["database"])
        redis_dir = root / "redis"; redis_dir.mkdir(mode=0o700, exist_ok=True)
        redis = spawn("redis", ["redis-server", "--bind", "127.0.0.1", "--port", str(settings["redis_port"]),
            "--dir", str(redis_dir), "--save", "", "--appendonly", "yes", "--appendfsync", "always", "--maxmemory-policy", "noeviction"])
        for _ in range(100):
            assert redis.poll() is None
            ping = subprocess.run(["redis-cli", "-p", str(settings["redis_port"]), "ping"], capture_output=True)
            if ping.returncode == 0 and ping.stdout.strip() == b"PONG": break
            time.sleep(0.1)
        else: raise RuntimeError("owned Redis readiness timed out")
        qualifier = Server(plan, ("127.0.0.1", settings["tokenizer_port"]))
        bridge = spawn("chutes-bridge", [sys.executable, str(Path(__file__).resolve().parents[1] / "chutes" / "gateway.py"),
            "--config", plan["gateway_config"], "--config-sha256", args.approved_config_sha256,
            "--port", str(settings["bridge_port"])])
        bridge_url = f"http://127.0.0.1:{settings['bridge_port']}"
        ready(bridge_url + "/healthz", bridge)
        if args.initialize or args.resume_calibration_attempt:
            request = {"model": PUBLIC_MODEL, "messages": [{"role": "user", "content": "Reply with exactly the word OK."}],
                "stream": True, "stream_options": {"include_usage": True}, "max_completion_tokens": plan["max_output_tokens"], "temperature": 0}
            tokens = qualifier.qualifier.tokenize(request)
            registration = {k: plan[k] for k in ("model_revision_ref", "tokenizer_ref", "tokenizer_files_sha256", "rates", "context_window_tokens")}
            registration.update(version=1, market_id=plan["market_id"], seller_principal="project-chutes-test-account",
                project_authorizes_on_demand_terms=True, project_pays_upstream_costs=True, origin=ORIGIN, model=PUBLIC_MODEL,
                native_model=NATIVE_MODEL, verified_bridge_url=bridge_url, token_ids=tokens,
                tokenizer_url=f"http://127.0.0.1:{settings['tokenizer_port']}/tokenize", max_output_tokens=plan["max_output_tokens"],
                request_sha256=sha(canonical(request)), offer_valid_until_ms=time.time_ns() // 1000000 + 1800000,
                upstream_budget_micro_usd=plan["upstream_budget_micro_usd"], maximum_upstream_calls=4)
            if args.initialize:
                save(root / "registration-input.json", registration)
                if args.buyer_public_keys:
                    keys = json.loads(Path(args.buyer_key_file).read_bytes())
                    assert len(keys) == 3
                    setup_env = dict(env, **{f"PRIVATE_MARKET_BUYER_TOKEN_{i}": key for i, key in enumerate(keys)})
                    run(args.binary, "init-live-deploy", str(state), str(root / "registration-input.json"), args.buyer_public_keys, env=setup_env)
                else:
                    run(args.binary, "init-live", str(state), str(root / "registration-input.json"), env=env)
            else:
                registration = json.loads((state / "registration.json").read_bytes())
                assert registration["request_sha256"] == sha(canonical(request)) and registration["token_ids"] == tokens
                assert run("psql", env["DATABASE_URL"], "-XAt", "-v", "ON_ERROR_STOP=1", "-c",
                    "SELECT count(*) FROM market_inference_requests").strip() == b"0", "never resume calibration after a buyer purchase"
            suffix = "." + args.resume_calibration_attempt if args.resume_calibration_attempt else ""
            save(root / ("calibration-intent" + suffix + ".json"), {"request_sha256": registration["request_sha256"],
                "kind": "explicit calibration only; original ledger and buyer identities retained"})
            started = time.time_ns() // 1000000
            native = dict(request, model=NATIVE_MODEL)
            req = urllib.request.Request(bridge_url + "/v1/chat/completions", data=canonical(native),
                headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
            ended = time.time_ns() // 1000000
            stream_file = root / ("calibration" + suffix + ".sse")
            save(stream_file, raw)
            frames = [json.loads(line[5:]) for line in raw.splitlines() if line.startswith(b"data:") and line[5:].strip() != b"[DONE]"]
            usage = next(f["usage"] for f in reversed(frames) if f.get("usage"))
            finish = [c["finish_reason"] for f in frames for c in f.get("choices", []) if c.get("finish_reason")]
            assert len(finish) == 1 and usage["prompt_tokens"] == len(tokens)
            measurement = dict(usage, registration_sha256=sha((state / "registration.json").read_bytes()),
                request_sha256=registration["request_sha256"], response_file=str(stream_file), response_sha256=sha(raw),
                started_at_ms=started, ended_at_ms=ended, response_model=NATIVE_MODEL, finish_reason=finish[0])
            # Registration consumes only native count fields, not provider extensions.
            measurement = {k: v for k, v in measurement.items() if k in ("prompt_tokens", "completion_tokens", "total_tokens",
                "registration_sha256", "request_sha256", "response_file", "response_sha256", "started_at_ms", "ended_at_ms", "response_model", "finish_reason")}
            measurement_file = root / ("measurement" + suffix + ".json")
            save(measurement_file, measurement)
            run(args.binary, "qualify-live", str(state), str(measurement_file), env=env)
        if args.buyer_key_file:
            keys = json.loads(Path(args.buyer_key_file).read_bytes())
            assert [b["token"] for b in json.loads((state / "state.json").read_bytes())["buyers"]] == keys, "original buyer credentials changed"
        if args.buyer_public_keys:
            public = json.loads(Path(args.buyer_public_keys).read_bytes())["public_keys"]
            assert [b["public_key"] for b in json.loads((state / "state.json").read_bytes())["buyers"]] == public, "buyer verifying keys changed"
            assert not (state / "signing").exists(), "deployment must not contain buyer signing secrets"
        host = spawn("host", [args.binary, "serve", str(state)], env)
        ready("http://" + args.listen + "/healthz", host)
        nginx = None
        if args.tls_config:
            nginx = spawn("nginx", ["nginx", "-c", args.nginx_config, "-g", "daemon off;"])
        print(json.dumps({"ready": True, "model": PUBLIC_MODEL, "base_url": "http://" + args.listen + "/market/v1",
            "verification_required": True, "finite_offers": 3}), flush=True)
        next_certificate_check = time.monotonic() + 3600
        while not STOP.wait(0.5):
            if any(child.poll() is not None for child in children): raise RuntimeError("owned worker exited")
            if args.tls_config and time.monotonic() >= next_certificate_check:
                certificate = Path("/run/market-tls/leaf.pem")
                old = certificate.read_bytes()
                prepare_tls(args.tls_config)
                if certificate.read_bytes() != old: nginx.send_signal(signal.SIGHUP)
                next_certificate_check = time.monotonic() + 3600
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try: child.wait(timeout=20)
                except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)
        if qualifier: qualifier.shutdown(); qualifier.server_close()
        if pg_started: run("pg_ctl", "-D", str(root / "pg"), "-m", "fast", "-w", "stop")
        for log in logs: log.close()


if __name__ == "__main__": main()
