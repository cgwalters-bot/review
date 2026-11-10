//! Optional operator-only Forgejo reads. No response URL is ever requested.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Result, bail};
use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::state::Section;
use crate::token::TokenSource;

const PAGE_SIZE: usize = 50;
const MAX_PAGES: usize = 3;
const MAX_REQUESTS: usize = 64;
const MAX_BODY: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const REFRESH_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Default)]
pub struct Config {
    pub base_url: Option<String>,
    pub token_file: Option<PathBuf>,
    pub organizations: Vec<String>,
    pub labels: Vec<String>,
    pub reviewer: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Request;
    use axum::response::{IntoResponse, Response};
    use axum::{Json, Router};
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    const AT: &str = "2026-01-01T00:00:00Z";

    async fn serve(handler: impl Fn(Request) -> Response + Send + Sync + 'static) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(move |req: Request| {
                    let handler = handler.clone();
                    async move { handler(req) }
                }),
            )
            .await
            .unwrap();
        });
        format!("http://{addr}")
    }

    fn config(root: &str, file: PathBuf) -> Config {
        Config {
            base_url: Some(root.into()),
            token_file: Some(file),
            organizations: vec!["sample-team".into()],
            labels: vec!["gate-a".into(), "gate-b".into()],
            reviewer: Some("sample-reviewer".into()),
        }
    }

    fn token() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let file = std::env::temp_dir().join(format!(
            "forgejo-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::write(&file, "fixture-one").unwrap();
        file
    }

    fn repo(owner: &str, name: &str) -> Value {
        json!({"name": name, "owner": {"login": owner}, "html_url": "https://foreign.invalid/ignored"})
    }

    fn issue(n: u64, label: &str) -> Value {
        json!({"number": n, "title": "Fabricated issue", "state": "open", "updated_at": AT,
            "labels": [{"name":label}], "html_url": "https://foreign.invalid/ignored"})
    }

    fn pull(n: u64, reviewer: &str) -> Value {
        json!({"number": n, "title": "Fabricated pull", "state": "open", "updated_at": AT,
            "requested_reviewers": [{"login": reviewer}]})
    }

    #[test]
    fn configuration_is_explicit_and_disabled_by_default() {
        assert!(Config::default().reader().unwrap().is_none());
        assert!(
            Config {
                base_url: Some("https://forge.invalid".into()),
                ..Default::default()
            }
            .reader()
            .is_err()
        );
        for base in [
            "http://forge.invalid",
            "https://user:pass@forge.invalid",
            "https://forge.invalid/?q=x",
            "https://forge.invalid/#x",
            "file:///tmp/forge",
        ] {
            assert!(config(base, "unused".into()).reader().is_err(), "{base}");
        }
        let mut c = config("https://forge.invalid", "unused".into());
        c.organizations = vec!["../other".into()];
        assert!(c.reader().is_err());
    }

    #[tokio::test]
    async fn filters_types_deduplicates_and_confines_organizations() {
        let paths = Arc::new(Mutex::new(Vec::new()));
        let recorded = paths.clone();
        let root = serve(move |req| {
            assert_eq!(req.method(), "GET");
            recorded.lock().unwrap().push(req.uri().path().to_owned());
            let value = match req.uri().path() {
                "/api/v1/orgs/sample-team/repos" => json!([
                    repo("sample-team", "project"),
                    repo("SAMPLE-TEAM", "project"),
                    repo("foreign-team", "secret")
                ]),
                "/api/v1/repos/sample-team/project/issues" => {
                    let mut pr = issue(4, "gate-a");
                    pr["pull_request"] = json!({"url":"https://foreign.invalid"});
                    let mut closed = issue(5, "gate-a");
                    closed["state"] = json!("closed");
                    json!([
                        issue(1, "gate-a"),
                        issue(2, "gate-b"),
                        issue(3, "other"),
                        pr,
                        closed,
                        issue(1, "gate-a")
                    ])
                }
                "/api/v1/repos/sample-team/project/pulls" => {
                    let mut closed = pull(8, "sample-reviewer");
                    closed["state"] = json!("closed");
                    json!([
                        pull(1, "SAMPLE-REVIEWER"),
                        pull(6, "other"),
                        pull(7, "sample-reviewer"),
                        closed
                    ])
                }
                path => panic!("unexpected path {path}"),
            };
            Json(value).into_response()
        })
        .await;
        let file = token();
        let reader = config(&root, file.clone()).reader().unwrap().unwrap();
        let section = reader.refresh(None, AT).await;
        assert!(
            !section.complete,
            "foreign repository is incomplete evidence"
        );
        assert_eq!(section.items.len(), 4);
        assert_eq!(
            section
                .items
                .iter()
                .filter(|i| i.identity.kind == Kind::Issue)
                .count(),
            2
        );
        assert!(section.items.iter().all(|i| i.url.starts_with(&root)));
        assert_eq!(paths.lock().unwrap().len(), 3);
        let serialized = serde_json::to_string(&section).unwrap();
        assert!(!serialized.contains("foreign.invalid"));
        assert!(!serialized.contains("fixture-one"));
        std::fs::remove_file(file).unwrap();
    }

    #[tokio::test]
    async fn pagination_caps_and_request_budget() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let root = serve(move |req| {
            count.fetch_add(1, Ordering::SeqCst);
            assert!(req.uri().query().unwrap().contains("limit=50"));
            let items: Vec<Value> = if req.uri().path().contains("/orgs/") {
                (0..PAGE_SIZE)
                    .map(|n| repo("sample-team", &format!("project-{n}")))
                    .collect()
            } else if req.uri().path().ends_with("/issues") {
                (1..=PAGE_SIZE as u64).map(|n| issue(n, "gate-a")).collect()
            } else {
                Vec::new()
            };
            Json(items).into_response()
        })
        .await;
        let file = token();
        let reader = config(&root, file.clone()).reader().unwrap().unwrap();
        let section = reader.refresh(None, AT).await;
        assert!(!section.complete);
        assert_eq!(calls.load(Ordering::SeqCst), MAX_REQUESTS);
        assert!(section.error.unwrap().contains("limit"));
        assert!(section.items.len() <= MAX_REQUESTS * PAGE_SIZE);
        std::fs::remove_file(file).unwrap();
    }

    #[tokio::test]
    async fn second_page_failure_and_full_final_page_are_incomplete() {
        let mode = Arc::new(AtomicUsize::new(0));
        let control = mode.clone();
        let pages = Arc::new(Mutex::new(Vec::new()));
        let seen = pages.clone();
        let root = serve(move |req| {
            if req.uri().path().contains("/orgs/") {
                return Json(json!([repo("sample-team", "project")])).into_response();
            }
            if req.uri().path().ends_with("/pulls") {
                return Json(json!([])).into_response();
            }
            let query = req.uri().query().unwrap();
            let page: usize = query.rsplit_once("page=").unwrap().1.parse().unwrap();
            seen.lock().unwrap().push(page);
            if page == 2 && control.load(Ordering::SeqCst) == 1 {
                return axum::http::StatusCode::BAD_GATEWAY.into_response();
            }
            let count = if page == 2 && control.load(Ordering::SeqCst) == 0 {
                1
            } else {
                PAGE_SIZE
            };
            Json(
                (1..=count)
                    .map(|n| issue(((page - 1) * PAGE_SIZE + n) as u64, "gate-a"))
                    .collect::<Vec<_>>(),
            )
            .into_response()
        })
        .await;
        let file = token();
        let reader = config(&root, file.clone()).reader().unwrap().unwrap();
        let first = reader.refresh(None, AT).await;
        assert!(first.complete);
        assert_eq!(first.items.len(), PAGE_SIZE + 1);
        assert_eq!(*pages.lock().unwrap(), [1, 2]);
        mode.store(1, Ordering::SeqCst);
        let failed = reader.refresh(Some(&first), "later").await;
        assert!(!failed.complete);
        assert_eq!(failed.items.len(), PAGE_SIZE);
        assert_eq!(failed.read_at.as_deref(), Some("later"));
        mode.store(2, Ordering::SeqCst);
        pages.lock().unwrap().clear();
        let capped = reader.refresh(None, AT).await;
        assert!(!capped.complete);
        assert_eq!(capped.items.len(), PAGE_SIZE * MAX_PAGES);
        assert_eq!(*pages.lock().unwrap(), [1, 2, 3]);
        std::fs::remove_file(file).unwrap();
    }

    #[tokio::test]
    async fn short_pages_honor_counts_and_next_relations_without_following_urls() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let root = serve(move |req| {
            count.fetch_add(1, Ordering::SeqCst);
            let page = req.uri().query().unwrap().rsplit_once("page=").unwrap().1;
            assert!(matches!(page, "1" | "2"));
            let n = if page == "1" { 1 } else { 2 };
            let items = if req.uri().path().contains("/orgs/") {
                json!([repo("sample-team", &format!("project-{n}"))])
            } else if req.uri().path().ends_with("/issues") {
                json!([issue(n, "gate-a")])
            } else {
                json!([pull(n + 2, "sample-reviewer")])
            };
            // The API-enforced limit is one, despite our requested limit of 50.
            // Issues advertise only a total; PRs only a next relation. Repos both.
            let mut response = Json(items).into_response();
            if !req.uri().path().ends_with("/pulls") {
                response
                    .headers_mut()
                    .insert("x-total-count", "2".parse().unwrap());
            }
            if page == "1" && !req.uri().path().ends_with("/issues") {
                response.headers_mut().insert(
                    "link",
                    "<https://foreign.invalid/do-not-fetch>; rel=\"next\""
                        .parse()
                        .unwrap(),
                );
            }
            response
        })
        .await;
        let file = token();
        let reader = config(&root, file.clone()).reader().unwrap().unwrap();
        let section = reader.refresh(None, AT).await;
        assert!(section.complete);
        assert_eq!(section.items.len(), 8);
        assert_eq!(calls.load(Ordering::SeqCst), 10);
        std::fs::remove_file(file).unwrap();
    }

    #[tokio::test]
    async fn refresh_deadline_retains_successful_pages() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(|req: Request| async move {
                    if req.uri().path().contains("/orgs/") {
                        return Json(json!([repo("sample-team", "project")])).into_response();
                    }
                    assert!(req.uri().path().ends_with("/issues"));
                    if req.uri().query().unwrap().ends_with("page=2") {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                    Json(
                        (1..=PAGE_SIZE as u64)
                            .map(|n| issue(n, "gate-a"))
                            .collect::<Vec<_>>(),
                    )
                    .into_response()
                }),
            )
            .await
            .unwrap();
        });
        let file = token();
        let mut reader = config(&format!("http://{addr}"), file.clone())
            .reader()
            .unwrap()
            .unwrap();
        reader.refresh_timeout = Duration::from_millis(200);
        let prior_item = reader.item(
            "sample-team/project",
            Kind::Issue,
            999,
            "prior".into(),
            AT.into(),
        );
        let prior = Section {
            items: vec![prior_item],
            complete: true,
            read_at: Some("prior".into()),
            error: None,
        };
        let section = reader.refresh(Some(&prior), AT).await;
        assert!(!section.complete);
        assert!(section.error.is_some());
        assert_eq!(section.read_at.as_deref(), Some(AT));
        assert_eq!(section.items.len(), PAGE_SIZE);
        assert!(
            section
                .items
                .iter()
                .all(|i| i.identity.number <= PAGE_SIZE as u64)
        );
        task.abort();
        std::fs::remove_file(file).unwrap();
    }

    #[tokio::test]
    async fn slow_requests_are_bounded() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(|| async {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    Json(json!([]))
                }),
            )
            .await
            .unwrap();
        });
        let file = token();
        let mut reader = config(&format!("http://{addr}"), file.clone())
            .reader()
            .unwrap()
            .unwrap();
        reader.http = reqwest::Client::builder()
            .timeout(Duration::from_millis(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        assert!(reader.get::<Value>(reader.url(&["slow"])).await.is_err());
        task.abort();
        std::fs::remove_file(file).unwrap();
    }

    #[tokio::test]
    async fn partial_total_failure_and_rotation() {
        let mode = Arc::new(AtomicUsize::new(0));
        let control = mode.clone();
        let auth = Arc::new(Mutex::new(Vec::new()));
        let seen = auth.clone();
        let root = serve(move |req| {
            seen.lock()
                .unwrap()
                .push(req.headers()["authorization"].to_str().unwrap().to_owned());
            let mode = control.load(Ordering::SeqCst);
            if mode == 2
                || (mode == 1 && req.uri().path().ends_with("/pulls"))
                || (mode == 3 && !req.uri().path().contains("/orgs/"))
            {
                return (
                    axum::http::StatusCode::FORBIDDEN,
                    "private error body must not escape",
                )
                    .into_response();
            }
            Json(if req.uri().path().contains("/orgs/") {
                json!([repo("sample-team", "project")])
            } else if req.uri().path().ends_with("/issues") {
                json!([issue(1, "gate-b")])
            } else {
                json!([pull(2, "sample-reviewer")])
            })
            .into_response()
        })
        .await;
        let file = token();
        let reader = config(&root, file.clone()).reader().unwrap().unwrap();
        let first = reader.refresh(None, AT).await;
        assert!(first.complete);
        assert_eq!(first.items.len(), 2);
        std::fs::write(&file, "fixture-two").unwrap();
        mode.store(1, Ordering::SeqCst);
        let partial = reader.refresh(Some(&first), "later").await;
        assert!(!partial.complete);
        assert_eq!(partial.items.len(), 1);
        assert_eq!(partial.read_at.as_deref(), Some("later"));
        for m in [2, 3] {
            mode.store(m, Ordering::SeqCst);
            let failed = reader.refresh(Some(&first), "later").await;
            assert!(!failed.complete);
            assert_eq!(failed.items.len(), 2);
            assert_eq!(failed.read_at, first.read_at);
            assert!(!failed.error.unwrap().contains("private"));
            let empty = reader.refresh(None, "later").await;
            assert!(empty.read_at.is_none());
        }
        let seen = auth.lock().unwrap();
        assert_eq!(&seen[..3], &["Bearer fixture-one"; 3]);
        assert!(seen[3..].iter().all(|s| s == "Bearer fixture-two"));
        std::fs::remove_file(file).unwrap();
    }

    #[tokio::test]
    async fn rejects_redirects_foreign_auth_large_and_invalid_bodies() {
        let hits = Arc::new(AtomicUsize::new(0));
        let count = hits.clone();
        let foreign = serve(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            Json(json!([])).into_response()
        })
        .await;
        let target = foreign.clone();
        let root = serve(move |req| match req.uri().path() {
            "/redirect" => (
                axum::http::StatusCode::FOUND,
                [("location", target.clone())],
            )
                .into_response(),
            "/large" => "x".repeat(MAX_BODY + 1).into_response(),
            _ => "not json: sensitive body".into_response(),
        })
        .await;
        let file = token();
        let reader = config(&root, file.clone()).reader().unwrap().unwrap();
        for path in ["redirect", "large", "invalid"] {
            let error = reader
                .get::<Value>(reader.url(&[path]))
                .await
                .unwrap_err()
                .to_string();
            assert!(!error.contains("sensitive"));
            assert!(!error.contains(&root));
        }
        assert!(
            reader
                .get::<Value>(Url::parse(&foreign).unwrap())
                .await
                .is_err()
        );
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        std::fs::remove_file(file).unwrap();
    }

    #[tokio::test]
    async fn http_sse_parity_and_disabled_omission() {
        use crate::state::{State, tests::Recorded};
        let root = serve(|req| {
            Json(if req.uri().path().contains("/orgs/") {
                json!([repo("sample-team", "project")])
            } else if req.uri().path().ends_with("/issues") {
                json!([issue(1, "gate-a")])
            } else {
                json!([])
            })
            .into_response()
        })
        .await;
        let file = token();
        let reader = config(&root, file.clone()).reader().unwrap().unwrap();
        let initial = State::empty();
        assert!(
            serde_json::to_value(&initial)
                .unwrap()
                .get("forgejo")
                .is_none()
        );
        let state =
            crate::refresh_generation(&Recorded::fixture(), None, Some(&reader), &initial, || {
                AT.into()
            })
            .await;
        assert_eq!(state.waiting.items.len(), 2);
        assert_eq!(state.forgejo.as_ref().unwrap().items.len(), 1);
        let (tx, rx) = tokio::sync::watch::channel(Arc::new(state));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, crate::server::router(rx, None, vec![]))
                .await
                .unwrap()
        });
        let http = reqwest::Client::new();
        let mut events = http
            .get(format!("http://{addr}/api/events"))
            .send()
            .await
            .unwrap();
        let (id, event) = crate::server::tests::next_state(&mut events, &mut String::new()).await;
        assert_eq!(id, "1");
        for path in ["/api/state", "/api/v1/state"] {
            let value: Value = http
                .get(format!("http://{addr}{path}"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(value, event);
        }
        let disabled = crate::refresh_generation(
            &Recorded::fixture(),
            None,
            None,
            &tx.borrow().clone(),
            || AT.into(),
        )
        .await;
        assert!(
            serde_json::to_value(disabled)
                .unwrap()
                .get("forgejo")
                .is_none()
        );
        std::fs::remove_file(file).unwrap();
    }
}

fn name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        && s != "."
        && s != ".."
}

impl Config {
    pub fn reader(self) -> Result<Option<Reader>> {
        if self.base_url.is_none()
            && self.token_file.is_none()
            && self.organizations.is_empty()
            && self.labels.is_empty()
            && self.reviewer.is_none()
        {
            return Ok(None);
        }
        let (Some(base), Some(file), Some(reviewer)) =
            (self.base_url, self.token_file, self.reviewer)
        else {
            bail!("Forgejo needs base URL, token file, organizations, labels and reviewer");
        };
        if self.organizations.is_empty()
            || self.organizations.len() > 16
            || !self.organizations.iter().all(|s| name(s))
            || !name(&reviewer)
            || self.labels.is_empty()
            || self.labels.len() > 32
            || self.labels.iter().any(|s| s.is_empty() || s.len() > 100)
            || file.as_os_str().is_empty()
        {
            bail!("invalid Forgejo configuration (1–16 organizations and 1–32 labels required)");
        }
        let mut root =
            Url::parse(&base).map_err(|_| anyhow::anyhow!("invalid Forgejo base URL"))?;
        if root.scheme() != "https"
            && !(root.scheme() == "http"
                && matches!(root.host_str(), Some("127.0.0.1" | "[::1]" | "localhost")))
            || root.host_str().is_none()
            || !root.username().is_empty()
            || root.password().is_some()
            || root.query().is_some()
            || root.fragment().is_some()
        {
            bail!(
                "Forgejo base URL needs HTTPS (HTTP only on loopback), no credentials, query or fragment"
            );
        }
        let path = format!("{}/", root.path().trim_end_matches('/'));
        root.set_path(&path);
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .build()?;
        Ok(Some(Reader {
            root,
            http,
            token: TokenSource::File(file),
            organizations: self.organizations,
            labels: self.labels,
            reviewer,
            refresh_timeout: REFRESH_TIMEOUT,
        }))
    }
}

/// Identity includes forge origin/base path, repository and item kind, never a
/// response-provided URL. Forgejo issue and PR indexes share a namespace, but
/// keeping the kind explicit avoids conflating sources in future consumers.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub forge: String,
    pub repository: String,
    pub kind: Kind,
    pub number: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Issue,
    PullRequest,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub identity: Identity,
    pub title: String,
    pub url: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
struct Repository {
    name: String,
    owner: User,
}

#[derive(Deserialize)]
struct User {
    login: String,
}

#[derive(Deserialize)]
struct Label {
    name: String,
}

#[derive(Deserialize)]
struct Issue {
    number: u64,
    title: String,
    state: String,
    updated_at: String,
    #[serde(default)]
    labels: Vec<Label>,
    pull_request: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct Pull {
    number: u64,
    title: String,
    state: String,
    updated_at: String,
    // Missing reviewers is not evidence that there are no review requests.
    requested_reviewers: Vec<User>,
}

pub struct Reader {
    root: Url,
    http: reqwest::Client,
    token: TokenSource,
    organizations: Vec<String>,
    labels: Vec<String>,
    reviewer: String,
    refresh_timeout: Duration,
}

struct Observation {
    items: BTreeMap<Identity, Item>,
    requests: usize,
    successes: usize,
    observations: usize,
    incomplete: bool,
    failures: usize,
    deadline: tokio::time::Instant,
}

#[derive(Debug)]
struct Page<T> {
    items: Vec<T>,
    total: Option<usize>,
    has_next: bool,
}

impl Reader {
    /// Only locally constructed path segments enter the URL. Link, html_url,
    /// repository URLs and redirect locations from the server are never followed.
    fn url(&self, segments: &[&str]) -> Url {
        let mut url = self.root.clone();
        url.path_segments_mut()
            .expect("validated base URL")
            .pop_if_empty()
            .extend(segments);
        url
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, url: Url) -> Result<Page<T>> {
        if url.origin() != self.root.origin() {
            bail!("Forgejo origin mismatch");
        }
        let token = self
            .token
            .token()
            .await
            .map_err(|_| anyhow::anyhow!("Forgejo token unavailable"))?;
        let mut response = self
            .http
            .get(url)
            .bearer_auth(token)
            .header("Accept", "application/json")
            .header("User-Agent", "control-app")
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Forgejo request failed"))?;
        if !response.status().is_success() {
            bail!("Forgejo HTTP {}", response.status().as_u16());
        }
        let total = response
            .headers()
            .get("x-total-count")
            .map(|v| {
                v.to_str()
                    .ok()
                    .and_then(|s| s.parse::<usize>().ok())
                    .ok_or_else(|| anyhow::anyhow!("Forgejo invalid pagination count"))
            })
            .transpose()?;
        // Inspect only the relation; never use the URL or its origin. A server
        // may cap pages below the requested limit, so a short page isn't enough.
        let has_next = response.headers().get_all("link").iter().any(|value| {
            value.to_str().is_ok_and(|s| {
                s.split(',').any(|link| {
                    link.split(';')
                        .skip(1)
                        .any(|p| matches!(p.trim(), "rel=\"next\"" | "rel=next"))
                })
            })
        });
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BODY as u64)
        {
            bail!("Forgejo response too large");
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("Forgejo body read failed"))?
        {
            if body.len() + chunk.len() > MAX_BODY {
                bail!("Forgejo response too large");
            }
            body.extend_from_slice(&chunk);
        }
        let items: Vec<T> = serde_json::from_slice(&body)
            .map_err(|_| anyhow::anyhow!("Forgejo invalid response"))?;
        if items.len() > PAGE_SIZE {
            bail!("Forgejo page too large");
        }
        Ok(Page {
            items,
            total,
            has_next,
        })
    }

    async fn pages<T: serde::de::DeserializeOwned>(
        &self,
        segments: &[&str],
        observation: &mut Observation,
    ) -> Vec<T> {
        let mut found = Vec::new();
        for page in 1..=MAX_PAGES {
            if observation.requests == MAX_REQUESTS {
                observation.incomplete = true;
                break;
            }
            if tokio::time::Instant::now() >= observation.deadline {
                observation.incomplete = true;
                break;
            }
            observation.requests += 1;
            let mut url = self.url(segments);
            url.query_pairs_mut()
                .append_pair("state", "open")
                .append_pair("limit", &PAGE_SIZE.to_string())
                .append_pair("page", &page.to_string());
            // Bound each pending read by the refresh deadline, rather than
            // canceling observe(): previously collected pages must survive.
            match tokio::time::timeout_at(observation.deadline, self.get::<T>(url)).await {
                Ok(Ok(answer)) => {
                    observation.successes += 1;
                    if segments.get(2) == Some(&"repos") {
                        observation.observations += 1;
                    }
                    let more = answer.has_next
                        || answer.items.len() == PAGE_SIZE
                        || answer
                            .total
                            .is_some_and(|total| total > found.len() + answer.items.len());
                    found.extend(answer.items);
                    if !more {
                        break;
                    }
                    if page == MAX_PAGES {
                        observation.incomplete = true;
                    }
                }
                Ok(Err(_)) | Err(_) => {
                    // Do not expose upstream bodies, private addresses, paths,
                    // labels, or tokens in errors or logs.
                    observation.failures += 1;
                    break;
                }
            }
        }
        found
    }

    fn item(&self, repo: &str, kind: Kind, number: u64, title: String, updated_at: String) -> Item {
        let identity = Identity {
            forge: self.root.to_string(),
            repository: repo.to_ascii_lowercase(),
            kind,
            number,
        };
        let (owner, name) = repo.split_once('/').expect("constructed repository");
        let number_string = number.to_string();
        let url = self.url(&[
            owner,
            name,
            if kind == Kind::Issue {
                "issues"
            } else {
                "pulls"
            },
            &number_string,
        ]);
        Item {
            identity,
            title,
            updated_at,
            url: url.to_string(),
        }
    }

    async fn observe(&self, obs: &mut Observation) {
        let mut repos = BTreeMap::new();
        for org in &self.organizations {
            let successes = obs.successes;
            let failures = obs.failures;
            let listed = self
                .pages::<Repository>(&["api", "v1", "orgs", org, "repos"], obs)
                .await;
            if listed.is_empty() && obs.successes > successes && obs.failures == failures {
                obs.observations += 1;
            }
            for repo in listed {
                if !repo.owner.login.eq_ignore_ascii_case(org) || !name(&repo.name) {
                    obs.failures += 1;
                    continue;
                }
                let full = format!("{}/{}", org, repo.name);
                repos.insert(full.to_ascii_lowercase(), full);
            }
        }
        for repo in repos.into_values() {
            let (owner, name) = repo.split_once('/').unwrap();
            for issue in self
                .pages::<Issue>(&["api", "v1", "repos", owner, name, "issues"], obs)
                .await
            {
                if issue.state != "open"
                    || issue.pull_request.is_some()
                    || issue.number == 0
                    || !issue.labels.iter().any(|l| self.labels.contains(&l.name))
                {
                    continue;
                }
                let item = self.item(
                    &repo,
                    Kind::Issue,
                    issue.number,
                    issue.title,
                    issue.updated_at,
                );
                obs.items.insert(item.identity.clone(), item);
            }
            for pull in self
                .pages::<Pull>(&["api", "v1", "repos", owner, name, "pulls"], obs)
                .await
            {
                if pull.state != "open"
                    || pull.number == 0
                    || !pull
                        .requested_reviewers
                        .iter()
                        .any(|u| u.login.eq_ignore_ascii_case(&self.reviewer))
                {
                    continue;
                }
                let item = self.item(
                    &repo,
                    Kind::PullRequest,
                    pull.number,
                    pull.title,
                    pull.updated_at,
                );
                obs.items.insert(item.identity.clone(), item);
            }
        }
    }

    pub async fn refresh(&self, prev: Option<&Section<Item>>, now: &str) -> Section<Item> {
        let mut obs = Observation {
            items: BTreeMap::new(),
            requests: 0,
            successes: 0,
            observations: 0,
            incomplete: false,
            failures: 0,
            deadline: tokio::time::Instant::now() + self.refresh_timeout,
        };
        self.observe(&mut obs).await;
        let complete = !obs.incomplete && obs.failures == 0;
        let error = if obs.failures > 0 {
            Some(format!(
                "Forgejo reads failed ({}); results may be missing",
                obs.failures
            ))
        } else if obs.incomplete {
            Some("Forgejo read limit reached; results may be missing".into())
        } else {
            None
        };
        // Repository enumeration alone isn't a successful item observation.
        // If it found repositories but all item reads failed, carry prior data.
        if obs.observations == 0 {
            return Section {
                complete: false,
                error,
                ..prev.cloned().unwrap_or_default()
            };
        }
        Section {
            items: obs.items.into_values().collect(),
            complete,
            error,
            read_at: Some(now.into()),
        }
    }
}
