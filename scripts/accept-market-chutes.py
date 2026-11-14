#!/usr/bin/env python3
"""Controlled single-model Market wiring. Zero external inference/TEE claims."""
import json
import base64
import uuid
import urllib.request
import urllib.error
import http.server
from pathlib import Path
import subprocess
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy/chutes"))
from gateway import NativeStream

from market_b_support import Market, http as call_http, run, wait_for
from market_c import canonical, sha, save

PUBLIC, NATIVE = "qwen3.8-27b", "Qwen/Qwen3.8-27B-FP8"


def stream():
    def frame(choices, usage=None):
        return b"data: " + canonical({"id": "chatcmpl-controlled-chutes", "object": "chat.completion.chunk",
            "model": NATIVE, "choices": choices, "usage": usage}) + b"\n\n"
    native = NativeStream(64)
    raw = (frame([{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}],
            {"prompt_tokens": 2, "completion_tokens": 0, "total_tokens": 2})
        + frame([{"index": 0, "delta": {"content": "controlled result"}, "finish_reason": None}],
            {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5})
        + frame([{"index": 0, "delta": {}, "finish_reason": "stop"}],
            {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5})
        + frame([], {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}) + b"data: [DONE]\n\n")
    normalized = native.observe(raw)
    native.complete()
    return normalized + b"data: [DONE]\n\n"


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/tokenize":
            assert body["model"] == PUBLIC and body["tokenizer_ref"] == "controlled-chutes-tokenizer"
            raw, media = canonical({"tokenizer_ref": "controlled-chutes-tokenizer", "token_ids": [42, 43]}), "application/json"
        else:
            assert self.path == "/v1/chat/completions" and body["model"] == NATIVE
            assert self.headers["Authorization"] == "Bearer " + self.server.secret
            assert not any(h.lower().startswith("x-buyer-") for h in self.headers)
            self.server.calls.append(body)
            raw, media = stream(), "text/event-stream"
        self.send_response(200); self.send_header("Content-Type", media)
        self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)


binary = str(Path(sys.argv[1]).resolve())
with Market(binary, initialize=False) as m:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.secret, server.calls = m.env["PRIVATE_MARKET_SELLER_KEY"], []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        profile = {"version": 1, "market_id": "controlled-chutes", "seller_principal": "controlled-chutes-project",
            "project_authorizes_on_demand_terms": True, "project_pays_upstream_costs": True,
            "origin": "https://kelsen-qwen-qwen3-8-27b-fp8.chutes.ai", "model": PUBLIC, "native_model": NATIVE,
            "verified_bridge_url": base, "model_revision_ref": "controlled-qwen-revision", "tokenizer_url": base + "/tokenize",
            "tokenizer_ref": "controlled-chutes-tokenizer", "tokenizer_files_sha256": {
                "tokenizer.json": "a" * 64, "tokenizer_config.json": "b" * 64}, "token_ids": [42, 43],
            "max_output_tokens": 64, "context_window_tokens": 32768,
            "rates": {"input": 1000000, "cache_input": 1000000, "output": 11000000},
            "request_sha256": "c" * 64, "offer_valid_until_ms": time.time_ns() // 1000000 + 600000,
            "upstream_budget_micro_usd": 750000, "maximum_upstream_calls": 4}
        save(m.root / "profile.json", profile)
        for field, value in [("model", "a-different-model"), ("native_model", "native-other"),
                ("verified_bridge_url", "http://example.invalid:8091/"),
                ("origin", "https://example.invalid")]:
            invalid = dict(profile, **{field: value})
            path = m.root / ("invalid-" + field + ".json")
            save(path, invalid)
            assert subprocess.run([binary, "validate-live", str(path)], env=m.env, capture_output=True).returncode != 0
        offline = m.root / "offline-buyers"
        fixture = str(Path("scripts/chutes-buyer-fixture.mjs").resolve())
        run("node", fixture, "generate", str(offline))
        for i in range(3): m.env[f"PRIVATE_MARKET_BUYER_TOKEN_{i}"] = "brk_" + str(uuid.uuid4()) + "." + uuid.uuid4().hex + uuid.uuid4().hex
        run(binary, "init-live-deploy", str(m.state), str(m.root / "profile.json"), str(offline / "public.json"), env=m.env)
        assert not (m.state / "signing").exists(), "buyer signing secrets must stay outside the deployment"
        m.env["PRIVATE_MARKET_SIGNED_PURCHASES"] = "1"
        state = json.loads((m.state / "state.json").read_bytes())
        ended = time.time_ns() // 1000000
        save(m.root / "calibration.sse", stream())
        measurement = {"registration_sha256": state["registration_sha256"], "request_sha256": profile["request_sha256"],
            "response_file": str(m.root / "calibration.sse"), "response_sha256": sha(stream()),
            "started_at_ms": ended - 1, "ended_at_ms": ended, "response_model": NATIVE, "finish_reason": "stop",
            "prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}
        save(m.root / "measurement.json", measurement)
        run(binary, "qualify-live", str(m.state), str(m.root / "measurement.json"), env=m.env)
        m.env["PRIVATE_MARKET_PUBLIC_MODEL"] = PUBLIC
        m.start()
        models = json.loads(call_http(m.url + "/market/v1/models")[1])
        assert [item["id"] for item in models["data"]] == [PUBLIC]
        token = state["buyers"][0]["token"]
        keyset = "sha256:" + sha((m.state / "catalog.json").read_bytes())
        def signed(body, key):
            config = {"signing_key_file": str(offline / "buyer-0.key"), "wire_b64": base64.b64encode(canonical(body)).decode(),
                "idempotency_key": key, "keyset_digest": keyset}
            path = m.root / ("sign-" + uuid.uuid4().hex + ".json"); save(path, config)
            return json.loads(run("node", fixture, "sign", str(path)))
        def post(body, key, headers=None):
            headers = signed(body, key) if headers is None else headers
            req = urllib.request.Request(m.url + "/market/v1/chat/completions", data=canonical(body),
                headers=dict(headers, Authorization="Bearer " + token, **{"Content-Type": "application/json", "Idempotency-Key": key}))
            try: response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=30)
            except urllib.error.HTTPError as error: response = error
            with response: return response.status, response.read().decode()
        body = {"model": PUBLIC, "messages": [{"role": "user", "content": "controlled prompt"}], "stream": True, "background": True,
            "stream_options": {"include_usage": True}, "max_completion_tokens": 64,
            "bitrouter_purchase": {"service_type": "on_demand", "provider_cap_micro_usd": 10000, "total_cap_micro_usd": 20000},
            "bitrouter_delivery": {"auto_fallback": "off"}}
        assert call_http(m.url + "/market/v1/chat/completions", token, body, "unsigned-denied")[0] == 401
        headers = signed(body, "tamper-denied")
        assert post(dict(body, temperature=1), "tamper-denied", headers)[0] == 401
        for model in [NATIVE, "Qwen/Qwen3-VL-30B-A3B-Instruct", "unknown"]:
            assert post(dict(body, model=model), "rejected-" + sha(model.encode())[:10])[0] == 400
        assert server.calls == []
        captured = signed(body, "controlled-chutes-once")
        status, result = post(body, "controlled-chutes-once", captured)
        assert status == 200 and "controlled result" in result and "[DONE]" in result
        assert len(server.calls) == 1 and server.calls[0]["model"] == NATIVE
        assert all(frame["model"] == PUBLIC for frame in [json.loads(line[5:]) for line in result.splitlines()
            if line.startswith("data:") and line[5:].strip() != "[DONE]"])
        def settled():
            value = json.loads(m.sql("SELECT coalesce((SELECT receipt FROM market_inference_receipts WHERE receipt->'financial' IS NOT NULL ORDER BY revision DESC LIMIT 1),'null'::jsonb)"))
            return value if value and value.get("settlement") == "committed" else None
        receipt = wait_for(settled)
        assert receipt["settlement"] == "committed"
        assert post(body, "controlled-chutes-once", captured)[0] == 401
        replay = post(body, "controlled-chutes-once")
        assert replay == (status, result) and len(server.calls) == 1, {"initial": (status, result), "replay": replay, "calls": len(server.calls)}
        m.stop(); time.sleep(1.1); m.start()
        assert post(body, "controlled-chutes-once") == (status, result)
        assert post(body, "controlled-chutes-once", captured)[0] == 401
        assert len(server.calls) == 1
        print(json.dumps({"controlled_market_wiring": "pass", "public_models": [PUBLIC], "native_mapping": True,
            "settlement_replay_restart": "pass", "signed_purchase_and_offline_buyer_keys": "pass", "external_inference_calls": 0, "hardware_attestation": "not_tested"}))
    finally:
        server.shutdown(); server.server_close()
