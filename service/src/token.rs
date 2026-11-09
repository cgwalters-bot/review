//! Where the GitHub token comes from. Never a flag or environment value,
//! which leak into process listings and crash reports: a file, reread for
//! every request so a rotated Secret takes effect; an Octo STS exchange of
//! the pod's service-account token for a short-lived installation token;
//! or, for local runs, `gh auth token`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use reqwest::header::{AUTHORIZATION, USER_AGENT};
use serde::Deserialize;
use tokio::sync::Mutex;

pub const OCTO_STS_ROOT: &str = "https://octo-sts.dev";

/// GitHub installation tokens last an hour; exchange again well before.
const OCTO_STS_REFRESH: Duration = Duration::from_secs(45 * 60);

/// Give up on an exchange Octo STS hasn't answered in this long.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);

pub enum TokenSource {
    /// A token read once at startup, from `gh auth token`.
    Fixed(String),
    /// A file holding the token, reread for every request.
    File(PathBuf),
    OctoSts(OctoSts),
}

impl TokenSource {
    /// The local convenience: the token `gh` holds for github.com.
    pub fn gh() -> Result<Self> {
        let out = std::process::Command::new("gh")
            .args(["auth", "token", "--hostname", "github.com"])
            .output()
            .context("no token source given, and running `gh auth token` failed")?;
        let t = String::from_utf8(out.stdout).unwrap_or_default();
        if !out.status.success() || t.trim().is_empty() {
            bail!("no token source given, and `gh auth token` gave none");
        }
        Ok(Self::Fixed(t.trim().to_owned()))
    }

    pub async fn token(&self) -> Result<String> {
        match self {
            Self::Fixed(t) => Ok(t.clone()),
            Self::File(path) => read_token(path).await,
            Self::OctoSts(sts) => sts.token().await,
        }
    }
}

/// A token file's trimmed contents, which must not be empty.
async fn read_token(path: &PathBuf) -> Result<String> {
    let t = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("reading the token from {}", path.display()))?;
    let t = t.trim();
    if t.is_empty() {
        bail!("{} holds no token", path.display());
    }
    Ok(t.to_owned())
}

/// Exchanges a Kubernetes service-account token (audience octo-sts.dev)
/// at Octo STS for an installation token whose permissions the trust
/// policy `identity` in `scope` grants (service/README.md).
pub struct OctoSts {
    http: reqwest::Client,
    root: String,
    scope: String,
    identity: String,
    /// The projected service-account token, which the kubelet rotates:
    /// read again for every exchange.
    oidc_token_file: PathBuf,
    refresh_after: Duration,
    /// The last installation token and when it was issued. Behind an async
    /// lock, so concurrent requests share one exchange.
    current: Mutex<Option<(String, Instant)>>,
}

#[derive(Deserialize)]
struct Exchanged {
    token: Option<String>,
    message: Option<String>,
}

impl OctoSts {
    pub fn new(
        root: &str,
        scope: String,
        identity: String,
        oidc_token_file: PathBuf,
    ) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(EXCHANGE_TIMEOUT)
            .build()
            .context("building the HTTP client")?;
        Ok(Self {
            http,
            root: root.trim_end_matches('/').to_owned(),
            scope,
            identity,
            oidc_token_file,
            refresh_after: OCTO_STS_REFRESH,
            current: Mutex::new(None),
        })
    }

    async fn token(&self) -> Result<String> {
        let mut current = self.current.lock().await;
        if let Some((t, at)) = &*current
            && at.elapsed() < self.refresh_after
        {
            return Ok(t.clone());
        }
        let t = self.exchange().await.with_context(|| {
            format!(
                "exchanging the service-account token at Octo STS for {} {}",
                self.scope, self.identity
            )
        })?;
        *current = Some((t.clone(), Instant::now()));
        Ok(t)
    }

    async fn exchange(&self) -> Result<String> {
        let oidc = read_token(&self.oidc_token_file).await?;
        let url = reqwest::Url::parse_with_params(
            &format!("{}/sts/exchange", self.root),
            [("scope", &self.scope), ("identity", &self.identity)],
        )
        .context("building the exchange URL")?;
        let resp = self
            .http
            .get(url)
            .header(AUTHORIZATION, format!("Bearer {oidc}"))
            .header(USER_AGENT, "control-app")
            .send()
            .await?;
        let status = resp.status();
        let body = resp.text().await.context("reading the answer")?;
        let answer = serde_json::from_str::<Exchanged>(&body).ok();
        match answer {
            Some(Exchanged { token: Some(t), .. }) if status.is_success() && !t.is_empty() => Ok(t),
            Some(Exchanged {
                message: Some(m), ..
            }) => bail!("HTTP {}: {m}", status.as_u16()),
            _ => bail!("HTTP {}: no token in {body:?}", status.as_u16()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::extract::Query;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use serde_json::json;

    use super::*;

    /// An Octo STS that answers each exchange with "installation-N" for the
    /// bearer token "oidc-N"'s N, and refuses others.
    async fn fake_sts(exchanges: Arc<AtomicUsize>) -> String {
        let app = Router::new().route(
            "/sts/exchange",
            get(
                move |headers: HeaderMap, Query(q): Query<Vec<(String, String)>>| async move {
                    exchanges.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        q,
                        [
                            ("scope".to_owned(), "cgwalters-forge".to_owned()),
                            ("identity".to_owned(), "control-plane".to_owned())
                        ]
                    );
                    let bearer = headers["authorization"].to_str().unwrap();
                    match bearer.strip_prefix("Bearer oidc-") {
                        Some(n) => axum::Json(json!({"token": format!("installation-{n}")}))
                            .into_response(),
                        None => (
                            StatusCode::FORBIDDEN,
                            axum::Json(json!({"message": "no matching trust policy"})),
                        )
                            .into_response(),
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("review-service-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("token")
    }

    #[tokio::test]
    async fn octo_sts_rereads_the_oidc_token_and_caches() {
        let exchanges = Arc::new(AtomicUsize::new(0));
        let root = fake_sts(exchanges.clone()).await;
        let file = scratch("sts");
        std::fs::write(&file, "oidc-1\n").unwrap();
        let source = |refresh_after| {
            let mut sts = OctoSts::new(
                &root,
                "cgwalters-forge".into(),
                "control-plane".into(),
                file.clone(),
            )
            .unwrap();
            sts.refresh_after = refresh_after;
            TokenSource::OctoSts(sts)
        };

        // Within the refresh period, one exchange serves every request.
        let cached = source(OCTO_STS_REFRESH);
        assert_eq!(cached.token().await.unwrap(), "installation-1");
        std::fs::write(&file, "oidc-2").unwrap();
        assert_eq!(cached.token().await.unwrap(), "installation-1");
        assert_eq!(exchanges.load(Ordering::SeqCst), 1);

        // Past it, each exchange reads the rotated service-account token.
        let expiring = source(Duration::ZERO);
        assert_eq!(expiring.token().await.unwrap(), "installation-2");
        std::fs::write(&file, "oidc-3").unwrap();
        assert_eq!(expiring.token().await.unwrap(), "installation-3");
        assert_eq!(exchanges.load(Ordering::SeqCst), 3);

        std::fs::write(&file, "stolen").unwrap();
        let err = format!("{:#}", expiring.token().await.unwrap_err());
        assert!(
            err.ends_with("cgwalters-forge control-plane: HTTP 403: no matching trust policy"),
            "{err}"
        );
        std::fs::write(&file, "").unwrap();
        let err = format!("{:#}", expiring.token().await.unwrap_err());
        assert!(err.ends_with("holds no token"), "{err}");
        std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn file_is_reread() {
        let file = scratch("file");
        let src = TokenSource::File(file.clone());
        assert!(src.token().await.is_err(), "a missing file is an error");
        std::fs::write(&file, " one\n").unwrap();
        assert_eq!(src.token().await.unwrap(), "one");
        std::fs::write(&file, "two").unwrap();
        assert_eq!(src.token().await.unwrap(), "two");
        std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }
}
