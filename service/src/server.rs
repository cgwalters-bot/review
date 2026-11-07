//! The HTTP side: the state's read endpoints, its updates over SSE, and
//! the built app's static files. It has no route that writes.

use std::convert::Infallible;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, Request, State as Extract};
use axum::http::StatusCode;
use axum::http::header::HOST;
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{Stream, StreamExt};
use tokio::sync::watch;
use tokio_stream::wrappers::WatchStream;
use tower_http::services::ServeDir;

use crate::state::State;

pub type Shared = watch::Receiver<Arc<State>>;

/// The SSE event carrying a whole state document.
pub const STATE_EVENT: &str = "state";

pub fn router(state: Shared, static_dir: Option<PathBuf>) -> Router {
    let api = Router::new()
        .route("/api/state", get(whole))
        .route("/api/repos/{owner}/{repo}", get(repo))
        .route("/api/events", get(events))
        .with_state(state);
    let app = match static_dir {
        Some(dir) => api.fallback_service(ServeDir::new(dir)),
        None => api,
    };
    app.layer(middleware::from_fn(local_host))
}

/// Refuse a request whose Host is a domain name other than localhost. A
/// page on any site the operator opens could otherwise point its own name
/// at 127.0.0.1 (DNS rebinding) and read the state as same-origin.
async fn local_host(req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if is_local(host) {
        next.run(req).await
    } else {
        (
            StatusCode::FORBIDDEN,
            "review-service answers only to localhost or an IP address\n",
        )
            .into_response()
    }
}

/// Whether a Host header names localhost or an IP address, with or without a port.
fn is_local(host: &str) -> bool {
    let name = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => host.rsplit_once(':').map_or(host, |(name, _)| name),
    };
    name.eq_ignore_ascii_case("localhost") || name.parse::<IpAddr>().is_ok()
}

async fn whole(Extract(state): Extract<Shared>) -> Response {
    let state = state.borrow().clone();
    Json(&*state).into_response()
}

async fn repo(
    Extract(state): Extract<Shared>,
    Path((owner, repo)): Path<(String, String)>,
) -> Response {
    let state = state.borrow().clone();
    Json(state.repo(&format!("{owner}/{repo}"))).into_response()
}

/// The current state on connecting, then each refresh's.
async fn events(
    Extract(state): Extract<Shared>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = WatchStream::new(state).map(|s| {
        Ok(Event::default()
            .event(STATE_EVENT)
            .data(serde_json::to_string(&*s).expect("serializing the state")))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::state::refresh;
    use crate::state::tests::Recorded;

    async fn serve(rx: Shared, static_dir: Option<PathBuf>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router(rx, static_dir)).await.unwrap() });
        format!("http://{addr}")
    }

    /// The data of the next complete SSE event of type `state`.
    async fn next_state(resp: &mut reqwest::Response, buf: &mut String) -> Value {
        loop {
            if let Some(end) = buf.find("\n\n") {
                let event: String = buf.drain(..end + 2).collect();
                if event.lines().any(|l| l == "event: state") {
                    let data: String = event
                        .lines()
                        .filter_map(|l| l.strip_prefix("data: "))
                        .collect();
                    return serde_json::from_str(&data).unwrap();
                }
                continue;
            }
            let chunk = resp.chunk().await.unwrap().expect("the stream ended");
            buf.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    }

    #[tokio::test]
    async fn endpoints_and_events() {
        let (tx, rx) = watch::channel(Arc::new(State::empty()));
        let dir = std::env::temp_dir().join(format!("review-service-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<p>app</p>").unwrap();
        let base = serve(rx, Some(dir.clone())).await;
        let http = reqwest::Client::new();

        let mut events = http.get(format!("{base}/api/events")).send().await.unwrap();
        assert_eq!(events.headers()["content-type"], "text/event-stream");
        let mut buf = String::new();
        let first = next_state(&mut events, &mut buf).await;
        assert_eq!(first["schema"], "review-service/v1");
        assert_eq!(first["refreshedAt"], Value::Null);

        let state = refresh(
            &Recorded::fixture(),
            &State::empty(),
            "2026-11-07T12:00:00Z",
        )
        .await;
        tx.send(Arc::new(state)).unwrap();
        let second = next_state(&mut events, &mut buf).await;
        assert_eq!(second["refreshedAt"], "2026-11-07T12:00:00Z");

        let whole: Value = http
            .get(format!("{base}/api/state"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(whole, second);
        let board: Value = http
            .get(format!("{base}/api/repos/bootc-dev/BOOTC"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(board["repository"], "bootc-dev/BOOTC");
        assert_eq!(board["prs"][0]["number"], 1201);
        assert_eq!(
            board["waiting"][0]["reasons"],
            serde_json::json!(["review-requested", "assigned"])
        );

        let page = http
            .get(format!("{base}/"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(page, "<p>app</p>");
        let post = http.post(format!("{base}/api/state")).send().await.unwrap();
        assert_eq!(post.status(), 405, "nothing writes");
        let rebound = http
            .get(format!("{base}/api/state"))
            .header("host", "evil.example:8787")
            .send()
            .await
            .unwrap();
        assert_eq!(rebound.status(), 403);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn local_hosts() {
        for host in [
            "localhost:8787",
            "LOCALHOST",
            "127.0.0.1:8787",
            "[::1]:8787",
            "[::1]",
            "10.0.0.2",
        ] {
            assert!(is_local(host), "{host}");
        }
        for host in [
            "",
            "evil.example",
            "evil.example:8787",
            "localhost.evil.example",
            "127.0.0.1.nip.io:8787",
        ] {
            assert!(!is_local(host), "{host}");
        }
    }
}
