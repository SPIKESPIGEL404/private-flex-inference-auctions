#!/usr/bin/env python3
"""Independent live-evidence audit: signatures, journal chain, gate order, exact
spool bytes reconstructed from committed checkpoints + the durable sink, and
native Prometheus evidence. No network, GPU or production credentials.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import struct
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from prometheus_client.parser import text_string_to_metric_families


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def digest(domain, value):
    return hashlib.sha256(domain.encode() + b"\0" + canonical(value)).hexdigest()


def load(path):
    return json.loads(path.read_text())


def samples(path):
    values = {}
    for family in text_string_to_metric_families(path.read_text()):
        for sample in family.samples:
            values[sample.name] = values.get(sample.name, 0) + sample.value
    return values


def journal(directory):
    config = load(directory / "config.json")
    plan = load(directory / "plan.json")
    unsigned = json.loads(json.dumps(plan))
    unsigned.pop("manifest_hash")
    unsigned["authorization_binding"].pop("signature")
    assert plan["manifest_hash"] == digest("flex-scheduler/manifest/v1", unsigned)
    issuer = plan["authorization_binding"]["issuer_id"]
    public = bytes.fromhex(config["authorized_issuers"][issuer])
    Ed25519PublicKey.from_public_bytes(public).verify(bytes.fromhex(plan["authorization_binding"]["signature"]), ("flex-scheduler/authorization/v1\0" + plan["target_scheduler_id"] + "\0" + plan["manifest_hash"]).encode())
    connection = sqlite3.connect("file:" + str((directory / "journal.sqlite").resolve()) + "?mode=ro", uri=True)
    actions, events, previous = [], [], "GENESIS"
    for expected, row in enumerate(connection.execute("SELECT event_seq, previous_hash, record_hash, action_json, event_json FROM journal ORDER BY event_seq"), 1):
        seq, predecessor, hashed, action_json, event_json = row
        action = json.loads(action_json)
        assert seq == expected and predecessor == previous
        assert canonical(action) == action_json.encode()
        assert digest("flex-scheduler/record/v1", {"event_seq": seq, "previous_hash": previous, "action": action}) == hashed
        event = json.loads(event_json)
        assert event["event_seq"] == seq and event["event_id"] == hashed
        actions.append(action)
        events.append(event)
        previous = hashed
    config_hash, head_seq, head_hash, snapshot_json = connection.execute("SELECT config_hash,head_seq,head_hash,snapshot_json FROM metadata").fetchone()
    connection.close()
    assert config_hash == digest("flex-scheduler/config/v1", config)
    assert head_seq == len(events) and head_hash == previous
    return plan, actions, events, json.loads(snapshot_json)


def audit_run(directory, summary):
    plan, actions, events, snapshot = journal(directory)
    dispatch = [e for e in events if e["kind"] == "DISPATCH_INTENT"]
    assert [e["binding"]["execution_id"] for e in dispatch] == [r["execution_id"] for r in plan["ordered_requests"]]
    for previous, following in zip(dispatch, dispatch[1:]):
        gates = [e["event_seq"] for e in events if e["kind"] in ("OUTPUT_PROGRESS", "EXECUTION_TERMINAL") and (e.get("binding") or {}).get("execution_id") == previous["binding"]["execution_id"]]
        assert min(gates) < following["event_seq"]
    before, after = samples(directory / "before.prom"), samples(directory / "after.prom")
    for name, delta in summary["metrics_delta"].items():
        assert abs((after[name] - before.get(name, 0)) - delta) < 0.000001, name
    peak_files = list(directory.glob("native-peak-*.prom"))
    peak = max((samples(path)["vllm:num_requests_running"] for path in peak_files), default=0)
    assert peak == summary["native_peak_running"]
    if summary["max_inflight"] >= 2:
        assert peak >= 2 and summary["native_b_terminal_before_a"]
    for request in plan["ordered_requests"]:
        execution = request["execution_id"]
        unsigned = {k: v for k, v in request.items() if k != "request_digest"}
        assert request["request_digest"] == digest("flex-scheduler/request/v1", unsigned)
        artifact = load(directory / "sink" / (execution + ".json"))
        binding = artifact["binding"]
        assert binding["request_digest"] == request["request_digest"] and binding["manifest_hash"] == plan["manifest_hash"]
        native = summary["native_traces"][execution]
        assert native["binding_digest"] == digest("flex-scheduler/result-binding/v1", binding)
        blob = b"FLEXR01\n" + bytes.fromhex(native["binding_digest"])
        text, text_at, tokens, records = artifact["text"].encode(), 0, [], 0
        for action in actions:
            if action["action"] != "OBSERVED" or action["observation"]["execution_id"] != execution:
                continue
            checkpoint = action.get("spool_checkpoint")
            assert checkpoint is not None
            ids = action["observation"]["observation"].get("generated_token_ids", [])
            if ids:
                length = checkpoint["text_bytes"] - text_at
                delta = text[text_at:text_at + length]
                delta.decode()
                blob += struct.pack("<II", length, len(ids)) + delta + b"".join(struct.pack("<I", token) for token in ids)
                text_at += length
                tokens += ids
                records += 1
            assert checkpoint["used_bytes"] == len(blob) and checkpoint["records"] == records
            assert checkpoint["prefix_digest"] == hashlib.sha256(blob).hexdigest()
        assert text_at == len(text) and tokens == artifact["token_ids"]
        usage, metadata = artifact["metadata"]["usage"], artifact["metadata"]
        assert usage["prompt_tokens"] == len(request["prompt_token_ids"]) and usage["completion_tokens"] == len(tokens)
        blob += struct.pack("<QQQQ", usage["prompt_tokens"], usage["completion_tokens"], usage["total_tokens"], records)
        assert len(blob) == metadata["used_bytes"] and hashlib.sha256(blob).hexdigest() == metadata["digest"]
        kinds = {}
        for event in events:
            if (event.get("binding") or {}).get("execution_id") == execution:
                kinds.setdefault(event["kind"], []).append(event)
        for kind in ("DISPATCH_INTENT", "RESULT_DURABLE", "RESULT_HANDED_OFF", "RESULT_CLEANED"):
            assert len(kinds[kind]) == 1
        ordered = [kinds[kind][0]["event_seq"] for kind in ("EXECUTION_TERMINAL", "STREAM_FINISHED", "RESULT_DURABLE", "RESULT_HANDED_OFF", "CLEANUP_STARTED", "RESULT_CLEANED")]
        assert ordered == sorted(ordered) and len(set(ordered)) == len(ordered)
        assert kinds["RESULT_DURABLE"][0]["artifact"] == metadata
        assert snapshot["executions"][execution]["cleanup_complete"]
    assert snapshot["mode"] == "RECOVERY_REQUIRED"
    return len(plan["ordered_requests"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--recovery-dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    live = load(args.run_dir / "acceptance.json")
    session = live["session"]
    assert digest("flex-scheduler/vllm-profile/v1", session["profile"]) == session["profile_digest"]
    prompt = load(args.run_dir / "prompt.json")
    assert prompt["engine_epoch"] == session["engine_epoch"] and prompt["profile_digest"] == session["profile_digest"]
    assert len(live["calibration"]) == 9 and len(live["cache_namespace_checks"]) == 3
    assert sorted(r["max_inflight"] for r in live["calibration"]) == [1] * 3 + [2] * 3 + [4] * 3
    total = 0
    for result in live["calibration"] + live["cache_namespace_checks"]:
        directory = args.run_dir / result["run"]
        config, plan = load(directory / "config.json"), load(directory / "plan.json")
        assert config["scheduler_policy_version"] == "external-gate-v1-" + session["profile_digest"]
        assert all(r["prompt_token_ids"] == prompt["token_ids"] for r in plan["ordered_requests"])
        total += audit_run(args.run_dir / result["run"], result)
    assert total == 39
    cache = live["cache_namespace_checks"]
    assert cache[1]["metrics_delta"]["vllm:prefix_cache_hits_total"] > 0
    assert cache[2]["metrics_delta"]["vllm:prefix_cache_hits_total"] == 0
    recovery_verified = False
    if args.recovery_dir:
        recovery = load(args.recovery_dir / "recovery.json")
        proof = load(args.recovery_dir / "isolation.json")
        old = load(args.recovery_dir / "session.json")
        assert proof["old_engine_epoch"] == old["engine_epoch"]
        assert proof["new_engine_epoch"] == recovery["new_engine_epoch"] != proof["old_engine_epoch"]
        assert proof["old_instance_id"] != proof["new_instance_id"]
        assert proof["old_admission_sealed"] and proof["old_native_idle"] and proof["old_instance_absent"]
        assert proof["single_replacement_instance"]
        assert proof["native_idle_samples"] >= 3
        plan, actions, events, snapshot = journal(args.recovery_dir)
        fences = [a for a in actions if a["action"] == "EPOCH_FENCED"]
        assert len(fences) == 1 and fences[0]["engine_epoch"] == old["engine_epoch"]
        assert fences[0]["evidence_ref"] == "isolation-" + digest("flex-scheduler/isolation-evidence/v1", proof)
        first, second = [r["execution_id"] for r in plan["ordered_requests"]]
        intents = [e["binding"]["execution_id"] for e in events if e["kind"] == "DISPATCH_INTENT"]
        assert intents == [first, second]
        assert snapshot["executions"][first]["result"] == "UNAVAILABLE" and snapshot["executions"][first]["fenced"]
        assert snapshot["executions"][second]["result"] == "HANDED_OFF"
        assert all(snapshot["executions"][e]["cleanup_complete"] for e in (first, second))
        assert recovery["original_execution_reposts"] == 0 and recovery["only_next_unsent_dispatched"]
        artifact = load(args.recovery_dir / "recovered-result.json")
        assert artifact["binding"]["execution_id"] == second and artifact["binding"]["engine_epoch"] == proof["new_engine_epoch"]
        assert artifact["binding"]["request_digest"] == plan["ordered_requests"][1]["request_digest"]
        blob = b"FLEXR01\n" + bytes.fromhex(digest("flex-scheduler/result-binding/v1", artifact["binding"]))
        text, offset, tokens, records = artifact["text"].encode(), 0, [], 0
        for action in actions:
            if action["action"] != "OBSERVED" or action["observation"]["execution_id"] != second:
                continue
            checkpoint = action["spool_checkpoint"]
            ids = action["observation"]["observation"].get("generated_token_ids", [])
            if ids:
                length = checkpoint["text_bytes"] - offset
                blob += struct.pack("<II", length, len(ids)) + text[offset:offset + length] + b"".join(struct.pack("<I", token) for token in ids)
                offset += length
                tokens += ids
                records += 1
            assert checkpoint["prefix_digest"] == hashlib.sha256(blob).hexdigest() and checkpoint["used_bytes"] == len(blob)
        usage = artifact["metadata"]["usage"]
        blob += struct.pack("<QQQQ", usage["prompt_tokens"], usage["completion_tokens"], usage["total_tokens"], records)
        assert tokens == artifact["token_ids"] and offset == len(text)
        assert hashlib.sha256(blob).hexdigest() == artifact["metadata"]["digest"] and len(blob) == artifact["metadata"]["used_bytes"]
        recovery_verified = True
    output = {"independent_audit": "passed", "signed_plans_and_config_hashes": True, "journal_hash_chains": True, "journal_gate_order": True, "exact_spool_prefixes_and_artifacts_reconstructed": True, "native_metrics_independently_parsed": True, "one_intent_per_execution": True, "calibration_results": total, "durable_acked_cleaned_results": total + int(recovery_verified), "real_interruption_and_isolation_recovery_verified": recovery_verified}
    args.output.write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps(output))


if __name__ == "__main__":
    main()
