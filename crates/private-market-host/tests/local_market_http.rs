#![cfg(feature = "sqlite-tools")]
//! All business mutations in this file cross authenticated HTTP. The catalog,
//! measurements and simulated output are explicit local fixtures.
use bitrouter_market::formal_order::PlaceFormalOrder;
#[allow(dead_code)]
mod common;
#[allow(dead_code)]
#[path = "support/frozen_fixture.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "support/conditional_exchange.rs"]
mod fx;
#[allow(dead_code)]
#[path = "support/local_runtime_fixture.rs"]
mod lf;
#[allow(dead_code)]
#[path = "support/manual_seller_fixture.rs"]
mod mf;
#[allow(dead_code)]
#[path = "support/manual_market_fixture.rs"]
mod mm;
#[allow(dead_code)]
#[path = "support/purchase_fixture.rs"]
mod pf;
#[allow(dead_code)]
#[path = "support/seller_fixture.rs"]
mod sf;
use bitrouter_market::durable::*;
use bitrouter_market::execution_contract::*;
use bitrouter_market::manual_market::*;
use bitrouter_market::order::*;
use bitrouter_market::purchase_order::*;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const BUYER: &str = "test-only-local-buyer-credential-11111111";
const OTHER: &str = "test-only-local-buyer-credential-22222222";
const PROVIDER: &str = "test-only-local-provider-credential-77777777";
const OPERATOR: &str = "test-only-local-operator-credential-00000000";
const ROOT: &str = "/v4/formal-orders/local-buyer";
fn now() -> UnixMillis {
    UnixMillis(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .try_into()
            .unwrap(),
    )
}
fn setup() -> (mm::Dir, ManualMarketConfig, PlaceFormalOrder) {
    let dir = mm::Dir::new();
    let now = now();
    let c = lf::config(now, true);
    std::fs::write(dir.0.join("config.json"), serde_json::to_vec(&c).unwrap()).unwrap();
    let mut entries = Vec::new();
    for (role, token, name) in [
        (lf::BUYER, BUYER, "buyer"),
        (LocalPrincipal::Buyer { buyer_id: 2 }, OTHER, "other"),
        (lf::PROVIDER, PROVIDER, "provider"),
        (lf::OPERATOR, OPERATOR, "operator"),
    ] {
        std::fs::write(dir.0.join(format!("{name}.token")), token).unwrap();
        entries.push(json!({"principal":role,"token_file":format!("{name}.token")}));
    }
    std::fs::write(
        dir.0.join("credentials.json"),
        serde_json::to_vec(&json!({"credentials":entries})).unwrap(),
    )
    .unwrap();
    let mut r = lf::registration("local-buyer", 1);
    r.authorization.tif = TimeInForce::Gtd {
        expires_at: UnixMillis(now.0 + 60_000),
    };
    (dir, c, r)
}
fn command(dir: &mm::Dir, create: bool) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_manual-market-http"));
    cmd.arg("--config")
        .arg(dir.0.join("config.json"))
        .arg("--db")
        .arg(dir.market())
        .arg("--credentials-file")
        .arg(dir.0.join("credentials.json"))
        .arg("--simulation-db")
        .arg(dir.0.join("authority.sqlite"))
        .args(["--listen", "127.0.0.1:0"]);
    if create {
        cmd.args(["--create", "--create-simulation"]);
    }
    cmd
}
struct Server {
    child: Child,
    address: SocketAddr,
}
impl Server {
    fn start(dir: &mm::Dir, create: bool) -> Self {
        let mut child = command(dir, create)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            BufReader::new(stdout).read_line(&mut line).unwrap();
            let _ = tx.send(line);
        });
        let mut s = Self {
            child,
            address: "127.0.0.1:0".parse().unwrap(),
        };
        let line = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        s.address = line
            .split_whitespace()
            .nth(1)
            .expect("server listening address")
            .parse()
            .unwrap();
        let health = s.call(OPERATOR, "GET", "/healthz", None, 200);
        assert_eq!(health["runtime_enabled"], true);
        assert_eq!(health["local_simulation"], true);
        s
    }
    fn call(
        &self,
        token: &str,
        method: &str,
        path: &str,
        body: Option<&Value>,
        status: u16,
    ) -> Value {
        call(self.address, token, method, path, body, status)
    }
    fn stop(mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }
    fn complete(&self) -> Value {
        let end = Instant::now() + Duration::from_secs(8);
        loop {
            let r = self.call(BUYER, "GET", &format!("{ROOT}/results"), None, 200);
            if !r["results"].as_array().unwrap().is_empty() {
                return r;
            }
            assert!(Instant::now() < end, "result did not become available");
            std::thread::sleep(Duration::from_millis(40));
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn call(
    address: SocketAddr,
    token: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    status: u16,
) -> Value {
    let bytes = body
        .map(|b| serde_json::to_vec(b).unwrap())
        .unwrap_or_default();
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(stream,"{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len()).unwrap();
    stream.write_all(&bytes).unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).unwrap();
    let end = bytes.windows(4).position(|b| b == b"\r\n\r\n").unwrap() + 4;
    let actual: u16 = std::str::from_utf8(&bytes[..end])
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(actual, status, "{}", String::from_utf8_lossy(&bytes));
    serde_json::from_slice(&bytes[end..]).unwrap()
}
fn formal_input(r: &PlaceFormalOrder) -> bitrouter_market::formal_order::PlaceFormalOrder {
    bitrouter_market::formal_order::PlaceFormalOrder {
        version: bitrouter_market::formal_order::FORMAL_VERSION,
        idempotency_key: r.idempotency_key.clone(),
        authorization: r.authorization.clone(),
        provider_scope: Default::default(),
        selection: Default::default(),
    }
}
fn qualify(server: &Server, r: &PlaceFormalOrder) -> Value {
    let until = match r.authorization.tif {
        TimeInForce::Gtd { expires_at } => expires_at,
        _ => unreachable!(),
    };
    let input = mm::live_input(UnixMillis(until.0 - 60_000));
    server.call(
        PROVIDER,
        "POST",
        "/v4/manual-seller-orders",
        Some(&serde_json::to_value(input).unwrap()),
        200,
    );
    server.call(
        OPERATOR,
        "POST",
        "/v4/accounts/1/credits",
        Some(&json!({"idempotency_key":"credit","amount":1000})),
        200,
    );
    let original = server.call(
        BUYER,
        "POST",
        "/v4/formal-orders",
        Some(&serde_json::to_value(r).unwrap()),
        200,
    );
    let observed = now();
    let state = bitrouter_market::terms::SupplyState {
        readiness: Readiness::Ready,
        throughput: bitrouter_market::throughput::ThroughputClaim {
            profile_ref: fx::profile("a").reference,
            rate: bitrouter_market::throughput::ThroughputRate {
                output_tokens: 1,
                completed_requests: 1,
                interval_ms: 1000,
            },
        },
        observed_at: observed,
        valid_until: until,
    };
    server.call(PROVIDER,"POST","/v4/supply-declarations",Some(&json!({"idempotency_key":"ready","source":{"market_id":"a","offering_id":11},"generation":1,"state":state})),200);
    assert!(
        server.call(BUYER, "GET", ROOT, None, 200)["order"]["trades"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    std::thread::sleep(Duration::from_millis(1050));
    let mut report = fx::report(30, 1, vec![]);
    report.metadata.observed_at = now();
    report.metadata.valid_until = until;
    server.call(
        OPERATOR,
        "POST",
        "/v4/qualification/scope-reports",
        Some(&json!({"idempotency_key":"scope","evidence":report})),
        200,
    );
    let data: QualificationOfferingContext = serde_json::from_value(server.call(
        OPERATOR,
        "GET",
        "/v4/qualification/offerings/a/11",
        None,
        200,
    ))
    .unwrap();
    let observation = lf::observation(&data, observed, now(), until);
    server.call(
        OPERATOR,
        "POST",
        "/v4/qualification/throughput",
        Some(&json!({"idempotency_key":"throughput","evidence":observation})),
        200,
    );
    let data: QualificationOfferingContext = serde_json::from_value(server.call(
        OPERATOR,
        "GET",
        "/v4/qualification/offerings/a/11",
        None,
        200,
    ))
    .unwrap();
    let window =
        serde_json::from_value(original["order"]["registration_receipt"]["window"].clone())
            .unwrap();
    let quote = lf::quote(r, window, &data, "http-local");
    server.call(
        OPERATOR,
        "POST",
        "/v4/qualification/purchase-quotes",
        Some(&json!({"idempotency_key":"quote","evidence":quote})),
        200,
    );
    original
}

#[test]
fn formal_http_without_router_policy_drives_while_network_reader_is_blocked_and_recovers_result() {
    let (dir, c, r) = setup();
    std::fs::write(dir.0.join("config.json"), serde_json::to_vec(&c).unwrap()).unwrap();
    let server = Server::start(&dir, true);
    let original = qualify(&server, &r);
    let mut slow = TcpStream::connect(server.address).unwrap();
    write!(slow,"POST /v4/formal-orders HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {BUYER}\r\nContent-Length: 1000\r\n\r\n{{").unwrap();
    let started = Instant::now();
    server.call(OPERATOR, "GET", "/healthz", None, 200);
    assert!(started.elapsed() < Duration::from_secs(2));
    // Observe completion solely through SQLite: no read request drives work.
    let conn = rusqlite::Connection::open_with_flags(
        dir.market(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    conn.busy_timeout(Duration::from_secs(2)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let done:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE instr(CAST(payload AS TEXT),'PublishPurchaseResult')>0)",[],|r|r.get(0)).unwrap();
        if done {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(slow);
    drop(conn);
    server.stop();
    let m = DurableMarketHost::open(dir.market()).unwrap();
    let s = m.host().unwrap().snapshot();
    assert_eq!(s.purchase_trades().unwrap().len(), 1);
    let trade = s.purchase_trades().unwrap().values().next().unwrap();
    let id = trade.id.clone();
    let result = s.purchase_result(&id).unwrap().clone();
    assert_eq!(s.accounts()[&1].balance(), MicroUsd(989));
    drop(m);
    let server = Server::start(&dir, false);
    let recovered = server.call(
        BUYER,
        "GET",
        "/v4/formal-orders/local-buyer/results",
        None,
        200,
    );
    assert_eq!(
        recovered["results"][0]["receipt"],
        serde_json::to_value(result.receipt).unwrap()
    );
    let receipt = server.call(
        BUYER,
        "GET",
        &format!("/v4/formal-commands/{}", r.idempotency_key),
        None,
        200,
    );
    assert_eq!(receipt["receipt"], original["receipt"]);
    server.call(
        OTHER,
        "GET",
        &format!("/v4/formal-commands/{}", r.idempotency_key),
        None,
        404,
    );
    let retry = server.call(
        BUYER,
        "POST",
        "/v4/formal-orders",
        Some(&serde_json::to_value(formal_input(&r)).unwrap()),
        200,
    );
    assert_eq!(retry["receipt"], original["receipt"]);
    server.stop();
    let a = DurableAuthority::open(dir.0.join("authority.sqlite")).unwrap();
    assert_eq!(a.task_start_count("exchange", &id).unwrap(), 1);
}

#[test]
fn formal_http_delegation_preserves_agent_binding_and_enforces_permissions() {
    let (dir, c, r) = setup();
    std::fs::write(dir.0.join("config.json"), serde_json::to_vec(&c).unwrap()).unwrap();
    let token = "test-only-delegated-agent-credential-42424242";
    std::fs::write(dir.0.join("agent.token"), token).unwrap();
    let mut creds: Value =
        serde_json::from_slice(&std::fs::read(dir.0.join("credentials.json")).unwrap()).unwrap();
    creds["credentials"].as_array_mut().unwrap().push(json!({"principal":{"role":"buyer_agent","buyer_id":1,"agent_id":42,"can_place":true,"can_close":false},"token_file":"agent.token"}));
    std::fs::write(
        dir.0.join("credentials.json"),
        serde_json::to_vec(&creds).unwrap(),
    )
    .unwrap();
    let server = Server::start(&dir, true);
    let original = server.call(
        token,
        "POST",
        "/v4/formal-orders",
        Some(&serde_json::to_value(formal_input(&r)).unwrap()),
        200,
    );
    assert_eq!(
        original["formal_order"]["receipt"]["submitted_by_agent"],
        42
    );
    server.call(
        token,
        "POST",
        "/v4/formal-orders/local-buyer/close",
        Some(&json!({"idempotency_key":"close","authorization_version":1})),
        403,
    );
    server.call(token, "GET", "/v4/account", None, 403);
    server.stop();
    let server = Server::start(&dir, false);
    assert_eq!(
        server.call(
            token,
            "GET",
            &format!("/v4/formal-commands/{}", r.idempotency_key),
            None,
            200
        )["receipt"],
        original["receipt"]
    );
    server.stop();
}
#[test]
fn shared_process_supports_roles_manual_supply_routing_execution_result_and_account_isolation() {
    let (dir, _, r) = setup();
    let server = Server::start(&dir, true);
    let original = qualify(&server, &r);
    let result = server.complete();
    let state = server.call(BUYER, "GET", ROOT, None, 200);
    assert_eq!(
        state["order"]["registration"],
        serde_json::to_value(&r).unwrap()
    );
    assert_eq!(state["order"]["trades"].as_array().unwrap().len(), 1);
    assert_eq!(result["results"].as_array().unwrap().len(), 1);
    let bytes: Vec<u8> = serde_json::from_value(result["results"][0]["bytes"].clone()).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["text"],
        "explicit-local-fixture-result"
    );
    let retry = server.call(
        BUYER,
        "POST",
        "/v4/formal-orders",
        Some(&serde_json::to_value(&r).unwrap()),
        200,
    );
    assert_eq!(retry["receipt"], original["receipt"]);
    server.call(OTHER, "GET", ROOT, None, 404);
    server.call(OTHER, "GET", &format!("{ROOT}/results"), None, 404);
    server.call(
        OTHER,
        "POST",
        &format!("{ROOT}/close"),
        Some(&json!({"idempotency_key":"steal","authorization_version":1})),
        404,
    );
    server.call(
        BUYER,
        "POST",
        "/v4/accounts/1/credits",
        Some(&json!({"idempotency_key":"steal","authorization_version":1,"amount":1000})),
        403,
    );
    server.call(
        PROVIDER,
        "POST",
        "/v4/qualification/scope-reports",
        Some(&json!({})),
        403,
    );
    server.call(PROVIDER, "GET", ROOT, None, 403);
    server.stop();
    let m = DurableMarketHost::open(dir.market()).unwrap();
    let s = m.host().unwrap().snapshot();
    assert_eq!(s.frozen_grants().unwrap().len(), 1);
    assert_eq!(s.accounts()[&1].held(), MicroUsd(0));
    assert_eq!(s.accounts()[&1].balance(), MicroUsd(989));
}
#[test]
fn idle_process_completes_work_and_restart_preserves_result_and_original_attempt() {
    let (dir, _, r) = setup();
    let server = Server::start(&dir, true);
    qualify(&server, &r);
    // Wait only through a read-only SQLite connection. No HTTP request can
    // accidentally advance the event loop being tested. Replay below verifies
    // that the committed marker actually contains a readable qualified result.
    let conn = rusqlite::Connection::open_with_flags(
        dir.market(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    conn.busy_timeout(Duration::from_secs(2)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let published:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE instr(CAST(payload AS TEXT),'PublishPurchaseResult')>0)",[],|r|r.get(0)).unwrap();
        if published {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "idle runtime did not publish a result"
        );
        std::thread::sleep(Duration::from_millis(40));
    }
    drop(conn);
    server.stop();
    let m = DurableMarketHost::open(dir.market()).unwrap();
    let s = m.host().unwrap().snapshot();
    let trade = s.purchase_trades().unwrap().values().next().unwrap();
    let id = trade.id.clone();
    let result = s.purchase_result(&id).unwrap().clone();
    assert_eq!(
        s.execution_requests()
            .unwrap()
            .values()
            .filter(|r| r.kind == ExecutionRequestKind::Submit)
            .count(),
        1
    );
    drop(m);
    let server = Server::start(&dir, false);
    let recovered = server.complete();
    assert_eq!(
        recovered["results"][0]["receipt"],
        serde_json::to_value(result.receipt).unwrap()
    );
    server.stop();
    let a = DurableAuthority::open(dir.0.join("authority.sqlite")).unwrap();
    assert_eq!(a.task_start_count("exchange", &id).unwrap(), 1);
}
#[test]
fn restart_after_acceptance_continues_the_original_persisted_task() {
    let (dir, mut c, r) = setup();
    c.runtime
        .as_mut()
        .unwrap()
        .simulation
        .as_mut()
        .unwrap()
        .start_after_ms = 1200;
    std::fs::write(dir.0.join("config.json"), serde_json::to_vec(&c).unwrap()).unwrap();
    let server = Server::start(&dir, true);
    qualify(&server, &r);
    let deadline = Instant::now() + Duration::from_secs(3);
    let id = loop {
        let view = server.call(BUYER, "GET", ROOT, None, 200);
        if view["order"]["trades"][0]["accepted_at"].is_number() {
            break view["order"]["trades"][0]["attempt_id"].clone();
        }
        assert!(Instant::now() < deadline);
    };
    server.stop();
    let server = Server::start(&dir, false);
    let result = server.complete();
    assert_eq!(result["results"][0]["receipt"]["attempt_id"], id);
    server.stop();
    let a = DurableAuthority::open(dir.0.join("authority.sqlite")).unwrap();
    assert_eq!(
        a.task_start_count("exchange", &serde_json::from_value(id).unwrap())
            .unwrap(),
        1
    );
}
#[test]
fn credential_ambiguity_runtime_drift_and_missing_simulation_opt_in_fail_closed() {
    let (dir, mut c, _) = setup();
    let path = dir.0.join("credentials.json");
    let original = std::fs::read(&path).unwrap();
    let mut input: Value = serde_json::from_slice(&original).unwrap();
    input["credentials"][1]["token_file"] = input["credentials"][0]["token_file"].clone();
    std::fs::write(&path, serde_json::to_vec(&input).unwrap()).unwrap();
    assert!(!command(&dir, true).output().unwrap().status.success());
    assert!(!dir.market().exists());
    std::fs::write(&path, original).unwrap();
    let server = Server::start(&dir, true);
    server.stop();
    c.runtime.as_mut().unwrap().formal_budget += 1;
    std::fs::write(dir.0.join("config.json"), serde_json::to_vec(&c).unwrap()).unwrap();
    assert!(!command(&dir, false).output().unwrap().status.success());
    let (other, _, _) = setup();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_manual-market-http"));
    cmd.arg("--config")
        .arg(other.0.join("config.json"))
        .arg("--db")
        .arg(other.market())
        .arg("--credentials-file")
        .arg(other.0.join("credentials.json"))
        .arg("--create");
    assert!(!cmd.output().unwrap().status.success());
    assert!(!other.market().exists());
}
