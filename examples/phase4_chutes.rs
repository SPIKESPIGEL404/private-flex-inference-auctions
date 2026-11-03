//! Paid, explicit live acceptance. Public synthetic plan signer; not BitRouter.
#[path = "../tests/common/mod.rs"]
mod common;
use common::*;
use flex_scheduler::*;
use serde_json::{Value, json};
use std::io::Write;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::Instant;
const ENDPOINT: &str = "https://kelsen-qwen-qwen3-8-27b-fp8.chutes.ai/scheduler/completions";
fn save<T: serde::Serialize>(
    path: &Path,
    value: &T,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    serde_json::to_writer_pretty(&file, value)?;
    file.sync_all()?;
    File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}
fn save_text(path: &Path, text: &str) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    File::open(path.parent().unwrap())?.sync_all()
}

fn create_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn cfg(session: &VllmSession, run: &str, inflight: u64) -> SchedulerConfig {
    let mut c = config();
    c.scheduler_id = format!("phase4-{run}");
    c.stream_id = format!("stream-{run}");
    c.model = session.profile.model_profile();
    c.scheduler_policy_version = session.scheduler_policy_version();
    c.max_inflight_requests = inflight;
    c.max_reserved_context_tokens = session.profile.max_model_len;
    c.max_spool_bytes = 16 * 1024 * 1024;
    c.max_owner_spool_bytes = 16 * 1024 * 1024;
    c.max_queued_bytes = 8 * 1024 * 1024;
    c.max_plan_bytes = 16 * 1024 * 1024;
    c.max_observation_tokens = 1024;
    c
}
fn spool_policy() -> SpoolPolicy {
    SpoolPolicy {
        acknowledged_retention_ms: 0,
        max_artifact_bytes: 8 * 1024 * 1024,
        max_physical_bytes: 32 * 1024 * 1024,
        max_owner_physical_bytes: 32 * 1024 * 1024,
    }
}
fn http(session: &VllmSession) -> VllmHttpConfig {
    VllmHttpConfig {
        session: session.clone(),
        transport: MockHttpConfig {
            endpoint: ENDPOINT.into(),
            served_model: session.profile.served_model.clone(),
            model_profile_id: session.profile.profile_id.clone(),
            connect_timeout_ms: 10000,
            first_progress_timeout_ms: 60000,
            idle_timeout_ms: 30000,
            total_timeout_ms: 180000,
            max_line_bytes: 131072,
            max_event_bytes: 262144,
            max_stream_bytes: 8 * 1024 * 1024,
            max_live_streams: 4,
            event_queue_capacity: 1,
        },
    }
}
fn activate(s: &mut Scheduler, session: &VllmSession) {
    s.reconcile_spool("phase4-live-local-spool-verified".into())
        .unwrap();
    s.activate(ActivationEvidence {
        engine_epoch: session.engine_epoch.clone(),
        writer_isolation_ref: "phase4-local-exclusive-writer-lock".into(),
        source_continuity_ref: "phase4-signed-fixture-chain".into(),
        state_freshness_ref: "phase4-new-local-journal".into(),
        profile_verified_ref: format!("profile-{}", session.profile_digest),
    })
    .unwrap();
}
fn make_plan(
    c: &SchedulerConfig,
    run: &str,
    prompt: &[u32],
    outputs: &[u64],
    salt: &str,
) -> ExecutionPlan {
    let mut p = plan(1, GENESIS, outputs.len() as u32);
    p.plan_id = format!("plan-{run}");
    p.stream_id = c.stream_id.clone();
    p.target_scheduler_id = c.scheduler_id.clone();
    p.model_profile_id = c.model.profile_id.clone();
    p.scheduler_policy_version = c.scheduler_policy_version.clone();
    for (i, (r, &max)) in p.ordered_requests.iter_mut().zip(outputs).enumerate() {
        r.execution_id = format!("{run}-{}", i + 1);
        r.grant_id = format!("grant-{run}-{}", i + 1);
        r.request_ref = format!("request-{run}-{}", i + 1);
        r.prompt_token_ids = prompt.to_vec();
        r.max_output_tokens = max;
        r.context_reservation = prompt.len() as u64 + max;
        r.max_result_bytes =
            max * c.model.result_bytes_per_output_token + c.model.result_overhead_bytes;
        r.cache_namespace = salt.into();
        r.sampling_config.stop_token_ids = vec![];
    }
    seal(&mut p);
    p
}
fn metrics(text: &str) -> BTreeMap<String, f64> {
    let names = [
        "vllm:prefix_cache_queries_total",
        "vllm:prefix_cache_hits_total",
        "vllm:num_preemptions_total",
        "vllm:request_success_total",
        "vllm:prompt_tokens_total",
        "vllm:generation_tokens_total",
        "vllm:time_to_first_token_seconds_sum",
        "vllm:time_to_first_token_seconds_count",
        "vllm:e2e_request_latency_seconds_sum",
        "vllm:e2e_request_latency_seconds_count",
        "vllm:num_requests_running",
        "vllm:num_requests_waiting",
        "vllm:kv_cache_usage_perc",
    ];
    let mut values = BTreeMap::new();
    for line in text.lines().filter(|s| !s.starts_with('#')) {
        let Some((label, tail)) = line.split_once("} ").or_else(|| line.split_once(' ')) else {
            continue;
        };
        let value = tail.split_whitespace().next().unwrap_or("");
        let name = label.split('{').next().unwrap_or(label);
        if names.contains(&name)
            && let Ok(v) = value.parse::<f64>()
            && v.is_finite()
        {
            *values.entry(name.into()).or_default() += v;
        }
    }
    values
}
fn delta(before: &BTreeMap<String, f64>, after: &BTreeMap<String, f64>) -> BTreeMap<String, f64> {
    after
        .iter()
        .map(|(k, v)| (k.clone(), v - before.get(k).copied().unwrap_or(0.0)))
        .collect()
}
fn handoff(
    s: &mut Scheduler,
    p: &ExecutionPlan,
    dir: &Path,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let sink = dir.join("sink");
    create_dir(&sink)?;
    let mut artifacts = Vec::new();
    for r in &p.ordered_requests {
        let a = s.get_result_artifact(&r.execution_id, &r.owner_ref)?;
        assert_eq!(a.binding.request_digest, r.request_digest);
        assert_eq!(a.token_ids.len() as u64, a.metadata.usage.completion_tokens);
        save(&sink.join(format!("{}.json", r.execution_id)), &a)?;
        let receipt = format!("sink:{}", r.execution_id);
        let at = now_ms();
        assert_eq!(
            s.ack_result(
                &r.execution_id,
                &r.owner_ref,
                &a.metadata.digest,
                &receipt,
                at
            )?,
            ObservationOutcome::Recorded
        );
        assert_eq!(
            s.ack_result(
                &r.execution_id,
                &r.owner_ref,
                &a.metadata.digest,
                &receipt,
                at + 1
            )?,
            ObservationOutcome::AlreadyRecorded
        );
        artifacts.push(a);
    }
    assert_eq!(s.collect_results(now_ms())?, p.request_count as usize);
    assert_eq!(s.snapshot()?.capacity.physical_spool_bytes, 0);
    for expected in artifacts {
        let stored: ResultArtifact = serde_json::from_slice(&fs::read(
            sink.join(format!("{}.json", expected.binding.execution_id)),
        )?)?;
        assert!(stored == expected);
    }
    assert_eq!(s.snapshot()?, s.replay_snapshot()?);
    Ok(())
}
struct Case<'a> {
    run: &'a str,
    inflight: u64,
    prompt: &'a [u32],
    outputs: &'a [u64],
    salt: &'a str,
}
async fn run_plan(
    control: &VllmControl,
    session: &VllmSession,
    key: &str,
    dir: &Path,
    case: Case<'_>,
) -> std::result::Result<Value, Box<dyn std::error::Error>> {
    let Case {
        run,
        inflight,
        prompt,
        outputs,
        salt,
    } = case;
    create_dir(dir)?;
    let c = cfg(session, run, inflight);
    let p = make_plan(&c, run, prompt, outputs, salt);
    let path = dir.join("journal.sqlite");
    let mut s = Scheduler::open_with_spool(&path, c.clone(), spool_policy())?;
    activate(&mut s, session);
    save(&dir.join("config.json"), &c)?;
    save(&dir.join("plan.json"), &p)?;
    let registration_started = Instant::now();
    s.register(p.clone())?;
    let registration_us = registration_started.elapsed().as_micros() as u64;
    let registered = Instant::now();
    let runner = VllmHttpRunner::new(http(session), key)?;
    let before_raw = control.metrics().await?;
    save_text(&dir.join("before.prom"), &before_raw)?;
    let before = metrics(&before_raw);
    for name in [
        "vllm:num_requests_running",
        "vllm:num_requests_waiting",
        "vllm:kv_cache_usage_perc",
        "vllm:num_preemptions_total",
        "vllm:prefix_cache_hits_total",
    ] {
        if !before.contains_key(name) {
            return Err(format!(
                "native calibration metric missing: {name}; no inference submitted"
            )
            .into());
        }
    }
    let registration_to_run_start_us = registered.elapsed().as_micros() as u64;
    let start = Instant::now();
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let sample = async {
        let mut samples = Vec::new();
        let mut largest = 0.0;
        loop {
            let value = tokio::select! {
                _=stopped.changed()=>break,
                result=control.metrics()=>result,
            };
            if let Ok(text) = value {
                let m = metrics(&text);
                if let Some(&running) = m.get("vllm:num_requests_running")
                    && running > largest
                {
                    save_text(
                        &dir.join(format!("native-peak-{}.prom", running as u64)),
                        &text,
                    )?;
                    largest = running;
                }
                if samples.len() < 512 {
                    samples.push(json!({"elapsed_us":start.elapsed().as_micros() as u64,"running":m.get("vllm:num_requests_running"),"waiting":m.get("vllm:num_requests_waiting"),"kv_cache_usage":m.get("vllm:kv_cache_usage_perc")}));
                }
            }
            tokio::select! {
                _=stopped.changed()=>break,
                _=tokio::time::sleep(Duration::from_millis(500))=>{},
            }
        }
        Ok::<_, Box<dyn std::error::Error>>(samples)
    };
    let dispatch = async {
        let result = runner.run_until_idle(&mut s).await;
        let _ = stop.send(true);
        result
    };
    let (r, native_samples) = tokio::join!(dispatch, sample);
    let r = r?;
    let native_samples = native_samples?;
    let native_peak = native_samples
        .iter()
        .filter_map(|m| m["running"].as_f64())
        .fold(0.0, f64::max);
    if inflight >= 2 {
        assert!(
            native_peak >= 2.0,
            "native metrics must independently show overlapping execution"
        );
    }
    let seconds = start.elapsed().as_secs_f64();
    save(&dir.join("run.json"), &r)?;
    if !r
        .streams
        .iter()
        .all(|s| s.protocol == ProtocolStatus::CompleteProtocol)
    {
        return Err(format!(
            "incomplete real stream: {}",
            serde_json::to_string(&r.streams)?
        )
        .into());
    }
    let after_raw = control.metrics().await?;
    save_text(&dir.join("after.prom"), &after_raw)?;
    let after = metrics(&after_raw);
    let state = control.state().await?;
    assert_eq!(state.engine_epoch, session.engine_epoch);
    let mut peak = 0u64;
    let mut active = 0u64;
    let events = s.events_after(0, 1000)?;
    for e in &events {
        match e.kind {
            EventKind::DispatchIntent => {
                active += 1;
                peak = peak.max(active);
            }
            EventKind::ExecutionTerminal => active -= 1,
            _ => {}
        }
    }
    assert!(peak <= inflight);
    for adjacent in p.ordered_requests.windows(2) {
        let a = &state.traces[&adjacent[0].execution_id];
        let b = &state.traces[&adjacent[1].execution_id];
        assert!(a.first_token_ns.or(a.terminal_ns).unwrap() < b.admitted_ns);
    }
    let overlap = if p.request_count > 1 {
        let a = &state.traces[&p.ordered_requests[0].execution_id];
        let b = &state.traces[&p.ordered_requests[1].execution_id];
        b.terminal_ns.unwrap() < a.terminal_ns.unwrap()
    } else {
        false
    };
    if inflight >= 2 && p.request_count >= 2 {
        assert!(
            overlap,
            "short B must finish before A in native-engine trace"
        );
    }
    let tokens: u64 = r.streams.iter().map(|s| s.generated_tokens).sum();
    handoff(&mut s, &p, dir)?;
    drop(s);
    let count_before = state.traces.len();
    let mut reopened = Scheduler::open_with_spool(&path, c, spool_policy())?;
    assert_eq!(reopened.snapshot()?.mode, Mode::RecoveryRequired);
    assert!(matches!(
        runner.run_until_idle(&mut reopened).await,
        Err(Error::NotActive)
    ));
    assert_eq!(control.state().await?.traces.len(), count_before);
    let traces: BTreeMap<_, _> = p
        .ordered_requests
        .iter()
        .map(|q| {
            (
                q.execution_id.clone(),
                state.traces[&q.execution_id].clone(),
            )
        })
        .collect();
    let result = json!({"run":run,"max_inflight":inflight,"observed_peak_inflight":peak,"prompt_tokens":prompt.len(),"registration_commit_us":registration_us,"registration_to_run_start_us":registration_to_run_start_us,"preflight_us":r.preflight_us,"registration_to_dispatch_us":r.measurements.iter().map(|m|json!({"execution_id":m.execution_id,"elapsed_us":registration_to_run_start_us+r.preflight_us.unwrap_or(0)+m.dispatch_at_us})).collect::<Vec<_>>(),"output_tokens":tokens,"elapsed_seconds":seconds,"output_tokens_per_second":tokens as f64/seconds,"native_b_terminal_before_a":overlap,"metrics_delta":delta(&before,&after),"measurements":r.measurements,"native_traces":traces,"native_peak_running":native_peak,"native_samples":native_samples,"durable_results":p.request_count,"handed_off_and_cleaned":p.request_count,"reopen_reposts":0});
    save(&dir.join("summary.json"), &result)?;
    Ok(result)
}
async fn wait_profile(
    control: &VllmControl,
) -> std::result::Result<VllmSession, Box<dyn std::error::Error>> {
    let deadline = Instant::now() + Duration::from_secs(900);
    loop {
        match control.profile().await {
            Ok(session) => {
                if let Ok(state) = control.state().await
                    && matches!(state.release.as_str(), "phase4-3" | "phase4-4")
                    && state.engine_epoch == session.engine_epoch
                    && state.accepting
                {
                    return Ok(session);
                }
                if Instant::now() >= deadline {
                    return Err(
                        "Expected Chutes protocol release not ready; no inference submitted".into(),
                    );
                }
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
            Err(_) => {
                if Instant::now() >= deadline {
                    return Err("Chutes profile never became ready; no inference submitted".into());
                }
                eprintln!("Waiting for Chutes profile readiness...");
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        }
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut key_file = None;
    let mut out = None;
    let mut mode = "accept".to_owned();
    let mut evidence = None;
    let mut prompt_file = None;
    while let Some(flag) = args.next() {
        let value = args.next().ok_or("missing argument value")?;
        match flag.as_str() {
            "--key-file" => key_file = Some(PathBuf::from(value)),
            "--out" => out = Some(PathBuf::from(value)),
            "--mode" => mode = value,
            "--isolation-evidence" => evidence = Some(PathBuf::from(value)),
            "--prompt-file" => prompt_file = Some(PathBuf::from(value)),
            _ => return Err("unknown argument".into()),
        }
    }
    let key = fs::read_to_string(key_file.ok_or("--key-file required")?)?;
    let out = out.ok_or("--out required")?;
    let control = VllmControl::new(ENDPOINT, key.trim())?;
    let session = wait_profile(&control).await?;
    if session.profile.model_revision != "017b9c7af6b5689d5dd426a76e0bc077eb5ca20a"
        || session.profile.image_ref != "6e46a33c-329a-5b55-a1dd-c9a5c9866943"
        || !session.profile.gpu_name.contains("RTX PRO 6000")
    {
        return Err("unexpected pinned model, image or GPU".into());
    }
    if mode == "resume" {
        return resume(
            &control,
            &session,
            key.trim(),
            &out,
            evidence.ok_or("--isolation-evidence required")?.as_path(),
        )
        .await;
    }
    if mode != "accept" && mode != "interrupt" {
        return Err("mode must be accept, interrupt or resume".into());
    }
    create_dir(&out)?;
    save(&out.join("session.json"), &session)?;
    let context =
        "This is a public synthetic scheduler validation context. Alpha beta gamma delta. "
            .repeat(120);
    let messages = json!([{"role":"system","content":"You are a helpful assistant. Answer directly without reasoning."},{"role":"user","content":format!("{context}\nWrite a very long tutorial with 100 numbered sections explaining scheduling and queues. Continue until the output limit; do not summarize early.")}]);
    let prompt: TokenizedPrompt = if let Some(path) = prompt_file {
        let prompt: TokenizedPrompt = serde_json::from_slice(&fs::read(path)?)?;
        if prompt.engine_epoch != session.engine_epoch
            || prompt.profile_digest != session.profile_digest
            || prompt.token_ids.is_empty()
            || prompt.token_ids.len() as u64 > session.profile.max_prompt_tokens
            || prompt
                .token_ids
                .iter()
                .any(|&id| u64::from(id) >= session.profile.vocab_size)
        {
            return Err("fixture prompt does not match the live session".into());
        }
        prompt
    } else {
        control.tokenize(messages, &session).await?
    };
    save(&out.join("prompt.json"), &prompt)?;
    if mode == "interrupt" {
        return interrupt(&control, &session, key.trim(), &out, &prompt.token_ids).await;
    }
    let mut runs = vec![];
    let nonce = now_ms();
    for limit in [1, 2, 4] {
        for trial in 1..=3 {
            let run = format!("p4-{nonce}-{limit}-{trial}");
            eprintln!("Running live calibration: inflight={limit}, trial={trial}");
            runs.push(
                run_plan(
                    &control,
                    &session,
                    key.trim(),
                    &out.join(&run),
                    Case {
                        run: &run,
                        inflight: limit,
                        prompt: &prompt.token_ids,
                        outputs: &[512, 128, 256, 256],
                        salt: &run,
                    },
                )
                .await?,
            );
        }
    }
    // Explicit namespace isolation check: identical prefix, same then different salt.
    let cache_salt = format!("p4-cache-{nonce}");
    let mut cache = vec![];
    for (index, salt) in [
        cache_salt.clone(),
        cache_salt.clone(),
        format!("{cache_salt}-isolated"),
    ]
    .iter()
    .enumerate()
    {
        let run = format!("p4-cache-{nonce}-{index}");
        cache.push(
            run_plan(
                &control,
                &session,
                key.trim(),
                &out.join(&run),
                Case {
                    run: &run,
                    inflight: 1,
                    prompt: &prompt.token_ids,
                    outputs: &[8],
                    salt,
                },
            )
            .await?,
        );
    }
    let hits = |r: &Value| {
        r["metrics_delta"]["vllm:prefix_cache_hits_total"]
            .as_f64()
            .unwrap_or(-1.0)
    };
    assert!(
        hits(&cache[1]) > 0.0,
        "same namespace must reuse the cached prefix"
    );
    assert_eq!(
        hits(&cache[2]),
        0.0,
        "new namespace must not reuse the cached prefix"
    );
    let summary = json!({"scope":"real-Chutes-GPU-plus-local-scheduler","phase_three_commit":"fdf8755","session":session,"calibration":runs,"cache_namespace_checks":cache,"real_inference_requests":39,"bitrouter_integrated":false,"tee_attestation_verified_by_this_test":false});
    save(&out.join("acceptance.json"), &summary)?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

async fn interrupt(
    control: &VllmControl,
    session: &VllmSession,
    key: &str,
    out: &Path,
    prompt: &[u32],
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let run = format!("p4-recovery-{}", now_ms());
    let c = cfg(session, &run, 1);
    let p = make_plan(&c, &run, prompt, &[512, 8], &run);
    let path = out.join("journal.sqlite");
    let mut s = Scheduler::open_with_spool(&path, c.clone(), spool_policy())?;
    activate(&mut s, session);
    s.register(p.clone())?;
    save(&out.join("config.json"), &c)?;
    save(&out.join("plan.json"), &p)?;
    let runner = VllmHttpRunner::new(http(session), key)?;
    {
        let mut future = Box::pin(runner.run_until_idle(&mut s));
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            tokio::select! {
                result=&mut future => {
                    return Err(format!("stream ended before interruption: {}",result.is_ok()).into());
                },
                _=tokio::time::sleep(Duration::from_millis(10)) => {
                    let db=rusqlite::Connection::open(&path)?;
                    let progress:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM journal WHERE event_json LIKE '%OUTPUT_PROGRESS%')",[],|r|r.get(0))?;
                    if progress {break;}
                    if Instant::now()>=deadline {return Err("no first progress before interruption deadline".into());}
                }
            }
        }
    }
    let view = s.plan_state(&p.plan_id)?.unwrap();
    assert_eq!(s.snapshot()?.mode, Mode::RecoveryRequired);
    assert_eq!(view.executions[0].dispatch, DispatchState::Unknown);
    assert_eq!(view.executions[1].dispatch, DispatchState::Unsent);
    assert_eq!(s.snapshot()?.capacity.inflight_requests, 1);
    let before = control.state().await?;
    assert!(
        !before
            .traces
            .contains_key(&p.ordered_requests[1].execution_id)
    );
    save(
        &out.join("interrupted.json"),
        &json!({"snapshot":s.snapshot()?,"plan_state":view,"engine_state":before,"original_execution_id":p.ordered_requests[0].execution_id,"next_unsent":p.ordered_requests[1].execution_id}),
    )?;
    println!(
        "Real stream interrupted after durable first progress; UNKNOWN and reservations retained. No second POST."
    );
    Ok(())
}
async fn resume(
    control: &VllmControl,
    session: &VllmSession,
    key: &str,
    out: &Path,
    evidence: &Path,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let old: VllmSession = serde_json::from_slice(&fs::read(out.join("session.json"))?)?;
    let c: SchedulerConfig = serde_json::from_slice(&fs::read(out.join("config.json"))?)?;
    let p: ExecutionPlan = serde_json::from_slice(&fs::read(out.join("plan.json"))?)?;
    let proof: Value = serde_json::from_slice(&fs::read(evidence)?)?;
    if old.profile != session.profile
        || old.engine_epoch == session.engine_epoch
        || proof["old_engine_epoch"] != old.engine_epoch
        || proof["new_engine_epoch"] != session.engine_epoch
        || proof["old_admission_sealed"] != true
        || proof["old_native_idle"] != true
        || proof["old_instance_absent"] != true
        || proof["single_replacement_instance"] != true
        || proof["old_instance_id"] == proof["new_instance_id"]
    {
        return Err("freshness/isolation evidence mismatch".into());
    }
    let mut s = Scheduler::open_with_spool(out.join("journal.sqlite"), c, spool_policy())?;
    s.reconcile_spool("phase4-recovery-prefix-verified".into())?;
    s.record_epoch_isolation(
        old.engine_epoch,
        format!(
            "isolation-{}",
            digest("flex-scheduler/isolation-evidence/v1", &proof)?
        ),
    )?;
    s.discard_unavailable_result(
        &p.ordered_requests[0].execution_id,
        "phase4-unavailable-after-real-isolation".into(),
    )?;
    activate(&mut s, session);
    let runner = VllmHttpRunner::new(http(session), key)?;
    let report = runner.run_until_idle(&mut s).await?;
    assert_eq!(
        report.dispatch_order,
        [p.ordered_requests[1].execution_id.clone()]
    );
    assert_eq!(report.streams[0].protocol, ProtocolStatus::CompleteProtocol);
    let a = s.get_result_artifact(&p.ordered_requests[1].execution_id, "opaque-owner")?;
    save(&out.join("recovered-result.json"), &a)?;
    s.ack_result(
        &a.binding.execution_id,
        "opaque-owner",
        &a.metadata.digest,
        "phase4-recovery-local-sink",
        now_ms(),
    )?;
    s.collect_results(now_ms())?;
    let state = control.state().await?;
    assert!(
        !state
            .traces
            .contains_key(&p.ordered_requests[0].execution_id)
    );
    assert!(
        state
            .traces
            .contains_key(&p.ordered_requests[1].execution_id)
    );
    let events = s.events_after(0, 1000)?;
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == EventKind::DispatchIntent
                && e.binding
                    .as_ref()
                    .is_some_and(|b| b.execution_id == p.ordered_requests[0].execution_id))
            .count(),
        1
    );
    assert_eq!(s.snapshot()?, s.replay_snapshot()?);
    let result = json!({"real_stream_interruption":true,"real_old_instance_isolation":true,"new_engine_epoch":session.engine_epoch,"original_execution_reposts":0,"only_next_unsent_dispatched":true,"report":report,"plan_state":s.plan_state(&p.plan_id)?,"final_snapshot":s.snapshot()?});
    save(&out.join("recovery.json"), &result)?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
