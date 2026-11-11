#!/usr/bin/env python3
"""Summarize real acceptance measurements; no claim of production SLA."""
import argparse
import json
from pathlib import Path
from statistics import mean, median


def stats(values):
    values = sorted(values)
    return {"samples": len(values), "min": min(values), "median": median(values), "mean": mean(values), "max": max(values)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    live = json.loads((args.run_dir / "acceptance.json").read_text())
    comparison = []
    for limit in [1, 2, 4]:
        runs = [r for r in live["calibration"] if r["max_inflight"] == limit]
        ttft, persistence, gate_wait, capacity_wait, dispatch_ready, registration, claims = [], [], [], [], [], [], []
        for run in runs:
            by_id = {m["execution_id"]: m for m in run["measurements"]}
            plan = json.loads((args.run_dir / run["run"] / "plan.json").read_text())
            ordered = [by_id[r["execution_id"]] for r in plan["ordered_requests"]]
            for item in ordered:
                ttft.append((item["first_token_received_at_us"] - item["dispatch_at_us"]) / 1000)
                persistence.append((item["first_progress_committed_at_us"] - item["first_token_received_at_us"]) / 1000)
                claims.append(item["reservation_and_intent_us"] / 1000)
            registration.append(run["registration_commit_us"] / 1000)
            for index in range(1, len(ordered)):
                gate = ordered[index - 1]["first_progress_committed_at_us"]
                capacity = gate
                # Only the in-flight limit binds in this small calibration:
                # all four context reservations and spool slots fit simultaneously.
                if index >= limit:
                    terminal = sorted(m["terminal_committed_at_us"] for m in ordered[:index])[index - limit]
                    capacity = max(capacity, terminal)
                dispatch = ordered[index]["dispatch_at_us"]
                assert dispatch >= capacity >= gate
                gate_wait.append((dispatch - gate) / 1000)
                capacity_wait.append((capacity - gate) / 1000)
                dispatch_ready.append((dispatch - capacity) / 1000)
        native = lambda name: sum(r["metrics_delta"].get(name, 0) for r in runs)
        count = native("vllm:time_to_first_token_seconds_count")
        comparison.append({"max_inflight_requests": limit, "trials": len(runs), "completed_requests": len(ttft),
            "output_tokens_per_second": stats([r["output_tokens_per_second"] for r in runs]),
            "batch_elapsed_seconds": stats([r["elapsed_seconds"] for r in runs]),
            "client_dispatch_to_first_token_ms": stats(ttft), "first_event_queue_spool_and_journal_ms": stats(persistence),
            "gate_commit_to_next_dispatch_ms": stats(gate_wait), "capacity_wait_after_gate_ms": stats(capacity_wait),
            "capacity_ready_to_dispatch_ms": stats(dispatch_ready), "reservation_and_intent_ms": stats(claims),
            "registration_commit_ms": stats(registration), "native_peak_running": max(r["native_peak_running"] for r in runs),
            "native_peak_kv_cache_usage": max(s["kv_cache_usage"] or 0 for r in runs for s in r["native_samples"]),
            "native_preemptions": native("vllm:num_preemptions_total"),
            "native_ttft_mean_ms": native("vllm:time_to_first_token_seconds_sum") / count * 1000 if count else None})
    best = max(comparison, key=lambda c: c["output_tokens_per_second"]["mean"])
    result = {"scope": "one pinned GPU, synthetic 1737-token prompt, outputs 512/128/256/256, three trials per limit",
              "profile_digest": live["session"]["profile_digest"], "comparison": comparison,
              "best_measured_inflight": best["max_inflight_requests"],
              "production_default_established": False,
              "limitations": ["client clocks include network and durable I/O", "first generated token is not exact prefill-complete", "small sample; no TTFT SLA", "8192-token input cap and 32K aggregate context were not stress-calibrated"]}
    with args.output.open("x") as file:
        json.dump(result, file, indent=2)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
