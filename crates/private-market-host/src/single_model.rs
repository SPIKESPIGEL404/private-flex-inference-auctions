//! Optional single-model public surface. Validate before launching dispatch workers.
use super::*;
use axum::{
    body::{Body, to_bytes},
    extract::{Path as RequestPath, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
};

pub const MODEL: &str = "qwen3.8-27b";

pub fn configured(path: &Path) -> Result<bool> {
    match env::var("PRIVATE_MARKET_PUBLIC_MODEL") {
        Err(env::VarError::NotPresent) => Ok(false),
        Ok(value) if value == MODEL => {
            let catalog: Value = live::read(path)?;
            validate_catalog(&catalog)?;
            Ok(true)
        }
        _ => anyhow::bail!("PRIVATE_MARKET_PUBLIC_MODEL must be qwen3.8-27b when set"),
    }
}

fn validate_catalog(catalog: &Value) -> Result<()> {
    let products = catalog["products"]
        .as_array()
        .context("missing public products")?;
    ensure!(
        products.len() == 1,
        "single-model serving requires exactly one product"
    );
    let product = &products[0];
    ensure!(
        product["protocol"] == "chat_completions"
            && product["option"]["model"]["model_ref"] == MODEL,
        "single-model catalog contains a different model or protocol"
    );
    let routes = product["routes"]
        .as_array()
        .context("missing Chutes routes")?;
    ensure!(!routes.is_empty(), "single-model catalog has no routes");
    for route in routes {
        let url = url::Url::parse(route["base_url"].as_str().context("missing route origin")?)?;
        ensure!(
            route["native_model"] == "Qwen/Qwen3.8-27B-FP8"
                && url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port().is_some_and(|port| port > 0)
                && url.path() == "/"
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "single-model serving requires only local verified Chutes routes"
        );
    }
    Ok(())
}

pub fn mount(router: Router, enabled: bool) -> Router {
    if !enabled {
        return router;
    }
    router.route("/v1/provider-evidence/{session_id}", get(provider_evidence))
    .route("/v1/models", get(|| async {
        axum::Json(json!({"object":"list","data":[{"id":MODEL,"object":"model","owned_by":"bitrouter"}]}))
    })).layer(middleware::from_fn_with_state((), guard))
}

async fn provider_evidence(RequestPath(session_id): RequestPath<String>) -> Response {
    if session_id.len() != 64
        || !session_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(directory) = env::var_os("PRIVATE_MARKET_CHUTES_EVIDENCE_DIR") else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let path = Path::new(&directory).join(format!("{session_id}.json"));
    let Ok(metadata) = fs::metadata(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if metadata.len() > 4 * 1024 * 1024 {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let Ok(bytes) = fs::read(path) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if bitrouter_market::persistence_codec::digest(&bytes) != session_id {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let Ok(evidence) = serde_json::from_slice::<Value>(&bytes) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    ([("cache-control", "no-store")], axum::Json(json!({"model":MODEL,"provider":"chutes",
        "format":"chutes-native/v1","session_id":session_id,"verification_scope":"recorded preflight evidence; not a per-request model execution proof",
        "evidence":evidence}))).into_response()
}

async fn guard(State(()): State<()>, mut request: Request, next: Next) -> Response {
    let path = request.uri().path();
    if path.starts_with("/v1/messages") || path.starts_with("/v1/responses") {
        return StatusCode::NOT_FOUND.into_response();
    }
    if path == "/v1/chat/completions" {
        let body = match to_bytes(
            std::mem::replace(request.body_mut(), Body::empty()),
            128 * 1024,
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        };
        let value: Value = match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        };
        if value["model"] != MODEL {
            return (StatusCode::BAD_REQUEST, axum::Json(json!({"error":{"type":"invalid_request_error","code":"model_not_found","message":"The available model is qwen3.8-27b"}}))).into_response();
        }
        *request.body_mut() = Body::from(body);
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn catalog() -> Value {
        json!({"products":[{"protocol":"chat_completions","option":{"model":{"model_ref":MODEL}},
            "routes":[{"native_model":"Qwen/Qwen3.8-27B-FP8","base_url":"http://127.0.0.1:8091/"}]}]})
    }
    #[test]
    fn public_catalog_rejects_other_models_and_plaintext_remote_routes() {
        assert!(validate_catalog(&catalog()).is_ok());
        let mut value = catalog();
        value["products"][0]["option"]["model"]["model_ref"] = "near-model".into();
        assert!(validate_catalog(&value).is_err());
        let mut value = catalog();
        value["products"][0]["routes"][0]["base_url"] = "https://api.chutes.ai".into();
        assert!(validate_catalog(&value).is_err());
        let mut value = catalog();
        value["products"]
            .as_array_mut()
            .unwrap()
            .push(catalog()["products"][0].clone());
        assert!(validate_catalog(&value).is_err());
    }
    #[tokio::test]
    async fn http_surface_lists_one_model_and_rejects_bypass_names() {
        use axum::routing::post;
        let router = mount(
            Router::new().route("/v1/chat/completions", post(|| async { "accepted" })),
            true,
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        let models: Value = client
            .get(format!("{origin}/v1/models"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(models["data"].as_array().unwrap().len(), 1);
        assert_eq!(models["data"][0]["id"], MODEL);
        for model in ["near-model", "Qwen/Qwen3.8-27B-FP8", ""] {
            assert_eq!(
                client
                    .post(format!("{origin}/v1/chat/completions"))
                    .json(&json!({"model":model}))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                400
            );
        }
        assert_eq!(
            client
                .post(format!("{origin}/v1/chat/completions"))
                .json(&json!({"model":MODEL}))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        assert_eq!(
            client
                .post(format!("{origin}/v1/responses"))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        server.abort();
    }
}
