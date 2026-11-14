//! Explicit controlled native seller, synthetic tokenizer, and test authority.
use super::*;
use axum::{
    Json,
    extract::State as AxumState,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// Bound for accepted chat/tokenize prompt UTF-8 bytes (catalog unchanged).
const PROMPT_MAX_BYTES: usize = 512;

pub fn authority(buyers: Vec<Buyer>, internal: String) -> Router {
    let tokens: HashMap<_, _> = buyers.into_iter().map(|b| (b.token, json!({"active":true,"sub":b.user,"credential_id":b.credential_id,"kind":"api_key","scope":"inference:invoke"}))).collect();
    Router::new().route(
        "/api/internal/introspect",
        post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let internal = internal.clone();
            let tokens = tokens.clone();
            async move {
                if headers
                    .get("x-internal-service-token")
                    .and_then(|v| v.to_str().ok())
                    != Some(&internal)
                {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                Json(
                    body["token"]
                        .as_str()
                        .and_then(|token| tokens.get(token))
                        .cloned()
                        .unwrap_or(json!({"active":false})),
                )
                .into_response()
            }
        }),
    )
}

struct SellerState {
    credential: String,
    capture: Option<Mutex<PathBuf>>,
}

pub fn seller(credential: String, capture: Option<PathBuf>) -> Router {
    Router::new()
        .route("/v1/chat/completions", post(chat))
        .route(
            "/tokenize",
            post(|Json(body): Json<Value>| async move {
                // Synthetic IDs agree with the controlled seller's fixed usage;
                // they do not implement a tokenizer for any real model.
                if body["tokenizer_ref"] != "controlled/tokenizer-v1"
                    || body["model"] != MODEL
                    || body["protocol"] != "chat_completions"
                    || !prompt_ok(&body["request"]["messages"][0]["content"])
                {
                    return StatusCode::BAD_REQUEST.into_response();
                }
                Json(json!({"tokenizer_ref":"controlled/tokenizer-v1","token_ids":[42,43]}))
                    .into_response()
            }),
        )
        .with_state(Arc::new(SellerState {
            credential,
            capture: capture.map(Mutex::new),
        }))
}

fn prompt_ok(content: &Value) -> bool {
    match content.as_str() {
        Some(s) => (1..=PROMPT_MAX_BYTES).contains(&s.len()),
        None => false,
    }
}

fn capture_request(state: &SellerState, headers: &HeaderMap, body: &Value) {
    let Some(lock) = state.capture.as_ref() else {
        return;
    };
    let Ok(path) = lock.lock() else {
        return;
    };
    let mut header_map = serde_json::Map::new();
    for (name, value) in headers.iter() {
        if let Ok(text) = value.to_str() {
            header_map.insert(name.as_str().to_owned(), json!(text));
        }
    }
    let line = json!({
        "method": "POST",
        "path": "/v1/chat/completions",
        "headers": header_map,
        "body": body,
    });
    let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&*path)
    else {
        return;
    };
    let _ = writeln!(file, "{line}");
}

async fn chat(
    AxumState(state): AxumState<Arc<SellerState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let expected = format!("Bearer {}", state.credential);
    if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(&expected)
        || headers.keys().any(|name| {
            let lower = name.as_str();
            lower.starts_with("x-buyer-")
                || lower.starts_with("x-e2ee-")
                || lower == "x-client-pub-key"
                || lower == "x-model-pub-key"
        })
        || body["model"] != "native-a"
        || body["stream"] != true
        || body["max_completion_tokens"] != 64
        || body["stream_options"]["include_usage"] != true
        || !prompt_ok(&body["messages"][0]["content"])
        || body.as_object().is_none_or(|o| {
            o.keys()
                .any(|k| k.starts_with("bitrouter_") || k == "background")
        })
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    capture_request(&state, &headers, &body);
    let chunk = |choices: Value, usage: Value| {
        format!(
            "data: {}\n\n",
            json!({"id":"controlled-chat","object":"chat.completion.chunk","created":1,"model":"native-a","choices":choices,"usage":usage})
        )
    };
    let output = chunk(
        json!([{"index":0,"delta":{"role":"assistant","content":"verified"},"finish_reason":null}]),
        Value::Null,
    ) + &chunk(
        json!([{"index":0,"delta":{},"finish_reason":"stop"}]),
        Value::Null,
    ) + &chunk(
        json!([]),
        json!({"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}),
    ) + "data: [DONE]\n\n";
    ([("content-type", "text/event-stream")], output).into_response()
}
