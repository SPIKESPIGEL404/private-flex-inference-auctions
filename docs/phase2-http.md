# Phase two: loopback HTTP/SSE adapter

This guide describes the HTTP-only phase-two scope, committed as `085a09b`. The current [phase-three implementation](phase3-spool.md) adds result storage, handoff ACK and cleanup when opened with spool enabled.

Status: implemented and locally accepted with a mock vLLM server. See the
[acceptance report](acceptance/2026-11-02-phase2.md). Phase one was committed as
`b5bcc26` before this work started.

```bash
bash scripts/accept-phase2.sh
# With dependencies already cached:
CARGO_NET_OFFLINE=true bash scripts/accept-phase2.sh
```

The script runs all phase-one and phase-two tests, formatting, Clippy, and a
self-contained loopback HTTP walkthrough. No external endpoint or credentials
are needed. To retain the walkthrough database, choose a new path:

```bash
cargo run --locked --example phase2_mock -- --db /tmp/flex-phase2-example.sqlite
```

## Components

- [sse.rs](../src/sse.rs): incremental bounded framing and Completion validation.
- [mock_http.rs](../src/mock_http.rs): single-owner runner, bounded worker messages,
  one HTTP attempt per committed intent and durable observation acknowledgments.
- [stream.rs](../src/stream.rs): typed protocol summary, usage and failure reasons.
- [tests/phase2.rs](../tests/phase2.rs): actual socket tests and parser/upgrade cases.

`MockHttpRunner` deliberately accepts only literal loopback HTTP URLs with an
explicit port and `/v1/completions` path. No DNS hostnames, URL credentials,
queries, fragments, remote IPs or HTTPS endpoints are accepted. The reqwest
client is HTTP/1-only, with automatic retries, redirects, system proxies and
compression disabled. This is an acceptance transport, not the real vLLM/TEE
deployment configuration or a public scheduler service.

## Request and response contract

The runner maps the frozen token-ID input, namespace, output limit and integer
sampler to the pinned Completion API. Echo, input truncation, multiple choices,
dynamic priority and continuous usage stats are disabled. Response identity is
`cmpl-{execution_id}` with the configured served model and `text_completion`
object. This mapping was checked against the [pinned vLLM serving source](https://github.com/vllm-project/vllm/blob/db7f2d7c44f12f8b690c930000d89e479f3838c0/vllm/entrypoints/openai/completion/serving.py).

The SSE decoder handles BOM, LF/CRLF/CR, comments, multi-line data, multiple
events per read, and UTF-8 split across reads. It implements framing only:
`id` and `retry` fields never cause EventSource-style reconnection. Invalid
UTF-8 is rejected rather than replaced. Raw line, whole-event and whole-stream
byte limits are separate. A later malformed/oversized event does not discard
valid prefix events from the same read. Framing follows the relevant
[SSE format](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)
with stricter protocol validation for this fixed backend profile.

Each event is fully validated before any observation can open a gate:

- Response ID/model/object, choice count/index and any returned prompt IDs match.
- Root/choice errors and invalid finish reasons take priority over token signals.
- Duplicate known JSON fields, malformed types and unsupported content are rejected.
- Text alone, prompt IDs, metadata, heartbeats and usage-only frames do not open gates.
- Generated IDs are valid for the vocabulary, cumulative output limit and core
  per-observation cap; token count, prompt count and total usage must agree.
- Only normal `stop`/`length` terminate successfully; a terminal delta can include
  first-generation IDs and be persisted atomically.
- Valid terminal, final usage, DONE and normal HTTP end are all required for
  `COMPLETE_PROTOCOL`. Extra generation after terminal or data after DONE fails.

All non-200 statuses are conservatively UNKNOWN before terminal, including 400,
429, 5xx and redirects. Phase two has no verified pre-execution rejection policy,
so an HTTP status alone never proves nothing ran. Connect/headers, first-progress,
idle and total time bounds are explicit; heartbeat traffic cannot extend the
first-progress or total deadline.

## Single owner and failure behavior

Workers send typed observations through a bounded mpsc queue and wait for a
durable core ACK. Only the owner mutates the scheduler. A worker cannot advance
on a failed journal commit. Request/context reservations and an additional
live-stream limit bound dispatch and trailing usage/EOF connections separately.

An error before trusted terminal evidence produces UNKNOWN and stops dispatch.
An error after terminal records protocol incompleteness while retaining terminal
and gate facts. Execution capacity may be released; result space remains reserved.
The runner drains other existing workers but never starts a retry or restores an
old intent. Cancellation, worker failure or a core error triggers an interruption
guard that durably pauses and marks outstanding executions UNKNOWN if persistence
is available; persistence failure instead poisons the core handle. Reopen still
requires recovery and never reconstructs an HTTP submission from an old intent.

## Durable protocol summaries and old journals

`STREAM_FINISHED` stores a `StreamReport` with original execution/epoch, verified
usage, generated-token count, wire/text byte counts and a bounded enum reason.
Reports are idempotent; conflicting replacements latch an integrity fault.
They are replayable and remain visible after reopen without raw text/token IDs
in the external event feed.

`COMPLETE_PROTOCOL` does **not** mean `RESULT_DURABLE`, buyer delivery, financial
closure or durable result handoff. The core result state remains PENDING, and
physical spool, artifact reads/ACKs and cleanup belong to phase three. Stream
text is counted and discarded by this mock adapter; do not use it for a real
inference workload that requires complete output retention.

New optional summary fields omit None in persisted snapshots and event JSON,
preserving old journal hashes/projections. The upgrade test imports an actual
phase-one journal rebuilt from `b5bcc26` and appends phase-two events successfully.
Old code cannot be assumed to read the newly added action variants.

No live GPU, real BitRouter integration, physical output storage, TLS/TEE trust
or production performance is accepted by this stage.
