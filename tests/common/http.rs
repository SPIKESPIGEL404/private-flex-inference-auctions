#![allow(dead_code)]
use flex_scheduler::*;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
    task::{JoinHandle, JoinSet},
};

#[derive(Clone)]
pub enum Step {
    Bytes(Vec<u8>),
    Delay(u64),
    Wait(Arc<Notify>),
    Signal(Arc<Notify>),
    AbruptClose,
}

#[derive(Clone)]
pub struct Script {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub steps: Vec<Step>,
    pub header_delay_ms: u64,
}

impl Script {
    pub fn sse(bytes: Vec<u8>) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), "text/event-stream".into())],
            steps: vec![Step::Bytes(bytes)],
            header_delay_ms: 0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Capture {
    pub target: String,
    pub headers: String,
    pub body: Value,
}

pub struct MockServer {
    pub endpoint: String,
    pub captures: Arc<Mutex<Vec<Capture>>>,
    task: JoinHandle<()>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockServer {
    pub async fn start(scripts: BTreeMap<String, Script>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/completions", listener.local_addr().unwrap());
        let captures = Arc::new(Mutex::new(Vec::new()));
        let saved = captures.clone();
        let scripts = Arc::new(scripts);
        let task = tokio::spawn(async move {
            let mut clients = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break };
                        let scripts = scripts.clone(); let captures = saved.clone();
                        clients.spawn(async move { let _ = serve(socket, &scripts, captures).await; });
                    }
                    Some(_) = clients.join_next() => {}
                }
            }
        });
        Self {
            endpoint,
            captures,
            task,
        }
    }

    pub fn count(&self) -> usize {
        self.captures.lock().unwrap().len()
    }
}

async fn serve(
    mut socket: TcpStream,
    scripts: &BTreeMap<String, Script>,
    captures: Arc<Mutex<Vec<Capture>>>,
) -> std::io::Result<()> {
    socket.set_nodelay(true)?;
    let mut bytes = vec![];
    let header_end;
    loop {
        let mut buffer = [0; 4096];
        let n = socket.read(&mut buffer).await?;
        if n == 0 || bytes.len() + n > 65_536 {
            return Ok(());
        }
        bytes.extend_from_slice(&buffer[..n]);
        if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = i + 4;
            break;
        }
    }
    let headers = String::from_utf8_lossy(&bytes[..header_end]).to_string();
    let length: usize = headers
        .lines()
        .find_map(|l| {
            l.split_once(':')
                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        })
        .and_then(|(_, v)| v.trim().parse().ok())
        .unwrap_or(0);
    if length > 65_536 {
        return Ok(());
    }
    while bytes.len() < header_end + length {
        let mut buffer = [0; 4096];
        let n = socket.read(&mut buffer).await?;
        if n == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&buffer[..n]);
    }
    let body: Value =
        serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap_or(Value::Null);
    let execution = body.get("request_id").and_then(Value::as_str).unwrap_or("");
    let script = scripts.get(execution).cloned().unwrap_or(Script {
        status: 500,
        headers: vec![],
        steps: vec![],
        header_delay_ms: 0,
    });
    let target = headers.lines().next().unwrap_or("").to_string();
    captures.lock().unwrap().push(Capture {
        target,
        headers,
        body,
    });
    tokio::time::sleep(Duration::from_millis(script.header_delay_ms)).await;
    let mut header = format!(
        "HTTP/1.1 {} Mock\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n",
        script.status
    );
    for (k, v) in script.headers {
        header.push_str(&format!("{k}: {v}\r\n"));
    }
    header.push_str("\r\n");
    socket.write_all(header.as_bytes()).await?;
    for step in script.steps {
        match step {
            Step::Bytes(bytes) => {
                if !bytes.is_empty() {
                    socket
                        .write_all(format!("{:x}\r\n", bytes.len()).as_bytes())
                        .await?;
                    socket.write_all(&bytes).await?;
                    socket.write_all(b"\r\n").await?;
                }
            }
            Step::Delay(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
            Step::Wait(signal) => signal.notified().await,
            Step::Signal(signal) => signal.notify_one(),
            Step::AbruptClose => return Ok(()),
        }
    }
    socket.write_all(b"0\r\n\r\n").await?;
    socket.shutdown().await
}

pub fn config(endpoint: &str) -> MockHttpConfig {
    MockHttpConfig {
        endpoint: endpoint.into(),
        served_model: "mock-model".into(),
        model_profile_id: "fixture-only-no-gpu".into(),
        connect_timeout_ms: 1000,
        first_progress_timeout_ms: 2000,
        idle_timeout_ms: 2000,
        total_timeout_ms: 5000,
        max_line_bytes: 16_384,
        max_event_bytes: 32_768,
        max_stream_bytes: 131_072,
        max_live_streams: 2,
        event_queue_capacity: 1,
    }
}

pub fn frame(value: Value) -> Vec<u8> {
    format!("data: {}\n\n", value).into_bytes()
}

pub fn choice(execution: &str, ids: Vec<u32>, text: &str, finish: Option<&str>) -> Value {
    json!({"id": format!("cmpl-{execution}"), "object": "text_completion", "model": "mock-model", "created": 1,
        "choices": [{"index": 0, "text": text, "token_ids": ids, "finish_reason": finish}]})
}

pub fn usage(execution: &str, count: u64) -> Value {
    json!({"id": format!("cmpl-{execution}"), "object": "text_completion", "model": "mock-model", "choices": [],
        "usage": {"prompt_tokens": 3, "completion_tokens": count, "total_tokens": count+3,
            "prompt_tokens_details": {"cached_tokens": 0}}})
}

pub fn success(execution: &str) -> Vec<u8> {
    [
        frame(choice(execution, vec![99], "世", Some("stop"))),
        frame(usage(execution, 1)),
        b"data: [DONE]\n\n".to_vec(),
    ]
    .concat()
}
