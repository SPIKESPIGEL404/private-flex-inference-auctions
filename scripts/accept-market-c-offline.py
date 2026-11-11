#!/usr/bin/env python3
"""Live-registration safety/assembly checks only. Never calls an inference API."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import time
from market_b_support import Market, http
from market_c import canonical, sha, save

binary = str(Path(sys.argv[1]).resolve())
with Market(binary, initialize=False) as m:
    profile = {"version": 1, "market_id": "offline-live-registration", "seller_principal": "controlled-project",
        "project_authorizes_on_demand_terms": True, "project_pays_upstream_costs": True,
        "origin": "https://example.invalid", "model": "test/native-model", "model_revision_ref": "offline-model-revision",
        "tokenizer_url": "http://127.0.0.1:12345/tokenize", "tokenizer_ref": "offline-only",
        "tokenizer_files_sha256": {name: "a" * 64 for name in ["tokenizer.json", "tokenizer_config.json", "chat_template.jinja"]},
        "token_ids": [42, 43], "max_output_tokens": 64, "context_window_tokens": 8192,
        "rates": {"input": 1_000_000, "cache_input": 1_000_000, "output": 11_000_000},
        "request_sha256": "b" * 64, "offer_valid_until_ms": time.time_ns() // 1_000_000 + 600_000,
        "upstream_budget_micro_usd": 10000, "maximum_upstream_calls": 4}
    p = m.root / "profile.json"
    save(p, profile)
    def command(*args):
        return subprocess.run([binary, *map(str, args)], env=m.env, capture_output=True, timeout=20)
    assert command("validate-live", p).returncode == 0
    native = {"model": "test/model", "messages": [{"role": "user", "content": "public input"}], "stream": True, "max_completion_tokens": 64}
    save(m.root / "native.json", native)
    assert command("validate-native-chat", m.root / "native.json").returncode == 0
    native["chat_template_kwargs"] = {"enable_thinking": False}
    save(m.root / "unsupported-native.json", native)
    assert command("validate-native-chat", m.root / "unsupported-native.json").returncode != 0
    for name, value in [("origin", "http://example.invalid"), ("project_authorizes_on_demand_terms", False),
                        ("project_pays_upstream_costs", False), ("upstream_budget_micro_usd", 0),
                        ("maximum_upstream_calls", 5), ("offer_valid_until_ms", 1), ("token_ids", [])]:
        invalid = copy.deepcopy(profile)
        invalid[name] = value
        target = m.root / (name + ".json")
        save(target, invalid)
        assert command("validate-live", target).returncode != 0, name
    initialized = command("init-live", m.state, p)
    assert initialized.returncode == 0, initialized.stderr.decode()
    state = json.loads((m.state / "state.json").read_text())
    assert state["registration_sha256"] and state["catalog_sha256"] is None
    assert command("serve", m.state).returncode != 0
    frame = lambda choices, usage=None: "data: " + json.dumps({"id": "offline-chat", "object": "chat.completion.chunk", "model": profile["model"], "choices": choices, "usage": usage}) + "\n\n"
    raw = (frame([{"index": 0, "delta": {"content": "controlled only"}, "finish_reason": None}])
        + frame([{"index": 0, "delta": {}, "finish_reason": "stop"}])
        + frame([], {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}) + "data: [DONE]\n\n").encode()
    response = m.root / "controlled.sse"
    save(response, raw)
    ended = time.time_ns() // 1_000_000
    measurement = {"registration_sha256": state["registration_sha256"], "request_sha256": profile["request_sha256"],
        "response_file": str(response), "response_sha256": sha(raw), "started_at_ms": ended - 1, "ended_at_ms": ended,
        "response_model": profile["model"], "finish_reason": "stop", "prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}
    contradictory = dict(measurement, completion_tokens=4, total_tokens=6)
    save(m.root / "contradictory.json", contradictory)
    assert command("qualify-live", m.state, m.root / "contradictory.json").returncode != 0
    assert not (m.state / "catalog.json").exists()
    save(m.root / "measurement.json", measurement)
    qualified = command("qualify-live", m.state, m.root / "measurement.json")
    assert qualified.returncode == 0, qualified.stderr.decode()
    state = json.loads((m.state / "state.json").read_text())
    assert state["catalog_sha256"] == sha((m.state / "catalog.json").read_bytes())
    m.start()
    assert json.loads(http(m.url + "/healthz")[1])["mode"] == "live-provider"
    assert http(m.url + "/market/v1/chat/completions", body={})[0] == 401
    m.stop()
    catalog = json.loads((m.state / "catalog.json").read_text())
    catalog["products"][0]["routes"][0]["native_model"] = "drifted-model"
    (m.state / "catalog.json").write_text(json.dumps(catalog))
    assert command("serve", m.state).returncode != 0
print(json.dumps({"offline_registration_checks": "pass", "real_provider": False, "inference_calls": 0}))
