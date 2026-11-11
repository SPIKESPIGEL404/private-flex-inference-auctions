#!/usr/bin/env python3
"""Migration regressions on actual host/PG/Redis/native wire boundaries."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import copy
import json
from pathlib import Path
import time
import subprocess
import urllib.request
from market_b_support import Market, http, wait_for
from market_b_support import a


def financial(m, key):
    def ready():
        r = m.receipt(key)
        return r if r and r.get("financial") is not None else None
    return wait_for(ready)


def no_mutations(m):
    wait_for(lambda: m.sql("SELECT count(*)=0 FROM redis_balance_mutations WHERE state<>'applied'") == "t")


def concurrency(binary, same_key=False, money=False):
    with ThreadPoolExecutor(max_workers=4) as pool, Market(binary) as m:
        m.seller.release.clear()
        m.start()
        body = m.body()
        if money:
            body["bitrouter_purchase"].update(provider_cap_micro_usd=20000, total_cap_micro_usd=20010)
        jobs = [pool.submit(m.post, "duplicate" if same_key else f"parallel-{i}", 0 if same_key or money else i, body) for i in range(3)]
        wait_for(lambda: len(m.seller.calls) == 1)
        if not same_key:
            wait_for(lambda: sum(j.done() for j in jobs) == 2)
            refused = [j.result()[0] for j in jobs if j.done()]
            assert all(status in (402, 503) for status in refused) if money else refused == [503, 503], refused
            if money:
                # A concurrent admission can fail closed while the reserve's
                # cache mutation is pending. Once confirmed, cash itself denies.
                no_mutations(m)
                assert m.post("cash-probe", body=body)[0] == 402
        assert m.effects() == 1 and m.seller.maximum == 1
        if not same_key and not money:
            second = subprocess.run([binary, "serve", str(m.state)], env=m.env, capture_output=True, timeout=10)
            assert second.returncode != 0 and b"writer is already active" in second.stderr
            assert http(m.url + "/healthz")[0] == 200
        if money:
            assert m.balance() == 25000 - 20002
        m.seller.release.set()
        results = [j.result() for j in jobs]
        assert sum(status == 200 for status, _ in results) == (3 if same_key else 1), results
        no_mutations(m)
        assert m.effects() == 1 and len(m.seller.calls) == 1 and m.seller.maximum == 1
        assert not m.seller.errors
        rows = int(m.sql("SELECT count(*) FROM market_inference_requests"))
        assert rows == (1 if same_key or money else 3), rows
        if same_key or money:
            assert m.balance() == 24963
        else:
            assert sorted(m.balance(i) for i in range(3)) == [24963, 25000, 25000]


def terminals(binary, mode, schema_text=None):
    with Market(binary) as m:
        m.seller.mode = mode
        if schema_text is not None:
            m.seller.schema_text = schema_text
        m.start()
        body = m.body()
        if mode == "schema":
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "result", "strict": True,
                "schema": {"type": "object", "properties": {"values": {"type": "array", "items": {"type": "integer", "enum": [1, 2]}}}, "required": ["values"], "additionalProperties": False}}}
        status, output = m.post("terminal", body=body)
        assert status == 200, (status, output)
        if mode in ("success", "cap"):
            frames = [json.loads(line[6:]) for line in output.splitlines() if line.startswith("data: {")]
            reason, generated = ("length", 64) if mode == "cap" else ("stop", 3)
            assert output.endswith("data: [DONE]\n\n")
            assert any(choice.get("finish_reason") == reason for frame in frames for choice in frame.get("choices", []))
            assert any(usage.get("prompt_tokens") == 2 and usage.get("completion_tokens") == generated
                       and usage.get("total_tokens") == generated + 2
                       for frame in frames if (usage := frame.get("usage")))
        if mode == "missing-usage":
            r = wait_for(lambda: m.receipt("terminal"))
            assert r["status"]["status"] == "delivered" and r["settlement"] == "pending_metering", r
            assert r["financial"] is None and m.balance() == 20498
        else:
            r = financial(m, "terminal")
            fees = r["financial"]
            paid = mode in ("success", "cap") or schema_text == '{"values":[1.0,2]}'
            assert fees["provider_micro_usd"] == (706 if mode == "cap" else 35 if paid else 0), r
            assert fees["platform_micro_usd"] == (2 if paid else 0), r
            assert fees["cash_micro_usd"] == fees["provider_micro_usd"] + fees["platform_micro_usd"], r
            assert m.balance() == 25000 - fees["cash_micro_usd"]
            if not paid:
                expected = {"early-cap": "invalid_delivery", "refusal": "refusal", "empty": "empty_delivery", "schema": "invalid_delivery"}[mode]
                assert r["status"]["reason"] == expected, r
            no_mutations(m)
            # Audit the original ledger, not only the final balance projection.
            assert int(m.sql("SELECT sum(amount_micro_usd) FROM credit_ledger_entries WHERE metadata->>'fee_kind'='inference_market'")) == -fees["cash_micro_usd"]
        assert m.effects() == 1 and len(m.seller.calls) == 1 and not m.seller.errors


def invalid_and_expired(binary):
    with Market(binary) as m:
        m.start()
        for field, value in [("model", "unregistered"), ("max_completion_tokens", 65), ("service_type", "reserved")]:
            body = m.body()
            (body["bitrouter_purchase"] if field == "service_type" else body)[field] = value
            assert m.post("invalid-" + field, body=body)[0] == 400
        assert m.balance() == 25000 and m.effects() == 0 and not m.seller.calls
    with Market(binary) as m:
        # Catalog evidence becomes ineligible without altering durable offers,
        # source hashes, ledger, or the writer's qualification rules.
        def expire(c):
            for x in c["products"][0]["candidates"]:
                x["candidate"]["input"]["load"]["valid_until"] = 1
        m.configure(expire)
        m.start()
        assert m.post("expired")[0] == 503
        no_mutations(m)
        assert m.balance() == 25000 and m.effects() == 0 and not m.seller.calls


def replacement(binary):
    with Market(binary) as m:
        def configure(c):
            c["strategy"]["max_attempts"] = 2
            for route in c["products"][0]["routes"]:
                route["capacity_rejections"] = True
        m.configure(configure)
        m.seller.mode = "replace"
        m.start()
        body = m.body()
        body["bitrouter_delivery"].update(auto_fallback="before_output", recovery="bitrouter.stream.v1")
        status, _ = m.post("replacement", body=body)
        assert status == 200
        r = financial(m, "replacement")
        assert r["financial"]["provider_micro_usd"] == 35 and r["financial"]["platform_micro_usd"] == 2, r
        assert m.effects() == len(m.seller.calls) == 2
        state = json.loads(m.sql("SELECT convert_from(state,'UTF8') FROM market_inference_requests WHERE idempotency_key='replacement'"))
        attempts = state["strategy"]["attempts"]
        assert len(attempts) == 2 and attempts[0]["fee_protection"]["reason"] == "capacity_rejected", attempts
        assert attempts[0]["fulfillment"] is not None and attempts[1]["terminal"] is not None
        no_mutations(m)
        assert m.balance() == 24963


def restart(binary, disconnect=False):
    with ThreadPoolExecutor(max_workers=1) as pool, Market(binary) as m:
        m.seller.release.clear()
        if disconnect:
            m.seller.mode = "disconnect"
        m.start()
        job = pool.submit(m.post, "unknown")
        wait_for(lambda: len(m.seller.calls) == 1)
        wait_for(lambda: int(m.sql("SELECT count(*) FROM market_inference_stream_events")) > 0)
        before = m.receipt("unknown")
        request_id = before["request_id"]
        frames = m.sql("SELECT jsonb_agg(jsonb_build_array(sequence,source_sha256,frame) ORDER BY sequence) FROM market_inference_stream_events")
        if disconnect:
            m.seller.release.set()
            wait_for(lambda: m.receipt("unknown")["status"]["status"] == "unknown")
        m.stop(crash=True)
        m.start()
        r = wait_for(lambda: (r if (r := m.receipt("unknown"))["status"]["status"] == "unknown" else None))
        assert r["request_id"] == request_id and r["financial"] is None
        assert m.balance() == 20498 and m.effects() == 1 and len(m.seller.calls) == 1
        assert m.sql("SELECT jsonb_agg(jsonb_build_array(sequence,source_sha256,frame) ORDER BY sequence) FROM market_inference_stream_events") == frames
        status_url = m.url + "/market/v1/requests/" + request_id
        status, owner = http(status_url, m.buyers[0]["token"])
        assert status == 200 and json.loads(owner)["status"]["status"] == "unknown"
        denied, error = http(status_url, m.buyers[1]["token"])
        assert denied == 404 and all(value not in error for value in [request_id, "fees", "proof", "word"])
        # Same identity survives duplicate recovery; no second seller submission.
        try:
            m.post("unknown")
        except (OSError, TimeoutError):
            pass
        assert m.effects() == 1 and len(m.seller.calls) == 1 and m.balance() == 20498
        m.seller.release.set()
        with __import__('contextlib').suppress(Exception):
            job.result(timeout=2)


def lost_commit(binary):
    with Market(binary, proxy=True) as m:
        m.start()
        m.proxy.armed.set()
        try:
            m.post("lost-commit")
        except (OSError, TimeoutError):
            pass
        assert m.proxy.fired.wait(5), "did not intercept actual financial COMMIT acknowledgment"
        r = financial(m, "lost-commit")
        assert r["financial"]["cash_micro_usd"] == 37
        ledger = m.sql("SELECT jsonb_agg(jsonb_build_array(id,amount_micro_usd) ORDER BY id) FROM credit_ledger_entries")
        m.stop(crash=True)
        m.start()
        assert m.post("lost-commit")[0] == 200
        assert m.receipt("lost-commit")["financial"] == r["financial"]
        assert m.sql("SELECT jsonb_agg(jsonb_build_array(id,amount_micro_usd) ORDER BY id) FROM credit_ledger_entries") == ledger
        assert m.balance() == 24963 and m.effects() == 1 and len(m.seller.calls) == 1
        no_mutations(m)


def offline_delivery(binary):
    with Market(binary) as m:
        m.seller.release.clear()
        m.start()
        request = urllib.request.Request(m.url + "/market/v1/chat/completions",
            data=json.dumps(m.body()).encode(), headers={"Content-Type": "application/json",
            "Authorization": "Bearer " + m.buyers[0]["token"], "Idempotency-Key": "offline"})
        with a.HTTP.open(request, timeout=10) as response:
            while True:
                line = response.readline()
                assert line, "buyer stream ended before the controlled output"
                if b"verified" in line:
                    break
        # Closing the buyer socket is not provider termination or a new request.
        assert m.receipt("offline")["financial"] is None and m.balance() == 20498
        m.seller.release.set()
        r = financial(m, "offline")
        url_path = "/market/v1/requests/" + r["request_id"] + "/events"
        status, output = http(m.url + url_path, m.buyers[0]["token"])
        assert status == 200 and "verified" in output and output.endswith("data: [DONE]\n\n")
        a.native_evidence(output)
        events = m.sql("SELECT jsonb_agg(jsonb_build_array(sequence,source_sha256,frame) ORDER BY sequence) FROM market_inference_stream_events")
        m.stop()
        m.start()
        assert http(m.url + url_path, m.buyers[0]["token"]) == (status, output)
        assert m.sql("SELECT jsonb_agg(jsonb_build_array(sequence,source_sha256,frame) ORDER BY sequence) FROM market_inference_stream_events") == events
        assert m.effects() == len(m.seller.calls) == 1 and m.balance() == 24963


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--source-evidence", type=Path)
    parser.add_argument("--case", help="Run one named scenario during development")
    args = parser.parse_args()
    binary = str(args.binary.resolve())
    cases = {"concurrent-funds": lambda: concurrency(binary, money=True),
             "concurrent-capacity": lambda: concurrency(binary),
             "concurrent-idempotency": lambda: concurrency(binary, same_key=True),
             "invalid-expired": lambda: invalid_and_expired(binary),
             **{f"terminal-{mode}": lambda mode=mode: terminals(binary, mode) for mode in ["success", "cap", "early-cap", "refusal", "empty", "schema", "missing-usage"]},
             "schema-instances": lambda: [terminals(binary, "schema", text) for text in [
                 '{"values":[1.0,2]}', '{"values":[3]}', '{"values":[1.5]}', '{"values":[1],"extra":true}',
                 '{"values":[1],"values":[2]}', '{}', '{"values":[1]']],
             "replacement": lambda: replacement(binary),
             "unknown-crash": lambda: restart(binary),
             "unknown-disconnect": lambda: restart(binary, True),
             "offline-delivery-restart": lambda: offline_delivery(binary),
             "lost-commit-ack": lambda: lost_commit(binary)}
    assert args.case is None or args.case in cases
    results = {}
    for name, case in cases.items():
        if args.case and name != args.case:
            continue
        case()
        results[name] = "pass"
        print(name + ": pass", flush=True)
    evidence = {"batch": "B", "result": "pass", "cloud_commit": "244177cafa26e8c8b001e61297cf4e7f89ac8de9", "controlled": True, "real_provider": False, "attested": False, "partial": args.case is not None, "cases": results}
    if args.source_evidence:
        evidence["source_tests"] = json.loads(args.source_evidence.read_text())
    if args.evidence:
        args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
