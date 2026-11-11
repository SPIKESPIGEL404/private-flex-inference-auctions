#![cfg(feature = "sqlite-tools")]
//! Native-process B2 manual-order transport acceptance. Catalogs are explicit
//! fixtures; these tests make no provider, inference or payment calls.
#[allow(dead_code)]
mod common;
#[allow(dead_code)]
#[path = "support/frozen_fixture.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "support/conditional_exchange.rs"]
mod fx;
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
use bitrouter_market::durable::DurableMarketHost;
use bitrouter_market::manual_market::ManualMarketConfig;
use bitrouter_market::order::UnixMillis;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TOKEN: &str = "explicit-test-only-provider-token-1234567890";
const ORDERS: &str = "/v4/manual-seller-orders";
const ROOT: &str = "/v4/manual-seller-orders/seller-round";
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
fn setup() -> (mm::Dir, ManualMarketConfig, Value) {
    let dir = mm::Dir::new();
    let now = now();
    let config = mm::config(now);
    std::fs::write(
        dir.0.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    std::fs::write(dir.0.join("provider.token"), TOKEN).unwrap();
    (
        dir,
        config,
        serde_json::to_value(mm::live_input(now)).unwrap(),
    )
}
fn command(dir: &mm::Dir, create: bool) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_manual-market-http"));
    command
        .arg("--config")
        .arg(dir.0.join("config.json"))
        .arg("--db")
        .arg(dir.market())
        .args(["--provider-id", "7", "--token-file"])
        .arg(dir.0.join("provider.token"))
        .args(["--listen", "127.0.0.1:0"]);
    if create {
        command.arg("--create");
    }
    command
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
        let mut server = Self {
            child,
            address: "127.0.0.1:0".parse().unwrap(),
        };
        let line = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        server.address = line
            .split_whitespace()
            .nth(1)
            .expect("server must print listening address")
            .parse()
            .unwrap();
        assert_eq!(
            server.call("GET", "/healthz", None, 200)["mode"],
            "manual-market-b2-v1"
        );
        server
    }
    fn call(&self, method: &str, path: &str, body: Option<&Value>, status: u16) -> Value {
        call(self.address, method, path, body, status)
    }
    fn stop(mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn stream(address: SocketAddr) -> TcpStream {
    let s = TcpStream::connect_timeout(&address, Duration::from_secs(3)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
    s.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
    s
}
fn header(method: &str, path: &str, length: usize) -> String {
    format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n")
}
fn response(stream: TcpStream, status: u16) -> Value {
    response_codes(stream, &[status]).1
}
fn response_codes(mut stream: TcpStream, statuses: &[u16]) -> (u16, Value) {
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).unwrap();
    let end = bytes.windows(4).position(|b| b == b"\r\n\r\n").unwrap() + 4;
    let header = std::str::from_utf8(&bytes[..end]).unwrap();
    let actual: u16 = header.split_whitespace().nth(1).unwrap().parse().unwrap();
    assert!(
        statuses.contains(&actual),
        "unexpected status {actual}: {}",
        String::from_utf8_lossy(&bytes)
    );
    assert!(header.contains("Cache-Control: no-store"));
    (actual, serde_json::from_slice(&bytes[end..]).unwrap())
}
fn raw(address: SocketAddr, header: &str, body: &[u8], status: u16) -> Value {
    let mut s = stream(address);
    s.write_all(header.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    response(s, status)
}
fn call(address: SocketAddr, method: &str, path: &str, body: Option<&Value>, status: u16) -> Value {
    let bytes = body
        .map(|b| serde_json::to_vec(b).unwrap())
        .unwrap_or_default();
    raw(address, &header(method, path, bytes.len()), &bytes, status)
}
#[test]
fn lost_response_restart_and_close_preserve_original_receipt_and_one_manual_order() {
    let (dir, _, input) = setup();
    let server = Server::start(&dir, true);
    let bytes = serde_json::to_vec(&input).unwrap();
    let mut s = stream(server.address);
    s.write_all(header("POST", ORDERS, bytes.len()).as_bytes())
        .unwrap();
    s.write_all(&bytes).unwrap();
    s.shutdown(Shutdown::Both).unwrap();
    drop(s); // discard the response; writer admission may still be in flight.
             // Different TCP connections can enqueue in either order. A temporary 404
             // does not prove the earlier POST failed; retain its key and wait for it.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let first = loop {
        let mut read = stream(server.address);
        read.write_all(header("GET", ROOT, 0).as_bytes()).unwrap();
        let (status, value) = response_codes(read, &[200, 404]);
        if status == 200 {
            break value;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "original POST never became visible"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    assert_eq!(first["order"]["submission"], input);
    let receipt = first["order"]["registration_receipt"].clone();
    server.stop();
    let server = Server::start(&dir, false);
    let retry = server.call("POST", ORDERS, Some(&input), 200);
    assert_eq!(retry["receipt"], receipt);
    let closed = server.call(
        "POST",
        &format!("{ROOT}/close"),
        Some(&json!({"idempotency_key":"withdraw-original"})),
        200,
    );
    assert_eq!(closed["order"]["closed"], true);
    assert_eq!(closed["order"]["closure"]["reason"], "closed");
    let closure = closed["order"]["closure"].clone();
    let late = server.call("POST", ORDERS, Some(&input), 200);
    assert_eq!(late["receipt"], receipt);
    assert_eq!(late["order"]["closure"], closure);
    server.stop();
    let server = Server::start(&dir, false);
    assert_eq!(
        server.call("GET", ROOT, None, 200)["order"]["closure"],
        closure
    );
    server.stop();
    let host = DurableMarketHost::open(dir.market()).unwrap();
    let snapshot = host.host().unwrap().snapshot();
    assert_eq!(snapshot.manual_seller_orders().unwrap().len(), 1);
    assert_eq!(snapshot.sells().len(), 1);
    assert!(snapshot.frozen_grants().unwrap().is_empty());
    assert!(snapshot.execution_requests().unwrap().is_empty());
}
#[test]
fn concurrent_duplicate_posts_share_one_writer_and_conflicting_content_is_rejected() {
    let (dir, _, input) = setup();
    let server = Server::start(&dir, true);
    let mut threads = Vec::new();
    for _ in 0..12 {
        let input = input.clone();
        let address = server.address;
        threads.push(std::thread::spawn(move || {
            call(address, "POST", ORDERS, Some(&input), 200)["receipt"].clone()
        }));
    }
    let receipts: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert!(receipts.iter().all(|r| r == &receipts[0]));
    let mut conflict = input.clone();
    conflict["order"]["opportunity_id"] = json!("changed-opportunity");
    server.call("POST", ORDERS, Some(&conflict), 409);
    let mut alternate = input;
    alternate["idempotency_key"] = json!("alternate-transport-key");
    assert_eq!(
        server.call("POST", ORDERS, Some(&alternate), 200)["receipt"],
        receipts[0]
    );
    server.stop();
    let host = DurableMarketHost::open(dir.market()).unwrap();
    assert_eq!(
        host.host()
            .unwrap()
            .snapshot()
            .manual_seller_orders()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn transport_enforces_credentials_provider_identity_strict_json_and_no_control_routes() {
    let (dir, _, input) = setup();
    let server = Server::start(&dir, true);
    let h = header("GET", "/healthz", 0);
    raw(
        server.address,
        &h.replace(&format!("Authorization: Bearer {TOKEN}\r\n"), ""),
        b"",
        401,
    );
    raw(
        server.address,
        &h.replace(TOKEN, "incorrect-test-credential"),
        b"",
        401,
    );
    raw(
        server.address,
        &h.replace(
            "Connection: close",
            "Origin: http://localhost\r\nConnection: close",
        ),
        b"",
        403,
    );
    let before = server.call("GET", "/healthz", None, 200)["revision"].clone();
    let mut bad = input.clone();
    bad["order"]["reference"]["owner_id"] = json!(999);
    server.call("POST", ORDERS, Some(&bad), 403);
    let duplicate = br#"{"version":1,"version":1}"#;
    raw(
        server.address,
        &header("POST", ORDERS, duplicate.len()),
        duplicate,
        400,
    );
    let mut forged = input;
    forged["accepted_at"] = json!(now().0);
    server.call("POST", ORDERS, Some(&forged), 400);
    server.call("POST", "/v4/control/credit", Some(&json!({})), 404);
    server.call("POST", "/v4/execution/report", Some(&json!({})), 404);
    server.call("GET", ROOT, None, 404);
    assert_eq!(
        server.call("GET", "/healthz", None, 200)["revision"],
        before
    );
}
#[test]
fn unsupported_http_framing_and_oversized_bodies_fail_before_any_market_command() {
    let (dir, _, _) = setup();
    let server = Server::start(&dir, true);
    for (extra, status) in [
        ("Content-Length: 0\r\nContent-Length: 0\r\n", 400),
        ("Transfer-Encoding: chunked\r\n", 400),
        ("Content-Length: 1048577\r\n", 413),
        ("Content-Length: +2\r\n", 400),
        (
            "Content-Length: 0\r\nAuthorization: Bearer duplicate\r\n",
            400,
        ),
    ] {
        let h = format!("POST {ORDERS} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\n{extra}\r\n");
        raw(server.address, &h, b"", status);
    }
    assert_eq!(server.call("GET", "/healthz", None, 200)["revision"], 0);
}
#[test]
fn idle_process_expires_ioc_without_a_request_and_restart_keeps_original_window() {
    let (dir, mut config, mut input) = setup();
    config.purchase_policy.time.immediate_decision_window_ms = 200;
    config.purchase_policy.time.immediate_total_window_ms = 400;
    std::fs::write(
        dir.0.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    input["order"]["tif"] = json!({"kind":"ioc"});
    let server = Server::start(&dir, true);
    let r = server.call("POST", ORDERS, Some(&input), 200);
    std::thread::sleep(Duration::from_millis(1000)); // no HTTP during the timer interval
    server.stop();
    let host = DurableMarketHost::open(dir.market()).unwrap();
    let snapshot = host.host().unwrap().snapshot();
    let order = snapshot.seller_orders().unwrap().values().next().unwrap();
    assert!(order.closure().is_some());
    assert!(order.closure().unwrap().at >= order.receipt().window.decision_before);
    assert_eq!(
        serde_json::to_value(order.receipt().window).unwrap(),
        r["receipt"]["registration"]["window"]
    );
    drop(host);
    let server = Server::start(&dir, false);
    let retry = server.call("POST", ORDERS, Some(&input), 200);
    assert_eq!(retry["receipt"], r["receipt"]);
    assert_eq!(retry["order"]["closed"], true);
}
#[test]
fn second_writer_create_existing_and_changed_config_fail_without_destroying_history() {
    let (dir, mut config, input) = setup();
    let server = Server::start(&dir, true);
    let receipt = server.call("POST", ORDERS, Some(&input), 200)["receipt"].clone();
    assert!(!command(&dir, false).output().unwrap().status.success());
    assert!(!command(&dir, true).output().unwrap().status.success());
    server.stop();
    config.purchase_policy.time.grant_acceptance_window_ms += 1;
    std::fs::write(
        dir.0.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    assert!(!command(&dir, false).output().unwrap().status.success());
    let host = DurableMarketHost::open(dir.market()).unwrap();
    assert_eq!(
        serde_json::to_value(
            host.host()
                .unwrap()
                .snapshot()
                .manual_seller_orders()
                .unwrap()
                .values()
                .next()
                .unwrap()
                .receipt()
        )
        .unwrap(),
        receipt
    );
}
#[test]
fn total_request_deadline_bounds_trickled_body_and_writer_remains_available() {
    let (dir, _, _) = setup();
    let server = Server::start(&dir, true);
    let mut s = stream(server.address);
    s.write_all(header("POST", ORDERS, 100).as_bytes()).unwrap();
    let mut writer = s.try_clone().unwrap();
    let start = Instant::now();
    let worker = std::thread::spawn(move || {
        for _ in 0..10 {
            if writer.write_all(b" ").is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(400));
        }
    });
    response(s, 408);
    assert!(start.elapsed() < Duration::from_secs(5));
    worker.join().unwrap();
    assert_eq!(server.call("GET", "/healthz", None, 200)["revision"], 0);
}
