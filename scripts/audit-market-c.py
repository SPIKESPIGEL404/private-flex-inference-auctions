#!/usr/bin/env python3
"""Audit original C captures and stopped owned PostgreSQL, without inference."""
import argparse
import json
from pathlib import Path
import subprocess
import uuid
from urllib.parse import urlsplit, urlunsplit
from market_c import canonical, sha, frames_summary, stream_summary, ceil_charge, tokenizer, tokenize
from market_b_support import a


def audit(root, verify_database=False, prior_calibration=None):
    plan = json.loads((root / "plan.json").read_text())
    approval = json.loads((root / "execution-approval.json").read_text())
    state = json.loads((root / "state/state.json").read_text())
    registration_bytes = (root / "state/registration.json").read_bytes()
    registration = json.loads(registration_bytes)
    measurement = json.loads((root / "measurement.json").read_text())
    evidence = json.loads((root / "evidence.json").read_text())
    records = json.loads((root / "private-market-records.json").read_text())
    assert approval["approved_plan_sha256"] == sha((root / "plan.json").read_bytes())
    assert state["registration_sha256"] == sha(registration_bytes) == measurement["registration_sha256"]
    assert state["catalog_sha256"] == sha((root / "state/catalog.json").read_bytes())
    request = json.loads((root / "native-request.json").read_text())
    assert sha(canonical(request)) == registration["request_sha256"] == plan["request_sha256"]
    assert tokenize(tokenizer(plan), request) == registration["token_ids"] == plan["token_ids"]
    raw = (root / "calibration.sse").read_bytes()
    calibration = stream_summary(raw)
    assert sha(raw) == measurement["response_sha256"] == evidence["calibration"]["sse_sha256"]
    assert calibration["usage"] == evidence["calibration"]["usage"]
    assert calibration["usage"]["prompt_tokens"] == len(plan["token_ids"])
    assert calibration == json.loads((root / "calibration-summary.json").read_text())
    headers = json.loads((root / "calibration-headers.json").read_text())
    invoice_ids = [headers.get("inference-id") or str(uuid.uuid5(uuid.NAMESPACE_DNS, calibration["response_id"]))]
    assert len(records) == len(evidence["buyers"]) == 3
    for i, record in enumerate(records):
        assert record["buyer"] == i
        original = (root / f"buyer-{i}-original-result.jsonl").read_bytes()
        assert sha(original) == record["result_digest"] == evidence["buyers"][i]["native_result_sha256"]
        frames = [json.loads(line) for line in original.splitlines()]
        assert frames == record["frames"] == json.loads((root / f"buyer-{i}-native-frames.json").read_text())
        summary = frames_summary(frames)
        delivered = stream_summary((root / f"buyer-{i}.sse").read_bytes())
        assert summary["usage"] == delivered["usage"] == evidence["buyers"][i]["usage"]
        assert summary["text_sha256"] == delivered["text_sha256"]
        assert summary["finish_reason"] == delivered["finish_reason"] == evidence["buyers"][i]["finish_reason"]
        assert summary["usage"]["prompt_tokens"] == len(plan["token_ids"])
        invoice_ids.append(str(uuid.uuid5(uuid.NAMESPACE_DNS, summary["response_id"])))
        usage, rates = summary["usage"], plan["rates"]
        cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
        charge = ceil_charge((usage["prompt_tokens"] - cached) * rates["input"] + cached * rates["cache_input"] + usage["completion_tokens"] * rates["output"])
        receipt = record["receipt"]
        assert receipt["status"]["status"] == "delivered" and receipt["settlement"] == "committed"
        assert receipt["financial"] == evidence["buyers"][i]["fees"]
        assert receipt["financial"]["provider_micro_usd"] == charge
        assert evidence["buyers"][i]["balance_micro_usd"] == 25000 - receipt["financial"]["cash_micro_usd"]
    billed = {x["requestId"]: x["costNanoUsd"] for x in json.loads((root / "near-billing-costs.json").read_text())["requests"]}
    assert len(set(invoice_ids)) == 4 and all(isinstance(billed.get(i), int) for i in invoice_ids)
    assert [billed[i] for i in invoice_ids] == evidence["upstream_request_costs_nano_usd"]
    assert sum(billed[i] for i in invoice_ids) == evidence["upstream_total_nano_usd"] <= approval["budget_micro_usd"] * 1000
    assert evidence["upstream_calls"] == 4 and evidence["submit_effects"] == 3
    catalog = json.loads((root / "state/catalog.json").read_text())
    assert len(catalog["products"][0]["candidates"]) == 3
    for candidate in catalog["products"][0]["candidates"]:
        observed = candidate["candidate"]["input"]["throughput_observation"]
        assert observed["started_at"] == measurement["started_at_ms"] >= observed["offering"]["observed_at"]
        assert observed["ended_at"] == measurement["ended_at_ms"]
        assert observed["completed_requests"] == 1 and observed["failed_requests"] == 0
        assert observed["billable_output_tokens"] == calibration["usage"]["completion_tokens"]
    if verify_database:
        verify_pg(root, state, records)
    result = {"audit": "pass", "real_provider_captures": True, "database_verified": verify_database,
            "inference_calls_made_by_auditor": 0, "upstream_total_nano_usd": evidence["upstream_total_nano_usd"],
            "buyers": 3, "model": evidence["model"]}
    if prior_calibration:
        previous = audit_prior_calibration(prior_calibration)
        total = previous["cost_nano_usd"] + evidence["upstream_total_nano_usd"]
        budget = previous["approved_budget_micro_usd"]
        # A new plan receives only the remaining allocation; it is not another
        # full task allowance. Round the already spent amount upward in microUSD.
        assert approval["budget_micro_usd"] <= budget - (previous["cost_nano_usd"] + 999) // 1000
        assert total <= budget * 1000
        result.update(prior_calibration=previous, task_upstream_calls=5,
                      task_total_nano_usd=total, task_approved_budget_micro_usd=budget)
    return result


def audit_prior_calibration(root):
    plan_bytes = (root / "plan.json").read_bytes()
    plan = json.loads(plan_bytes)
    approval = json.loads((root / "execution-approval.json").read_text())
    assert approval["approved_plan_sha256"] == sha(plan_bytes)
    measurement = json.loads((root / "measurement.json").read_text())
    raw = (root / "calibration.sse").read_bytes()
    summary = stream_summary(raw, plan["model"])
    assert sha(raw) == measurement["response_sha256"]
    assert summary == json.loads((root / "calibration-summary.json").read_text())
    assert all(summary["usage"][k] == measurement[k] for k in ("prompt_tokens", "completion_tokens", "total_tokens"))
    headers = json.loads((root / "calibration-headers.json").read_text())
    billing_id = headers.get("inference-id") or str(uuid.uuid5(uuid.NAMESPACE_DNS, summary["response_id"]))
    invoices = json.loads((root / "near-billing-costs.json").read_text())["requests"]
    assert len(invoices) == 1 and invoices[0]["requestId"] == billing_id
    cost = invoices[0]["costNanoUsd"]
    assert isinstance(cost, int) and 0 <= cost <= approval["budget_micro_usd"] * 1000
    rejected = json.loads((root / "buyer-0.sse").read_text())
    assert rejected["error"]["code"] == "invalid_market_inference"
    assert not (root / "buyer-1-intent.json").exists()
    return {"model": plan["model"], "upstream_calls": 1, "cost_nano_usd": cost,
            "approved_budget_micro_usd": approval["budget_micro_usd"], "sse_sha256": sha(raw)}


def verify_pg(root, state, records):
    pg = root / "pg"
    assert pg.is_dir() and not (pg / "postmaster.pid").exists(), "audit requires the owned cleanly stopped database"
    port = a.free_port()
    url = urlsplit(state["database"])
    assert url.hostname == "127.0.0.1" and url.path.startswith("/private_market_") and url.password is None
    endpoint = urlunsplit((url.scheme, f"{url.username}@127.0.0.1:{port}", url.path, "", ""))
    a.run("pg_ctl", "-D", str(pg), "-l", str(root / "audit-postgres.log"), "-o", f"-h 127.0.0.1 -p {port} -k {root}", "-w", "start")
    try:
        def sql(query):
            return a.run("psql", endpoint, "-XAt", "-v", "ON_ERROR_STOP=1", "-c", "BEGIN READ ONLY; " + query + "; COMMIT").strip().removeprefix("BEGIN\n").removesuffix("\nCOMMIT")
        assert int(sql("SELECT count(*) FROM market_inference_requests")) == 3
        assert int(sql("SELECT count(*) FROM market_inference_outbox WHERE kind='submit'")) == 3
        assert sql("SELECT count(*)=0 FROM redis_balance_mutations WHERE state<>'applied'") == "t"
        for record in records:
            id = record["receipt"]["request_id"]
            saved = json.loads(sql(f"SELECT convert_from(state,'UTF8') FROM market_inference_requests WHERE request_id='{id}'"))
            assert saved["strategy"]["delivery"]["evidence"]["result_digest"] == record["result_digest"]
            body = bytes.fromhex(sql(f"SELECT encode(body,'hex') FROM market_inference_evidence WHERE request_id='{id}' AND sha256='{record['result_digest']}'"))
            assert sha(body) == record["result_digest"]
            actual = json.loads(sql(f"SELECT receipt FROM market_inference_requests s JOIN market_inference_receipts r USING(request_id,revision) WHERE s.request_id='{id}'"))
            assert actual == record["receipt"]
            charged = actual["financial"]["cash_micro_usd"]
            assert int(sql(f"SELECT sum(amount_micro_usd) FROM credit_ledger_entries WHERE metadata->>'request_id'='{id}'")) == -charged
            assert int(sql(f"SELECT balance_micro_usd FROM credit_accounts a JOIN market_inference_requests r USING(user_id) WHERE r.request_id='{id}'")) == 25000 - charged
        host = json.loads(sql("SELECT json_build_object('bootstrap',encode(bootstrap,'hex'),'host',encode(host,'hex'),'host_sha256',host_sha256,'head_sha256',head_sha256,'sequence',sequence) FROM market_inference_hosts"))
        rows = json.loads(sql("SELECT json_agg(json_build_object('sequence',sequence,'previous_sha256',previous_sha256,'payload',encode(payload,'hex'),'payload_sha256',payload_sha256,'event_sha256',event_sha256) ORDER BY sequence) FROM market_inference_journal"))
        head = sha(bytes.fromhex(host["bootstrap"]))
        for sequence, row in enumerate(rows, 1):
            assert row["sequence"] == sequence and row["previous_sha256"] == head
            assert sha(bytes.fromhex(row["payload"])) == row["payload_sha256"]
            head = sha((head + row["payload_sha256"]).encode())
            assert head == row["event_sha256"]
        assert head == host["head_sha256"] and len(rows) == host["sequence"]
        assert sha(bytes.fromhex(host["host"])) == host["host_sha256"]
        assert json.loads(bytes.fromhex(host["host"])) == json.loads(bytes.fromhex(rows[-1]["payload"]))["host"]
    finally:
        a.run("pg_ctl", "-D", str(pg), "-m", "fast", "-w", "stop")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--verify-database", action="store_true")
    parser.add_argument("--prior-calibration", type=Path,
                        help="Retained earlier calibration in the same approved task budget")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = audit(args.run_dir, args.verify_database, args.prior_calibration)
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
