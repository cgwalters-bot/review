//! A read-only GitHub REST client. It has only `get`, so the service can't
//! write with the token it holds. Each GET is conditional on the ETag of
//! the last answer to the same path: an unchanged answer is a 304, which
//! costs no rate budget, and is served from the cache.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::StatusCode;
use reqwest::header::{ACCEPT, AUTHORIZATION, ETAG, HeaderValue, IF_NONE_MATCH, USER_AGENT};
use serde_json::Value;

use crate::token::TokenSource;

pub const API_ROOT: &str = "https://api.github.com";

/// Give up on a request GitHub hasn't answered in this long, as the app does.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

const API_VERSION: &str = "2022-11-28";

/// Where the state's reads come from: GitHub, or recorded answers in tests.
pub trait Source: Sync {
    /// The JSON answer to a GET of `path` (with its query), relative to the API root.
    fn get(&self, path: &str) -> impl Future<Output = Result<Value>> + Send;
}

/// The cached answers by path. `prev` holds the last refresh's, `next`
/// this one's; `sweep` drops what a refresh didn't ask for again, so the
/// cache holds at most two refreshes' answers.
#[derive(Default)]
struct Cache {
    prev: HashMap<String, (String, Value)>,
    next: HashMap<String, (String, Value)>,
}

pub struct Client {
    http: reqwest::Client,
    root: String,
    token: TokenSource,
    cache: Mutex<Cache>,
}

impl Client {
    pub fn new(token: TokenSource, root: &str) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .context("building the HTTP client")?;
        Ok(Self {
            http,
            root: root.trim_end_matches('/').to_owned(),
            token,
            cache: Mutex::default(),
        })
    }

    /// End a refresh: forget answers to paths it didn't read.
    pub fn sweep(&self) {
        let mut cache = self.cache.lock().unwrap();
        cache.prev = std::mem::take(&mut cache.next);
    }

    fn cached(&self, path: &str) -> Option<(String, Value)> {
        let cache = self.cache.lock().unwrap();
        cache
            .next
            .get(path)
            .or_else(|| cache.prev.get(path))
            .cloned()
    }
}

impl Source for Client {
    async fn get(&self, path: &str) -> Result<Value> {
        let cached = self.cached(path);
        let token = self.token.token().await?;
        let mut req = self
            .http
            .get(format!("{}{path}", self.root))
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .header(ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", API_VERSION)
            .header(USER_AGENT, "review-service");
        if let Some((etag, _)) = &cached {
            req = req.header(IF_NONE_MATCH, etag);
        }
        let resp = req.send().await.with_context(|| format!("GET {path}"))?;
        let status = resp.status();
        if status == StatusCode::NOT_MODIFIED {
            let Some((etag, value)) = cached else {
                bail!("GET {path}: HTTP 304 without a cached answer");
            };
            self.cache
                .lock()
                .unwrap()
                .next
                .insert(path.to_owned(), (etag, value.clone()));
            return Ok(value);
        }
        let etag = resp
            .headers()
            .get(ETAG)
            .and_then(|v: &HeaderValue| v.to_str().ok())
            .map(str::to_owned);
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let message = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or(body);
            bail!("GET {path}: HTTP {}: {message}", status.as_u16());
        }
        let value: Value = resp
            .json()
            .await
            .with_context(|| format!("GET {path}: reading the answer"))?;
        if let Some(etag) = etag {
            self.cache
                .lock()
                .unwrap()
                .next
                .insert(path.to_owned(), (etag, value.clone()));
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;

    use super::*;

    /// A GitHub that answers /thing with ETag "v1" and a 304 when asked with it, counting full answers.
    async fn fake_github(full: Arc<AtomicUsize>) -> String {
        let app = Router::new()
            .route(
                "/thing",
                get(move |headers: HeaderMap| async move {
                    if headers.get("if-none-match").is_some_and(|v| v == "\"v1\"") {
                        return StatusCode::NOT_MODIFIED.into_response();
                    }
                    full.fetch_add(1, Ordering::SeqCst);
                    (
                        [("etag", "\"v1\"")],
                        axum::Json(serde_json::json!({"n": 1})),
                    )
                        .into_response()
                }),
            )
            .route(
                "/missing",
                get(|| async {
                    (
                        StatusCode::NOT_FOUND,
                        axum::Json(serde_json::json!({"message": "Not Found"})),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn conditional_requests() {
        let full = Arc::new(AtomicUsize::new(0));
        let client = Client::new(
            TokenSource::Fixed("t".into()),
            &fake_github(full.clone()).await,
        )
        .unwrap();
        for _ in 0..3 {
            assert_eq!(
                client.get("/thing").await.unwrap(),
                serde_json::json!({"n": 1})
            );
            client.sweep();
        }
        assert_eq!(
            full.load(Ordering::SeqCst),
            1,
            "later reads are 304s served from the cache"
        );
        // Two refreshes without reading /thing forget it, so the next read is a full one.
        client.sweep();
        client.sweep();
        client.get("/thing").await.unwrap();
        assert_eq!(full.load(Ordering::SeqCst), 2);
        let err = client.get("/missing").await.unwrap_err().to_string();
        assert_eq!(err, "GET /missing: HTTP 404: Not Found");
    }
}
