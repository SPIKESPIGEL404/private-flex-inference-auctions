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

pub fn seller(credential: String) -> Router {
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
                    || body["request"]["messages"][0]["content"]
                        != "Batch A public synthetic prompt"
                {
                    return StatusCode::BAD_REQUEST.into_response();
                }
                Json(json!({"tokenizer_ref":"controlled/tokenizer-v1","token_ids":[42,43]}))
                    .into_response()
            }),
        )
        .with_state(credential)
}

async fn chat(
    AxumState(credential): AxumState<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let expected = format!("Bearer {credential}");
    if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(&expected)
        || body["model"] != "native-a"
        || body["stream"] != true
        || body["max_completion_tokens"] != 64
        || body["stream_options"]["include_usage"] != true
        || body["messages"][0]["content"] != "Batch A public synthetic prompt"
        || body.as_object().is_none_or(|o| {
            o.keys()
                .any(|k| k.starts_with("bitrouter_") || k == "background")
        })
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
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
