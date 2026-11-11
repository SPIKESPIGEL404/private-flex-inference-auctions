#!/usr/bin/env python3
"""NEAR native Chat qualification and bounded batch C acceptance.

prepare is read-only on NEAR; execute requires an explicit approved budget.
The provided credential stays in a private file, never in captured evidence.
"""
import argparse
import hashlib
import http.server
import importlib
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from decimal import Decimal

a = importlib.import_module("accept-market-a")
ORIGIN = "https://cloud-api.near.ai"
MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct"
MAX_OUTPUT = 128
MAX_CALLS = 4


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def ceil_charge(numerator):
    return (numerator + 999_999) // 1_000_000


def save(path, data):
    raw = data if isinstance(data, bytes) else json.dumps(data, indent=2).encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())


def native(path, key, body=None):
    request = urllib.request.Request(ORIGIN + path, data=None if body is None else canonical(body),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    return HTTP.open(request, timeout=60)


def model_metadata(key):
    with native("/v1/models", key) as response:
        catalog = json.load(response)
    model = next(m for m in catalog["data"] if m["id"] == MODEL)
    assert model["is_ready"] and model["owned_by"] == "nearai"
    return catalog, model


def rates(model):
    pricing = model["pricing"]
    values = {"input": Decimal(pricing["prompt"]) * 10**12,
              "cache_input": Decimal(pricing.get("input_cache_read", pricing["prompt"])) * 10**12,
              "output": Decimal(pricing["completion"]) * 10**12}
    assert all(v == v.to_integral_value() and v >= 0 for v in values.values())
    assert Decimal(pricing.get("request", "0")) == 0
    return {k: int(v) for k, v in values.items()}


def tokenizer(plan):
    from transformers import PreTrainedTokenizerFast
    files = {name: Path(path) for name, path in plan["tokenizer_files"].items()}
    assert all(sha(p.read_bytes()) == plan["tokenizer_files_sha256"][n] for n, p in files.items())
    config = json.loads(files["tokenizer_config.json"].read_text())
    template = config.get("chat_template")
    if template is None:
        template = files["chat_template.jinja"].read_text() if "chat_template.jinja" in files else json.loads(files["chat_template.json"].read_text())["chat_template"]
    return PreTrainedTokenizerFast(tokenizer_file=str(files["tokenizer.json"]), chat_template=template,
        **{k: config[k] for k in ("bos_token", "eos_token", "pad_token") if k in config})


def tokenize(t, request):
    assert request["model"] == MODEL and request["max_completion_tokens"] == MAX_OUTPUT
    assert set(request) <= {"model", "messages", "max_completion_tokens", "stream", "stream_options", "temperature"}
    assert all(set(m) == {"role", "content"} and isinstance(m["content"], str) for m in request["messages"])
    return t.apply_chat_template(request["messages"], tokenize=True, add_generation_prompt=True)


def prepare(root, key_file):
    from huggingface_hub import HfApi, hf_hub_download
    root.mkdir(mode=0o700)
    key = key_file.read_text().strip()
    catalog, model = model_metadata(key)
    hf_model = model["hugging_face_id"]
    info = HfApi().model_info(hf_model)
    revision = info.sha
    paths = {name: hf_hub_download(hf_model, name, revision=revision) for name in ("tokenizer.json", "tokenizer_config.json")}
    if not json.loads(Path(paths["tokenizer_config.json"]).read_text()).get("chat_template"):
        names = {item.rfilename for item in info.siblings}
        template_name = "chat_template.jinja" if "chat_template.jinja" in names else "chat_template.json"
        paths[template_name] = hf_hub_download(hf_model, template_name, revision=revision)
    hashes = {name: sha(Path(path).read_bytes()) for name, path in paths.items()}
    body = {"model": MODEL, "messages": [{"role": "user", "content":
        "This is a public synthetic hackathon test. Write two short sentences describing an inference marketplace matching a buyer to an available model provider. Answer directly without reasoning."}],
        "stream": True, "stream_options": {"include_usage": True}, "max_completion_tokens": MAX_OUTPUT,
        "temperature": 0}
    plan = {"version": 1, "provider": "NEAR AI Cloud", "origin": ORIGIN, "model": MODEL,
            "model_revision_ref": f"{hf_model}@{revision}", "tokenizer_files": paths,
            "tokenizer_files_sha256": hashes, "tokenizer_ref": f"hf/{revision}/native-default-v1",
            "key_file": str(key_file.resolve()), "request_sha256": sha(canonical(body)),
            "maximum_upstream_calls": MAX_CALLS, "max_output_tokens": MAX_OUTPUT, "rates": rates(model),
            "context_window_tokens": model["context_length"], "created_at_ms": time.time_ns() // 1_000_000}
    t = tokenizer(plan)
    ids = tokenize(t, body)
    assert 0 < len(ids) <= 8192 and all(isinstance(v, int) and v >= 0 for v in ids)
    plan["token_ids"] = ids
    plan["maximum_estimated_cost_micro_usd"] = MAX_CALLS * ceil_charge(len(ids) * max(plan["rates"]["input"], plan["rates"]["cache_input"]) + MAX_OUTPUT * plan["rates"]["output"])
    save(root / "catalog-snapshot.json", catalog)
    save(root / "native-request.json", canonical(body))
    save(root / "plan.json", plan)
    print(json.dumps({"prepared": True, "provider": plan["provider"], "model": MODEL,
        "input_tokens": len(ids), "maximum_upstream_calls": MAX_CALLS, "max_output_tokens_per_call": MAX_OUTPUT,
        "maximum_estimated_cost_usd": str(Decimal(plan["maximum_estimated_cost_micro_usd"]) / 10**6),
        "inference_calls_made": 0, "plan_sha256": sha((root / "plan.json").read_bytes())}, indent=2))


def stream_summary(raw, expected_model=MODEL):
    frames, done = [], False
    for line in raw.decode().splitlines():
        if not line.startswith("data:"):
            continue
        assert not done, "data follows native terminator"
        data = line[5:].strip()
        if data == "[DONE]":
            done = True
        else:
            frames.append(json.loads(data))
    assert done
    return frames_summary(frames, expected_model)


def frames_summary(frames, expected_model=MODEL):
    assert frames and all(f["model"] == expected_model and f["object"] == "chat.completion.chunk" for f in frames)
    usage = next(f["usage"] for f in reversed(frames) if f.get("usage"))
    reasons = [c["finish_reason"] for f in frames for c in f.get("choices", []) if c.get("finish_reason")]
    text = "".join(c.get("delta", {}).get("content", "") or "" for f in frames for c in f.get("choices", []))
    assert text.strip() and len(reasons) == 1 and reasons[0] in ("stop", "length")
    assert usage["prompt_tokens"] + usage["completion_tokens"] == usage["total_tokens"]
    assert 0 < usage["completion_tokens"] <= MAX_OUTPUT
    assert reasons[0] != "length" or usage["completion_tokens"] == MAX_OUTPUT
    ids = {f["id"] for f in frames}
    assert len(ids) == 1
    return {"response_id": ids.pop(), "response_model": expected_model, "finish_reason": reasons[0],
            "usage": usage, "text_sha256": sha(text.encode()), "visible_characters": len(text)}


class TokenizerServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, plan, request):
        self.tokenizer = tokenizer(plan)
        self.plan, self.request = plan, request
        super().__init__(("127.0.0.1", 0), TokenizerHandler)
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()


class TokenizerHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        try:
            size = int(self.headers["Content-Length"])
            assert 0 < size <= 128 * 1024 and self.path == "/tokenize"
            body = json.loads(self.rfile.read(size))
            assert body["tokenizer_ref"] == self.server.plan["tokenizer_ref"] and body["model"] == MODEL and body["protocol"] == "chat_completions"
            assert body["request"] == self.server.request
            ids = tokenize(self.server.tokenizer, body["request"])
            assert ids == self.server.plan["token_ids"]
            raw = canonical({"tokenizer_ref": self.server.plan["tokenizer_ref"], "token_ids": ids})
            self.send_response(200)
        except (AssertionError, ValueError, KeyError):
            self.send_response(400)
            raw = b'{}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def execute(root, binary, budget, approved_sha):
    assert os.access(binary, os.X_OK) and Path(binary).stat().st_size > 1024 * 1024, "build a complete executable before approving a live run"
    plan_bytes = (root / "plan.json").read_bytes()
    assert sha(plan_bytes) == approved_sha, "approval does not name this prepared plan"
    plan = json.loads(plan_bytes)
    assert plan["maximum_estimated_cost_micro_usd"] <= budget <= 1_000_000
    assert time.time_ns() // 1_000_000 - plan["created_at_ms"] < 3_600_000
    key = Path(plan["key_file"]).read_text().strip()
    _, current = model_metadata(key)
    assert rates(current) == plan["rates"] and current["hugging_face_id"] in plan["model_revision_ref"]
    request = json.loads((root / "native-request.json").read_text())
    assert sha(canonical(request)) == plan["request_sha256"] and tokenize(tokenizer(plan), request) == plan["token_ids"]
    a.run(binary, "validate-native-chat", str(root / "native-request.json"))
    save(root / "execution-approval.json", {"approved_plan_sha256": approved_sha, "budget_micro_usd": budget,
        "maximum_upstream_calls": MAX_CALLS, "project_authorizes_on_demand_terms": True, "project_pays_upstream_costs": True})
    # An existing approval file prevents blind resume after any uncertain POST.
    pg, state = root / "pg", root / "state"
    pg_port, redis_port = a.free_port(), a.free_port()
    user = os.environ.get("USER", "market")
    name = "private_market_" + uuid.uuid4().hex
    env = {k: v for k, v in os.environ.items() if not k.startswith(("RAILWAY_", "BITROUTER_", "DATABASE_", "REDIS_", "PRIVATE_MARKET_", "INFERENCE_MARKET_"))}
    env.update(DATABASE_URL=f"postgres://{user}@127.0.0.1:{pg_port}/{name}", REDIS_URL=f"redis://127.0.0.1:{redis_port}",
        BITROUTER_PREVIEW_BOOTSTRAP_BINDING=name, REDIS_BALANCE_CUTOVER_TOKEN=uuid.uuid4().hex,
        PRIVATE_MARKET_SELLER_KEY=key, DATABASE_MIN_CONNECTIONS="1", DATABASE_MAX_CONNECTIONS="12", INFERENCE_MARKET_CONFIG_PATH=str(state / "catalog.json"))
    host = redis = qualifier = None
    pg_started = False
    log = open(root / "host.log", "x", opener=lambda p, flags: os.open(p, flags, 0o600))
    try:
        a.run("initdb", "-D", str(pg), "-U", user, "-A", "trust", "--no-locale", "-E", "UTF8")
        a.run("pg_ctl", "-D", str(pg), "-l", str(root / "pg.log"), "-o", f"-h 127.0.0.1 -p {pg_port} -k {root}", "-w", "start")
        pg_started = True
        a.run("createdb", "-h", "127.0.0.1", "-p", str(pg_port), "-U", user, name)
        redis = subprocess.Popen(["redis-server", "--bind", "127.0.0.1", "--port", str(redis_port), "--save", "", "--appendonly", "no", "--maxmemory-policy", "noeviction"], stdout=subprocess.DEVNULL)
        a.wait_for(lambda: subprocess.run(["redis-cli", "-p", str(redis_port), "ping"], capture_output=True).stdout.strip() == b"PONG")
        qualifier = TokenizerServer(plan, request)
        registration = {k: plan[k] for k in ("model_revision_ref", "tokenizer_ref", "tokenizer_files_sha256", "token_ids", "context_window_tokens", "rates", "request_sha256")}
        registration.update(version=1, market_id=name, seller_principal="project-near-test-account", project_authorizes_on_demand_terms=True,
            project_pays_upstream_costs=True, origin=ORIGIN, model=MODEL, tokenizer_url=f"http://127.0.0.1:{qualifier.server_address[1]}/tokenize",
            max_output_tokens=MAX_OUTPUT, offer_valid_until_ms=time.time_ns() // 1_000_000 + 1_800_000,
            upstream_budget_micro_usd=budget, maximum_upstream_calls=MAX_CALLS)
        save(root / "registration-input.json", registration)
        a.run(binary, "init-live", str(state), str(root / "registration-input.json"), env=env)
        save(root / "calibration-intent.json", {"request_sha256": plan["request_sha256"], "upstream_call": 1})
        started = time.time_ns() // 1_000_000
        with native("/v1/chat/completions", key, request) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            assert len(raw) <= 2 * 1024 * 1024
            headers = {k: response.headers[k] for k in ("inference-id", "x-request-id") if response.headers.get(k)}
        ended = time.time_ns() // 1_000_000
        save(root / "calibration.sse", raw)
        summary = stream_summary(raw)
        assert summary["usage"]["prompt_tokens"] == len(plan["token_ids"]), "native prompt count differs from pinned local tokenizer"
        measurement = {k: summary[k] for k in ("response_model", "finish_reason")}
        measurement.update({k: summary["usage"][k] for k in ("prompt_tokens", "completion_tokens", "total_tokens")})
        measurement.update(registration_sha256=sha((state / "registration.json").read_bytes()), request_sha256=plan["request_sha256"],
            response_file=str((root / "calibration.sse").resolve()), response_sha256=sha(raw), started_at_ms=started, ended_at_ms=ended)
        save(root / "calibration-summary.json", summary)
        save(root / "calibration-headers.json", headers)
        save(root / "measurement.json", measurement)
        a.run(binary, "qualify-live", str(state), str(root / "measurement.json"), env=env)
        host = subprocess.Popen([binary, "serve", str(state)], env=env, stdout=log, stderr=log)
        def ready():
            assert host.poll() is None, "live host exited before readiness"
            lines = (root / "host.log").read_text().splitlines()
            return next((json.loads(l)["url"] for l in lines if l.startswith('{') and '"url"' in l), None)
        url = a.wait_for(ready, 30)
        buyers = json.loads((state / "state.json").read_text())["buyers"]
        def sql(query):
            return a.run("psql", env["DATABASE_URL"], "-XAt", "-v", "ON_ERROR_STOP=1", "-c", query).strip()
        receipts, raw_records = [], []
        invoice_ids = [headers.get("inference-id") or str(uuid.uuid5(uuid.NAMESPACE_DNS, summary["response_id"]))]
        cap = ceil_charge(len(plan["token_ids"]) * max(plan["rates"]["input"], plan["rates"]["cache_input"]) + MAX_OUTPUT * plan["rates"]["output"])
        for i, buyer in enumerate(buyers):
            _, current = model_metadata(key)
            assert rates(current) == plan["rates"], "provider pricing changed before procurement"
            body = dict(request, background=True, bitrouter_purchase={"service_type": "on_demand", "provider_cap_micro_usd": cap + i,
                "total_cap_micro_usd": cap + i + 100}, bitrouter_delivery={"auto_fallback": "off"})
            save(root / f"buyer-{i}-intent.json", {"upstream_call_bound": i + 2, "idempotency_key": f"live-{i}"})
            status, output = a.http(url + "/market/v1/chat/completions", buyer["token"], body, f"live-{i}")
            save(root / f"buyer-{i}.sse", output.encode())
            assert status == 200, "native market request failed; preserve original run, do not retry"
            def final():
                value = json.loads(sql(f"SELECT coalesce((SELECT r.receipt FROM market_inference_requests s JOIN market_inference_receipts r USING(request_id,revision) WHERE s.idempotency_key='live-{i}' AND r.receipt->'financial' IS NOT NULL),'null'::jsonb)"))
                return value
            receipt = a.wait_for(final, 10)
            request_id = receipt["request_id"]
            frames = json.loads(sql(f"SELECT jsonb_agg(frame ORDER BY sequence) FROM market_inference_stream_events WHERE request_id='{request_id}'"))
            # Public replay IDs are rewritten by Cloud. The source result blob
            # retains the original provider IDs/model/finish/usage before rewrite.
            strategy = json.loads(sql(f"SELECT convert_from(state,'UTF8') FROM market_inference_requests WHERE request_id='{request_id}'"))["strategy"]
            result_digest = strategy["delivery"]["evidence"]["result_digest"]
            original = bytes.fromhex(sql(f"SELECT encode(body,'hex') FROM market_inference_evidence WHERE request_id='{request_id}' AND sha256='{result_digest}'"))
            assert sha(original) == result_digest
            original_frames = [json.loads(line) for line in original.splitlines()]
            original_summary = frames_summary(original_frames)
            assert original_summary["usage"]["prompt_tokens"] == len(plan["token_ids"])
            assert stream_summary(output.encode())["usage"] == original_summary["usage"]
            invoice_ids.append(str(uuid.uuid5(uuid.NAMESPACE_DNS, original_summary["response_id"])))
            save(root / f"buyer-{i}-native-frames.json", original_frames)
            save(root / f"buyer-{i}-original-result.jsonl", original)
            raw_records.append({"buyer": i, "receipt": receipt, "frames": original_frames, "result_digest": result_digest})
            usage = original_summary["usage"]
            cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
            actual = ceil_charge((usage["prompt_tokens"] - cached) * plan["rates"]["input"] + cached * plan["rates"]["cache_input"] + usage["completion_tokens"] * plan["rates"]["output"])
            fees = receipt["financial"]
            assert fees["provider_micro_usd"] == actual and fees["cash_micro_usd"] == actual + fees["platform_micro_usd"]
            assert receipt["status"]["status"] == "delivered" and receipt["settlement"] == "committed"
            balance = int(sql(f"SELECT balance_micro_usd FROM credit_accounts WHERE user_id='{buyer['user']}'"))
            assert balance == 25000 - fees["cash_micro_usd"]
            path = url + "/market/v1/requests/" + request_id
            assert a.http(path, buyers[(i+1) % 3]["token"])[0] == 404
            assert a.http(path + "/events", buyer["token"]) == (200, output)
            receipts.append({"buyer": i, "usage": usage, "finish_reason": original_summary["finish_reason"], "fees": fees,
                "balance_micro_usd": balance, "native_result_sha256": result_digest})
        assert int(sql("SELECT count(*) FROM market_inference_outbox WHERE kind='submit'")) == 3
        a.wait_for(lambda: sql("SELECT count(*)=0 FROM redis_balance_mutations WHERE state<>'applied'") == "t")
        save(root / "private-market-records.json", raw_records)
        costs = None
        for _ in range(10):
            with native("/v1/billing/costs", key, {"requestIds": invoice_ids}) as response:
                costs = json.load(response)
            indexed = {item["requestId"]: item["costNanoUsd"] for item in costs["requests"]}
            if all(isinstance(indexed.get(i), int) and indexed[i] >= 0 for i in invoice_ids):
                break
            time.sleep(1)
        assert all(isinstance(indexed.get(i), int) and indexed[i] >= 0 for i in invoice_ids), "upstream billing has not confirmed each original inference"
        assert sum(indexed[i] for i in invoice_ids) <= budget * 1000
        save(root / "near-billing-costs.json", costs)
        evidence = {"batch": "C", "result": "pass", "provider": "NEAR AI Cloud", "model": MODEL,
            "tokenizer_revision_ref": plan["model_revision_ref"], "tokenizer_files_sha256": plan["tokenizer_files_sha256"],
            "real_provider": True, "attested_market": False, "upstream_calls": 4, "submit_effects": 3,
            "approved_budget_micro_usd": budget, "maximum_estimated_upstream_cost_micro_usd": plan["maximum_estimated_cost_micro_usd"],
            "upstream_invoice_verified": True, "upstream_total_nano_usd": sum(indexed[i] for i in invoice_ids),
            "upstream_request_costs_nano_usd": [indexed[i] for i in invoice_ids],
            "calibration": {"usage": summary["usage"], "sse_sha256": sha(raw), "elapsed_ms": ended-started}, "buyers": receipts}
        save(root / "evidence.json", evidence)
        print(json.dumps(evidence, indent=2))
    finally:
        if host and host.poll() is None:
            host.send_signal(signal.SIGINT)
            try: host.wait(timeout=15)
            except subprocess.TimeoutExpired:
                host.kill()
                host.wait()
        if qualifier:
            qualifier.shutdown()
            qualifier.server_close()
        if redis:
            redis.terminate()
            redis.wait(timeout=5)
        if pg_started:
            a.run("pg_ctl", "-D", str(pg), "-m", "fast", "-w", "stop")
        log.close()


def main():
    os.umask(0o077)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["prepare", "execute"])
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--key-file", type=Path)
    parser.add_argument("--binary", type=Path, default=Path("crates/private-market-host/target/debug/private-market-host"))
    parser.add_argument("--budget-micro-usd", type=int)
    parser.add_argument("--approve-plan-sha256")
    args = parser.parse_args()
    if args.operation == "prepare":
        assert args.key_file is not None
        prepare(args.run_dir, args.key_file)
    else:
        assert args.budget_micro_usd is not None and args.approve_plan_sha256
        execute(args.run_dir, str(args.binary.resolve()), args.budget_micro_usd, args.approve_plan_sha256)


if __name__ == "__main__":
    main()
