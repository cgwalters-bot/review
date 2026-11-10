//! Direct-read seam for board-forge's disposable cache (#794). No pass state,
//! authority, credentials or response cache is persisted here.

use std::cell::Cell;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, mpsc};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use board_forge::github::{GraphQl, Transport};
use board_forge::pass::{self, Broker, decision};
use board_forge::poll::{Rest, RestResponse};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::state::Section;
use crate::token::TokenSource;

// A preview must not consume an unbounded refresh or API budget. Exhaustion
// becomes missing coverage in board-forge, never permission to act.
const MAX_REQUESTS: usize = 128;
const PASS_TIMEOUT: Duration = Duration::from_secs(45);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_CONFIG: u64 = 1024 * 1024;

#[derive(Clone)]
pub struct Reader {
    config: Arc<String>,
    token: Arc<TokenSource>,
    http: reqwest::Client,
    private: Vec<String>,
    #[cfg(test)]
    api_root: Option<String>,
}

impl Reader {
    pub async fn new(path: &Path, token: Arc<TokenSource>) -> Result<Self> {
        ensure!(
            tokio::fs::metadata(path).await?.len() <= MAX_CONFIG,
            "board config too large"
        );
        let config = tokio::fs::read_to_string(path)
            .await
            .context("reading board config")?;
        ensure!(config.len() as u64 <= MAX_CONFIG, "board config too large");
        // Configuration errors can quote prompts or broker addresses. Do not
        // print them, or pass them into a public section error.
        let parsed =
            pass::Config::parse(&config).map_err(|_| anyhow::anyhow!("invalid board config"))?;
        ensure!(
            parsed.forgejo_board().is_none(),
            "service preview supports GitHub boards only"
        );
        let mut private = Vec::new();
        private_urls(&serde_json::from_str(&config)?, &mut private);
        Ok(Self {
            config: Arc::new(config),
            token,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(REQUEST_TIMEOUT)
                .build()?,
            private,
            #[cfg(test)]
            api_root: None,
        })
    }

    pub async fn refresh(&self, prev: Option<&Section<Value>>, at: &str) -> Section<Value> {
        let reader = self.clone();
        let at_owned = at.to_owned();
        let runtime = tokio::runtime::Handle::current();
        // The exported API includes synchronous transports and non-Send futures.
        // Keep its entire computation off the HTTP runtime's worker threads.
        let result = tokio::task::spawn_blocking(move || -> Result<Value> {
            let config = pass::Config::parse(&reader.config)?;
            let transport = Direct {
                reader,
                runtime: runtime.clone(),
                deadline: Instant::now() + PASS_TIMEOUT,
                requests: Cell::new(0),
                secrets: Arc::new(Mutex::new(Vec::new())),
            };
            let snapshot = runtime.block_on(decision::preview(
                &transport,
                &transport,
                &config,
                // Explicit cache seam: fresh disposable state, until #794
                // exports its reusable cache. Never reconstruct writer state.
                Default::default(),
                Default::default(),
                OffsetDateTime::parse(&at_owned, &Rfc3339)?,
            ))?;
            let mut value = serde_json::to_value(snapshot)?;
            let mut private = transport.reader.private.clone();
            private.extend(transport.secrets.lock().unwrap().iter().cloned());
            redact(&mut value, &private);
            Ok(value)
        })
        .await;
        let result = result.ok().and_then(Result::ok);
        observed(result, prev, at)
    }
}

fn observed(value: Option<Value>, prev: Option<&Section<Value>>, at: &str) -> Section<Value> {
    match value {
        Some(value) => {
            let complete = value["complete"] == true;
            let error = (value["failures"].as_u64().unwrap_or(0) > 0)
                .then(|| "board preview has incomplete reads".to_owned());
            Section {
                items: vec![value],
                complete,
                read_at: Some(at.into()),
                error,
            }
        }
        None => Section {
            complete: false,
            error: Some("board preview unavailable".into()),
            ..prev.cloned().unwrap_or_default()
        },
    }
}

struct Direct {
    reader: Reader,
    runtime: tokio::runtime::Handle,
    deadline: Instant,
    requests: Cell<usize>,
    secrets: Arc<Mutex<Vec<String>>>,
}

impl Direct {
    fn request(
        &self,
        url: &str,
        query: Option<Value>,
        validator: Option<(&str, &str)>,
    ) -> Result<RestResponse> {
        // Prevent a forged pagination URL or a future library path from sending
        // the credential to another origin. Redirects are refused too.
        let url = reqwest::Url::parse(url).context("invalid forge URL")?;
        ensure!(
            url.origin() == reqwest::Url::parse(board_forge::github::API_ROOT)?.origin()
                && url.username().is_empty()
                && url.password().is_none(),
            "forge origin refused"
        );
        self.admit()?;
        #[cfg(test)]
        let url = match &self.reader.api_root {
            Some(root) => reqwest::Url::parse(&format!(
                "{root}{}{}",
                url.path(),
                url.query().map(|q| format!("?{q}")).unwrap_or_default()
            ))?,
            None => url,
        };
        let timeout = REQUEST_TIMEOUT.min(self.deadline.saturating_duration_since(Instant::now()));
        let reader = self.reader.clone();
        let secrets = self.secrets.clone();
        let validator = validator.map(|(k, v)| (k.to_owned(), v.to_owned()));
        let (tx, rx) = mpsc::sync_channel(1);
        self.runtime.spawn(async move {
            let result = tokio::time::timeout(timeout, async {
                let token = reader
                    .token
                    .token()
                    .await
                    .map_err(|_| anyhow::anyhow!("forge token unavailable"))?;
                secrets.lock().unwrap().push(token.clone());
                let mut req = match query {
                    Some(query) => reader.http.post(url).json(&query),
                    None => reader.http.get(url),
                }
                .bearer_auth(token)
                .header("User-Agent", "control-app")
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28");
                if let Some((key, value)) = validator {
                    ensure!(
                        ["if-none-match", "if-modified-since"]
                            .contains(&key.to_ascii_lowercase().as_str()),
                        "validator refused"
                    );
                    req = req.header(key, value);
                }
                let mut response = req
                    .send()
                    .await
                    .map_err(|_| anyhow::anyhow!("forge request failed"))?;
                let header = |key| {
                    response
                        .headers()
                        .get(key)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_owned)
                };
                let mut out = RestResponse {
                    status: response.status().as_u16(),
                    etag: header("etag"),
                    last_modified: header("last-modified"),
                    link: header("link"),
                    body: Value::Null,
                };
                let limited = out.status == 429
                    || (out.status == 403
                        && (response
                            .headers()
                            .get("x-ratelimit-remaining")
                            .is_some_and(|v| v == "0")
                            || response.headers().contains_key("retry-after")));
                let mut body = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| anyhow::anyhow!("forge body failed"))?
                {
                    ensure!(body.len() + chunk.len() <= MAX_BODY, "forge body too large");
                    body.extend_from_slice(&chunk);
                }
                if (200..300).contains(&out.status) {
                    out.body = serde_json::from_slice(&body).context("invalid forge JSON")?;
                } else {
                    out.body = serde_json::from_slice(&body).unwrap_or(Value::Null);
                }
                let message = out.body["message"]
                    .as_str()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if limited || (out.status == 403 && message.contains("rate limit")) {
                    return Err(
                        board_forge::github::RateLimited("forge rate limited".into()).into(),
                    );
                }
                Ok(out)
            })
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("forge read timed out")));
            let _ = tx.send(result);
        });
        rx.recv_timeout(timeout + Duration::from_secs(1))
            .context("forge read timed out")?
    }

    fn admit(&self) -> Result<()> {
        ensure!(
            self.requests.get() < MAX_REQUESTS && Instant::now() < self.deadline,
            "board read bound exhausted"
        );
        self.requests.set(self.requests.get() + 1);
        Ok(())
    }
}

impl Rest for Direct {
    fn get(&self, url: &str, validator: Option<(&str, &str)>) -> Result<RestResponse> {
        read_response(self.request(url, None, validator)?)
    }

    fn send(&self, method: &str, url: &str, _: &Value) -> Result<(u16, Value)> {
        ensure!(
            method == "GET",
            "read-only forge transport rejects writes and dispatch"
        );
        let response = self.request(url, None, None)?;
        Ok((response.status, response.body))
    }

    fn download(&self, _: &str, _: u64) -> Result<Vec<u8>> {
        bail!("board preview downloads unavailable")
    }
}

impl Transport for Direct {
    fn graphql(&self, query: &str, variables: Value) -> Result<Value> {
        ensure!(
            !query
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .any(|word| word == "mutation"),
            "read-only forge transport rejects mutations"
        );
        let response = read_response(self.request(
            "https://api.github.com/graphql",
            Some(json!({"query": query, "variables": variables})),
            None,
        )?)?;
        if response.body["errors"].as_array().is_some_and(|errors| {
            errors.iter().any(|e| {
                ["RATE_LIMITED", "RATE_LIMIT"].contains(&e["type"].as_str().unwrap_or_default())
                    || e["code"] == "graphql_rate_limit"
                    || e["extensions"]["code"] == "RATE_LIMITED"
            })
        }) {
            return Err(board_forge::github::RateLimited("forge query rate limited".into()).into());
        }
        ensure!(
            response.status == 200 && response.body.get("errors").is_none(),
            "forge query unavailable"
        );
        response
            .body
            .get("data")
            .cloned()
            .context("forge query has no data")
    }
}

fn read_response(response: RestResponse) -> Result<RestResponse> {
    match response.status {
        200..=299 | 304 => Ok(response),
        401 => Err(board_forge::github::AuthenticationRequired.into()),
        404 | 410 => Err(board_forge::github::NotFound.into()),
        status => bail!("forge read HTTP {status}"),
    }
}

impl GraphQl for Direct {
    async fn graphql(&self, query: &str, variables: Value) -> Result<Value> {
        Transport::graphql(self, query, variables)
    }
}

impl Broker for Direct {
    fn usage(&self, _: &str) -> Result<Value> {
        bail!("broker evidence unavailable in service preview")
    }

    fn grant(&self, _: &str) -> Result<Value> {
        bail!("broker evidence unavailable in service preview")
    }
}

fn private_urls(value: &Value, private: &mut Vec<String>) {
    match value {
        Value::String(s) => {
            if let Ok(url) = reqwest::Url::parse(s)
                && let Some(host) = url
                    .host_str()
                    .filter(|host| *host != "github.com" && *host != "api.github.com")
            {
                private.push(s.clone());
                private.push(host.to_owned());
            }
        }
        Value::Array(values) => values.iter().for_each(|v| private_urls(v, private)),
        Value::Object(values) => values.values().for_each(|v| private_urls(v, private)),
        _ => (),
    }
}

fn redact(value: &mut Value, private: &[String]) {
    match value {
        Value::String(text) => {
            for secret in private.iter().filter(|s| !s.is_empty()) {
                *text = text.replace(secret, "[redacted]");
            }
            // Published prose is untrusted too: it can carry an older token or
            // a broker address absent from the current caller configuration.
            // Redact the whole prose field rather than risk retaining fragments.
            if CREDENTIAL.is_match(text) || (!public_identity(text) && ADDRESS.is_match(text)) {
                *text = "[redacted]".into();
            }
        }
        Value::Array(values) => values.iter_mut().for_each(|v| redact(v, private)),
        Value::Object(values) => values.values_mut().for_each(|v| redact(v, private)),
        _ => (),
    }
}

static CREDENTIAL: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
    r"(?i)\b(?:gh[pousr]_|github_pat_|sk-|AKIA)[a-z0-9_-]+|\bbearer\s+\S+|\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+"
).unwrap()
});

// Same conservative address classes as the browser publication reader. This
// deliberately also hides prose mentioning filenames that resemble DNS names.
static ADDRESS: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
    r#"(?ix)\b[a-z][a-z0-9+.-]*://[^\s\"'<>]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b|\[[0-9a-f:.%_-]*:[0-9a-f:.%_-]*\]|\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}\b|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4})?|\b[a-z][a-z0-9-]*:\d{1,5}\b|\b(?:lookup|resolve(?:\s+host)?|dial(?:\s+tcp|\s+udp)?|connect(?:\s+to)?|connection\s+to|(?:broker|inference|proxy)\s+at|host|hostname|server|endpoint)(?:\s*[:=]\s*|\s+)[\"'`“‘]?[a-z0-9][a-z0-9_.-]*"#
).unwrap()
});

fn public_identity(text: &str) -> bool {
    // Preserve typed clocks, item identities and canonical public forge links,
    // not arbitrary URLs embedded in prose. These are data, not error messages.
    OffsetDateTime::parse(text, &Rfc3339).is_ok()
        || (text.starts_with("https://github.com/")
            && reqwest::Url::parse(text).is_ok_and(|u| {
                u.host_str() == Some("github.com")
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.query().is_none()
                    && u.fragment().is_none()
                    && !text.chars().any(char::is_whitespace)
            }))
        || (text.contains('#') && board_forge::parse_github_item(text, None, "github.com").is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, extract::State, http::HeaderMap, routing::any};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    const AT: &str = "2026-11-09T12:00:00Z";

    fn config() -> String {
        json!({"operator":"operator", "bot":"robot", "dispatchRepo":"example/runner",
            "dispatchWorkflow":"dispatch.yml", "dispatchRef":"main",
            "board":{"owner":"example", "project":1}, "wip":8,
            "usage":{"repository":"example/ops", "issue":1},
            "pools":{"test": {"target":0.9, "burst":3}}, "planPools":["test"]})
        .to_string()
    }

    fn reader(root: Option<String>, token: TokenSource) -> Reader {
        let mut config: Value = serde_json::from_str(&config()).unwrap();
        if let Some(root) = &root {
            config["usage"]["url"] = root.clone().into();
        }
        Reader {
            config: Arc::new(config.to_string()),
            token: Arc::new(token),
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            private: Vec::new(),
            api_root: root,
        }
    }

    fn direct(reader: Reader) -> Direct {
        Direct {
            reader,
            runtime: tokio::runtime::Handle::current(),
            deadline: Instant::now() + PASS_TIMEOUT,
            requests: Cell::new(0),
            secrets: Arc::new(Mutex::new(Vec::new())),
        }
    }

    #[tokio::test]
    async fn rejects_every_effect_before_network_and_bounds_reads() {
        let client = direct(reader(None, TokenSource::Fixed("fixture".into())));
        for method in ["POST", "PATCH", "DELETE", "PUT", "HEAD"] {
            for path in [
                "issues/1",
                "actions/workflows/dispatch.yml/dispatches",
                "actions/runs/1/rerun",
            ] {
                assert!(
                    client
                        .send(
                            method,
                            &format!("https://api.github.com/{path}"),
                            &Value::Null
                        )
                        .is_err()
                );
            }
        }
        for query in [
            "mutation { x }",
            "# prefix\nmutation M { x }",
            "query { x } mutation M { y }",
        ] {
            assert!(Transport::graphql(&client, query, Value::Null).is_err());
            assert!(GraphQl::graphql(&client, query, Value::Null).await.is_err());
        }
        assert!(client.get("https://other.invalid/page", None).is_err());
        assert!(client.download("https://api.github.com/log", 100).is_err());
        assert!(client.usage("not-an-address").is_err());
        assert!(client.grant("not-an-address").is_err());
        assert_eq!(client.requests.get(), 0);
        client.requests.set(MAX_REQUESTS);
        assert!(client.get("https://api.github.com/user", None).is_err());
        client.requests.set(0);
        let mut client = client;
        client.deadline = Instant::now();
        assert!(client.get("https://api.github.com/user", None).is_err());
    }

    #[derive(Clone, Default)]
    struct Fake {
        partial: Arc<AtomicBool>,
        calls: Arc<AtomicUsize>,
        auth: Arc<Mutex<Vec<String>>>,
        usage: Arc<Mutex<Option<Value>>>,
        items: Arc<Mutex<Vec<Value>>>,
    }

    async fn fake(
        State(fake): State<Fake>,
        uri: axum::extract::OriginalUri,
        headers: HeaderMap,
        body: String,
    ) -> Json<Value> {
        fake.calls.fetch_add(1, Ordering::SeqCst);
        fake.auth
            .lock()
            .unwrap()
            .push(headers["authorization"].to_str().unwrap().to_owned());
        let query: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        if query.is_null() {
            if uri.path().contains("/actions/") {
                return Json(json!({"total_count":0, "workflow_runs":[]}));
            }
            let usage = fake.usage.lock().unwrap().clone();
            return Json(match usage {
                Some(usage) => {
                    json!([{"user":{"login":"robot"}, "body": format!("<!-- bot-usage v1 -->\n```json\n{usage}\n```")}])
                }
                None => json!([]),
            });
        }
        let query = query["query"].as_str().unwrap_or("");
        let data = if query.contains("fragment Board") {
            let items: Vec<Value> = fake.items.lock().unwrap().iter().map(|item| {
                let mut content = item["content"].clone();
                content["labels"]["totalCount"] = json!(1);
                content["closedByPullRequestsReferences"]["totalCount"] = json!(0);
                content["issueDependenciesSummary"] = json!({"blockedBy":0});
                json!({"priority":{"name":"P0"}, "status":{"name":"Ready"}, "why":null, "content":content})
            }).collect();
            json!({"repositoryOwner":{"projectV2":{"field":{"options":[{"name":"P0"}]},
                "items":{"nodes":items, "pageInfo":{"hasNextPage":fake.partial.load(Ordering::SeqCst), "endCursor":null}}}}})
        } else if query.contains("repositoryOwner") {
            json!({"repositoryOwner":{"projectV2":{"id":"P", "url":"https://github.com/orgs/example/projects/1"}}})
        } else if query.contains("fields(first") {
            json!({"node":{"fields":{"nodes":[
                {"id":"S", "name":"Status", "dataType":"SINGLE_SELECT", "options":[{"id":"s", "name":"Ready"}]},
                {"id":"R", "name":"Priority", "dataType":"SINGLE_SELECT", "options":[{"id":"p", "name":"P0"}]}
            ], "pageInfo":{"hasNextPage":false}}}})
        } else {
            json!({"node":{"items":{"nodes":fake.items.lock().unwrap().clone(), "pageInfo":{"hasNextPage":fake.partial.load(Ordering::SeqCst), "endCursor":null}}}})
        };
        Json(json!({"data":data}))
    }

    async fn serve(fake_state: Fake) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(any(fake)).with_state(fake_state),
            )
            .await
            .unwrap();
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn direct_snapshot_cold_lost_partial_and_token_rotation() {
        let fake = Fake::default();
        let root = serve(fake.clone()).await;
        let dir = std::env::temp_dir().join(format!("review-board-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("token");
        std::fs::write(&file, "fixture-one").unwrap();
        let reader = reader(Some(root), TokenSource::File(file.clone()));
        let first = reader.refresh(None, AT).await;
        assert_eq!(first.items.len(), 1, "{first:?}");
        assert_eq!(first.items[0]["schema"], decision::SCHEMA);
        assert_eq!(first.items[0]["observed_at"], AT);
        assert_eq!(first.items[0]["provenance"]["usage"], "missing");
        assert_eq!(
            first.items[0]["confirmed_effects"],
            json!({
                "comments_created":0, "comments_edited":0, "starts":{}, "starts_by_pool":{},
            })
        );
        std::fs::write(&file, "fixture-two").unwrap();
        let lost = reader.refresh(None, AT).await;
        assert_eq!(
            first.items, lost.items,
            "losing disposable state changes no authority"
        );
        let repeated = reader.refresh(Some(&first), AT).await;
        assert_eq!(
            repeated.items, first.items,
            "a prior published view is not a response cache"
        );
        assert!(
            fake.auth
                .lock()
                .unwrap()
                .iter()
                .any(|t| t == "Bearer fixture-two")
        );
        fake.partial.store(true, Ordering::SeqCst);
        let partial = reader.refresh(Some(&first), "2026-11-09T12:01:00Z").await;
        assert!(!partial.complete);
        assert_eq!(partial.read_at.as_deref(), Some("2026-11-09T12:01:00Z"));
        assert!(partial.error.is_some());
        assert!(partial.items[0]["failures"].as_u64().unwrap() > 0);
        fake.partial.store(false, Ordering::SeqCst);
        *fake.usage.lock().unwrap() = Some(json!({"schema":"bot-usage/v1", "updated_at":AT,
            "pools":{"test":{"observed_at":AT,"used_percent":10,"allowed_percent":50,"hold":false}}}));
        let stale_usage = reader.refresh(None, "2026-11-09T14:00:00Z").await;
        assert_eq!(stale_usage.items[0]["provenance"]["usage"], "stale");
        assert_eq!(stale_usage.items[0]["pools"][0]["observed_at"], AT);
        // Failure before the observation exists retains exactly the older
        // evidence, not a freshly timestamped successful empty section.
        let mut invalid = reader.clone();
        invalid.config = Arc::new("{}".into());
        let stale = invalid.refresh(Some(&first), "2026-11-09T12:02:00Z").await;
        assert_eq!(stale.items, first.items);
        assert_eq!(stale.read_at, first.read_at);
        assert!(!stale.complete);
        assert!(stale.error.is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn redirect_and_oversized_response_are_not_consumed() {
        use axum::{http::StatusCode, response::IntoResponse};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let app = Router::new()
                .route(
                    "/redirect",
                    any(|| async {
                        (
                            StatusCode::FOUND,
                            [("location", "https://other.invalid/credential-sink")],
                        )
                            .into_response()
                    }),
                )
                .route("/large", any(|| async { "x".repeat(MAX_BODY + 1) }));
            axum::serve(listener, app).await.unwrap();
        });
        let runtime = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let _guard = runtime.enter();
            let client = direct(reader(
                Some(format!("http://{addr}")),
                TokenSource::Fixed("fixture".into()),
            ));
            assert_eq!(
                client
                    .send("GET", "https://api.github.com/redirect", &Value::Null)
                    .unwrap()
                    .0,
                302
            );
            assert!(client.get("https://api.github.com/redirect", None).is_err());
            assert!(client.get("https://api.github.com/large", None).is_err());
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn preserves_typed_failures_and_status_returning_gets() {
        use axum::{extract::Path, http::StatusCode};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let app = Router::new()
                .route(
                    "/graphql",
                    any(|Json(request): Json<Value>| async move {
                        Json(json!({"errors":[request["variables"]]}))
                    }),
                )
                .route(
                    "/{code}",
                    any(|Path(code): Path<u16>| async move {
                        (
                            StatusCode::from_u16(code).unwrap(),
                            [("x-ratelimit-remaining", "0")],
                            "refusal",
                        )
                    }),
                );
            axum::serve(listener, app).await.unwrap();
        });
        let runtime = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let _guard = runtime.enter();
            let client = direct(reader(
                Some(format!("http://{addr}")),
                TokenSource::Fixed("fixture".into()),
            ));
            for status in [404, 410] {
                let url = format!("https://api.github.com/{status}");
                assert!(
                    client
                        .get(&url, None)
                        .err()
                        .unwrap()
                        .is::<board_forge::github::NotFound>()
                );
                assert_eq!(client.send("GET", &url, &Value::Null).unwrap().0, status);
            }
            assert!(
                client
                    .get("https://api.github.com/401", None)
                    .err()
                    .unwrap()
                    .is::<board_forge::github::AuthenticationRequired>()
            );
            for status in [403, 429] {
                assert!(
                    client
                        .get(&format!("https://api.github.com/{status}"), None)
                        .err()
                        .unwrap()
                        .is::<board_forge::github::RateLimited>()
                );
            }
            for error in [
                json!({"type":"RATE_LIMITED"}),
                json!({"type":"RATE_LIMIT"}),
                json!({"code":"graphql_rate_limit"}),
            ] {
                assert!(
                    Transport::graphql(&client, "query { x }", error)
                        .unwrap_err()
                        .is::<board_forge::github::RateLimited>()
                );
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn populated_generation_round_trips_through_refresh_http_and_sse() {
        use crate::server::tests::next_state;
        use crate::state::{State as ServiceState, tests::Recorded};
        use tokio::sync::watch;

        let fake = Fake::default();
        let old_token = ["gh", "s_", "oldfixturetoken"].concat();
        *fake.usage.lock().unwrap() = Some(json!({"schema":"bot-usage/v1", "updated_at":AT,
        "pools":{
            "test":{"observed_at":AT, "used_percent":10, "allowed_percent":50, "hold":false,
                "reason":"broker at hidden.invalid:123 refused"},
            "token":{"observed_at":AT, "reason":old_token},
            "url":{"observed_at":AT, "reason":"https://unconfigured.invalid/v1 failed"},
            "bare-host":{"observed_at":AT, "reason":"host:privatebroker"},
            "bare-endpoint":{"observed_at":AT, "reason":"endpoint=privatebroker"}
        }}));
        fake.items.lock().unwrap().push(json!({"id":"BI1", "content":{
            "__typename":"Issue", "id":"I1", "number":1, "title":"An operator hold", "state":"OPEN",
            "stateReason":null, "createdAt":AT, "updatedAt":AT, "closedAt":null,
            "repository":{"nameWithOwner":"example/work"},
            "labels":{"nodes":[{"name":"needs-human"}], "pageInfo":{"hasNextPage":false}},
            "assignees":{"nodes":[], "pageInfo":{"hasNextPage":false}},
            "closedByPullRequestsReferences":{"nodes":[], "pageInfo":{"hasNextPage":false}},
            "blockedBy":{"nodes":[], "pageInfo":{"hasNextPage":false}, "totalCount":0}
        }, "fieldValues":{"nodes":[
            {"__typename":"ProjectV2ItemFieldSingleSelectValue", "name":"Ready", "field":{"id":"S", "name":"Status"}},
            {"__typename":"ProjectV2ItemFieldSingleSelectValue", "name":"P0", "field":{"id":"R", "name":"Priority"}}
        ], "pageInfo":{"hasNextPage":false}}}));
        let mut reader = reader(
            Some(serve(fake.clone()).await),
            TokenSource::Fixed("fixture-current".into()),
        );
        let mut config: Value = serde_json::from_str(&reader.config).unwrap();
        config["workRepositories"] = json!(["example/work"]);
        reader.config = Arc::new(config.to_string());
        let (tx, rx) = watch::channel(Arc::new(ServiceState::empty()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, crate::server::router(rx, None, Vec::new()))
                .await
                .unwrap();
        });
        let http = reqwest::Client::new();
        let mut events = http
            .get(format!("http://{addr}/api/events"))
            .send()
            .await
            .unwrap();
        let mut buffer = String::new();
        assert_eq!(next_state(&mut events, &mut buffer).await.0, "0");
        let mut expected: Vec<Value> = Vec::new();
        for generation in 1..=3 {
            fake.partial.store(generation == 2, Ordering::SeqCst);
            let mut source = reader.clone();
            if generation == 3 {
                source.config = Arc::new("{}".into());
            }
            let prev = tx.borrow().clone();
            let clocks = AtomicUsize::new(0);
            let state = crate::refresh_generation(
                &Recorded::fixture(),
                Some(&source),
                None::<(&Recorded, _)>,
                &prev,
                || {
                    // Legacy reads may take long enough that their starting clock
                    // is no longer suitable for assessing the preview's freshness.
                    if clocks.fetch_add(1, Ordering::SeqCst) == 0 {
                        "2026-11-09T10:00:00Z".into()
                    } else {
                        AT.into()
                    }
                },
            )
            .await;
            let value = serde_json::to_value(&state).unwrap();
            assert_eq!(value["generation"], generation);
            assert_eq!(value["decision"]["items"][0]["observed_at"], AT);
            assert_eq!(
                value["decision"]["items"][0]["provenance"]["usage"],
                "observed"
            );
            if generation == 1 {
                assert!(
                    !value["decision"]["items"][0]["holds"]
                        .as_array()
                        .unwrap()
                        .is_empty(),
                    "{value:#}"
                );
                assert_eq!(
                    value["decision"]["items"][0]["pools"][0]["reason"],
                    "[redacted]"
                );
                assert!(
                    value["decision"]["items"][0]["pools"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|pool| pool["reason"] == "[redacted]")
                );
            }
            if generation == 3 {
                assert_eq!(value["decision"]["items"], expected[1]["decision"]["items"]);
                assert_eq!(
                    value["decision"]["readAt"],
                    expected[1]["decision"]["readAt"]
                );
                assert_eq!(value["decision"]["complete"], false);
            }
            tx.send_replace(Arc::new(state));
            let (id, event) = next_state(&mut events, &mut buffer).await;
            let response = http
                .get(format!("http://{addr}/api/v1/state"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert!(!response.contains("hidden.invalid"));
            assert!(!response.contains("unconfigured.invalid"));
            assert!(!response.contains("privatebroker"));
            assert!(!response.contains(&old_token));
            assert_eq!(serde_json::from_str::<Value>(&response).unwrap(), value);
            assert_eq!(event, value);
            assert_eq!(id, generation.to_string());
            expected.push(value);
        }
    }

    #[test]
    fn redacts_credentials_and_configured_addresses_without_changing_evidence() {
        let mut value = json!({"observed_at": AT, "reason":"read private.invalid with fixture-token",
            "nested":["Bearer arbitrary"], "complete":false});
        let mut private = vec!["fixture-token".into()];
        private_urls(
            &json!({"url":"https://private.invalid/usage"}),
            &mut private,
        );
        redact(&mut value, &private);
        assert!(!value.to_string().contains("private.invalid"));
        assert!(!value.to_string().contains("fixture-token"));
        assert!(!value.to_string().contains("arbitrary"));
        assert_eq!(value["observed_at"], AT);
        assert_eq!(value["complete"], false);
    }
}
