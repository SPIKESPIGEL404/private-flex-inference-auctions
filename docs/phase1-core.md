# Phase one: durable scheduler core

This guide describes phase-one scope. The current [phase-three implementation](phase3-spool.md) adds result storage, handoff ACK and cleanup.

Status: implemented and locally accepted. This is a Rust library and an offline
fixture walkthrough, not an HTTP service or a GPU serving deployment. The scope
is step 1 of [the scheduler spec](specs/2026-11-02-external-prefill-gating-scheduler.md).

## Run

Rust 1.89 or later is declared by the crate; acceptance was run on Rust 1.97.0.
SQLite is bundled by rusqlite. Dependency versions are fixed by Cargo.lock.

```bash
bash scripts/accept-phase1.sh
```

The script checks formatting, all target tests and Clippy with warnings denied,
then runs the fixed-plan walkthrough in a fresh temporary directory. Existing
journals are never reset. With cached dependencies it can run offline:

```bash
CARGO_NET_OFFLINE=true bash scripts/accept-phase1.sh
```

To retain a walkthrough database, supply a new path:

```bash
cargo run --locked --example phase1_fixture -- --db /tmp/flex-phase1-example.sqlite
```

The walkthrough registers plan 2 before plan 1, checks predecessor blocking,
dispatches A, records A's generation progress, permits B while A remains active,
records B's zero-visible-output terminal event, then permits C in plan 2. It
checks independent journal replay, reopens in recovery mode, explicitly starts
a fresh epoch, and verifies that none of the three intents is issued again.
All backend observations in this walkthrough are synthetic typed evidence.

## API and ownership

| API | Phase-one behavior |
| --- | --- |
| `Scheduler::open` | Acquires the local OS writer lock, checks configuration and full journal replay, then durably enters `RECOVERY_REQUIRED`. |
| `activate` | Requires nonempty trusted operator evidence, no unresolved in-flight execution, no integrity fault and an unused epoch. |
| `register_json` / `register` | Strict v1 schema, request/manifest validation, Ed25519 authorization, complete atomic registration and identity deduplication. |
| `claim_next` | Commits a one-shot dispatch intent, cursor and logical reservations before returning it; never performs I/O to an inference backend. |
| `observe` | Accepts trusted typed adapter observations, not buyer assertions; validates sequence/epoch, commits gate/terminal/unknown changes and event projection atomically. |
| `events_after` | Bounded, stable event replay; the same event retains its sequence and ID. No raw token IDs, prompts, signature or financial fields. |
| `plan_state` / `snapshot` | Metadata views of plans, execution/gate states, cursors and capacity. |
| `replay_snapshot` | Independently rebuilds state from the private action journal and verifies the saved materialized state. |
| `pause` / `record_epoch_isolation` | Records trusted operator decisions; does not itself stop a process, fence a network endpoint or attest a deployment. |

The signing and recovery contracts are phase-one candidate integrations. The
existing BitRouter transport, key authority and APIs have not been changed or
verified. No auction, financial state, buyer API or settlement simulator is added.

## Version-one encoding and authorization

Contract structs reject unknown fields, including financial fields. The plan
JSON reader checks its byte limit before deserialization. All contract numbers
are integers. Canonical bytes are compact serde_json JSON with recursively
lexically sorted ASCII field names and serde_json string escaping. This is an
explicit project encoding, not a claim of generic RFC 8785 support.

Sampling uses `temperature_milli`, `top_p_millionths`, `top_k`, `seed` and
`stop_token_ids`; temperature is 0–2000 milli, top-p is 1–1,000,000 millionths,
top-k is 0–vocabulary size (zero means unfiltered in the contract), and seed fits
a nonnegative signed 64-bit integer. The future HTTP adapter must map these
values to vLLM explicitly. Unsupported sampler extensions are rejected, rather
than silently inheriting mutable defaults.

- Request digest: SHA-256 over `flex-scheduler/request/v1`, a NUL byte, then the
  canonical request without `request_digest`.
- Manifest digest: SHA-256 over `flex-scheduler/manifest/v1`, a NUL byte, then the
  canonical plan without `manifest_hash` or the nested signature. Issuer,
  authorization reference, target, profile, sequence and all requests remain bound.
- Authorization: strict Ed25519 verification of UTF-8
  `flex-scheduler/authorization/v1\0{target_scheduler_id}\0{manifest_hash}`
  against an explicitly configured public issuer key. `\0` denotes one NUL byte.
- Identifiers are bounded ASCII strings; hashes/signatures use lowercase hex.
  Genesis is the literal `GENESIS`; plan sequence and rank start at one.

The fixed profile ID must identify immutable model/tokenizer/template settings.
The local journal additionally binds the entire scheduler configuration. Reusing
the same database with changed limits, keys, profile or identities fails closed;
configuration migration and key rotation are not implicit reopen operations.

## Persistence and recovery

The local journal uses SQLite WAL, synchronous FULL, immediate transactions and
a private `0600` database/lock on Unix. Each transaction writes the private action,
redacted event, head hash and materialized state together. State is published in
memory only after commit. A persistence failure poisons the handle; subsequent
mutations cannot proceed until the journal is reopened and reconciled. SQLite's
WAL FULL durability depends on functioning filesystem/device synchronization;
these tests do not simulate physical power loss. See [SQLite PRAGMA documentation](https://www.sqlite.org/pragma.html#pragma_synchronous).

Reopen checks contiguous event sequence, SHA-256 predecessor chain, replayed
transitions, event projection and snapshot. It then records a new process-open
pause and classifies nonterminal intents/streams as UNKNOWN without changing
their original identities, gates or reservations. This detects corruption and
inconsistent views; an unkeyed hash chain does not prevent an attacker from
rewriting or rolling back the entire store.

Activation evidence references are assertions from a trusted operator/adapter;
checking their syntax is not verification that isolation, freshness or GPU
calibration actually occurred. Unresolved old executions block activation. The
operator must isolate the old engine and entrypoint before recording epoch
isolation; the core then closes those responsibilities as unavailable, preserves
their original intent, and allows a new epoch. Late evidence for a fenced epoch
is journaled without changing its closure or freeing capacity again.

An immutable plan/hash or observation-sequence conflict durably latches an
integrity fault. Generic activation cannot clear it. Source-authority repair of
such conflicts is deliberately not an automatic recovery operation in phase one.

The file lock is advisory and covers cooperating scheduler processes on a local
filesystem. Symlink aliases resolve to the same lock. Do not unlink the lock file
while a writer is alive, use database hard links, or place this WAL database on
an unsupported network filesystem. Journal and lock must be retained together.

## Boundaries of phase-one acceptance

Implemented: contracts, single-writer state transitions, immutable registration,
gate and capacity logic, signed fixtures, durable intent/event journal, redacted
pagination, replay validation and conservative recovery transitions.

Logical result reservations remain after terminal events. Physical file allocation,
spool cleanup, durable result ACK, result retrieval and result-complete events
belong to phase three; phase one cannot certify storage capacity or release those
reservations through a fake handoff. Historical journal compaction is not included.

The core records token progress directly in its private journal for phase-one
evidence. Before real HTTP dispatch is enabled, the later adapter/spool work must
connect physical result persistence to these state transitions. There is no raw
SSE parser, network request, live vLLM test, GPU calibration, TEE validation or
claim of real inference exactly-once in this stage.
