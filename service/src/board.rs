//! Read-only board-forge decision previews. With the board config's `state`
//! gate, only the disposable response index is carried in memory to the next
//! preview under the same credential context. Scheduling always starts fresh.
//! Neither preview mode accesses a local pass state or status ledger file.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, mpsc};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use board_forge::github::{GraphQl, Transport};
use board_forge::pass::{self, Broker, decision};
use board_forge::poll::{Rest, RestResponse};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::state::Section;
use crate::token::TokenSource;

// A preview must not consume an unbounded refresh or API budget. Exhaustion
// becomes missing coverage in board-forge, never permission to act.
const MAX_REQUESTS: usize = 128;
const PASS_TIMEOUT: Duration = Duration::from_secs(45);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_CONFIG: u64 = 1024 * 1024;
// Credential context checks reread the token, including for cache hits that
// send nothing; the pass asks about three times per read.
const MAX_CONTEXT_CHECKS: usize = 4 * MAX_REQUESTS;
const CONTEXT_DOMAIN: &[u8] = b"review-service/board-preview/v1\0";

const BACKOFF: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(900);
const MAX_RETRY: Duration = Duration::from_secs(3600);

async fn read_config(input: impl AsyncRead + Unpin) -> Result<String> {
    // Metadata is not a read bound: a file can grow after stat, and some
    // filesystem inputs report zero length. Read one extra byte to reject,
    // rather than parse a silently truncated configuration.
    let mut bytes = Vec::new();
    input
        .take(MAX_CONFIG + 1)
        .read_to_end(&mut bytes)
        .await
        .context("reading board config")?;
    ensure!(bytes.len() as u64 <= MAX_CONFIG, "board config too large");
    String::from_utf8(bytes).context("board config is not UTF-8")
}

fn preview_config(text: &str) -> Result<pass::Config> {
    // Configuration errors can quote prompts or broker addresses.
    let config = pass::Config::parse(text).map_err(|_| anyhow::anyhow!("invalid board config"))?;
    ensure!(
        config.forgejo_board().is_none(),
        "service preview supports GitHub boards only"
    );
    // The library opens this ledger even in Preview and before transport
    // bounds apply. Reject the option, not particular filesystem path types.
    ensure!(
        config.living_status.is_none(),
        "service preview does not support livingStatus"
    );
    Ok(config)
}

#[derive(Default)]
struct Pacing {
    failures: u32,
    until: Option<tokio::time::Instant>,
    last_success: Option<tokio::time::Instant>,
    limit: Option<LimitEvidence>,
    requests: usize,
    network_sends: usize,
    charged_requests: Option<usize>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LimitEvidence {
    retry_after_seconds: Option<u64>,
    reset_at_unix: Option<i64>,
}

/// Publication-time ages, not source-validation clocks or execution receipts.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshStatus {
    last_success_age_seconds: Option<u64>,
    retry_in_seconds: u64,
    consecutive_failures: u32,
    rate_limit: Option<LimitEvidence>,
    requests: usize,
    // HTTP send attempts (a 304 revalidation is one), apart from the
    // requests board-forge charged to its budget, which refunds 304s. Charged
    // requests are unknown when the preview failed.
    network_sends: usize,
    charged_requests: Option<usize>,
}

impl Pacing {
    fn waiting(&self) -> bool {
        self.until
            .is_some_and(|until| until > tokio::time::Instant::now())
    }

    fn limited(&mut self, evidence: LimitEvidence, wait: Duration) {
        let until = tokio::time::Instant::now() + wait.clamp(BACKOFF, MAX_RETRY);
        self.until = Some(self.until.map_or(until, |old| old.max(until)));
        self.limit = Some(evidence);
    }

    fn finished(&mut self, success: bool, complete: bool, requests: usize) {
        self.requests = requests;
        if success && !self.waiting() {
            // Error-free reads can still omit coverage (for example, usage or
            // needs-you evidence). Do not call that a fresh complete preview.
            if complete {
                self.last_success = Some(tokio::time::Instant::now());
            }
            self.failures = 0;
            self.until = None;
            self.limit = None;
        } else {
            self.failures = self.failures.saturating_add(1);
            let wait = BACKOFF.saturating_mul(1 << self.failures.saturating_sub(1).min(5));
            let until = tokio::time::Instant::now() + wait.min(MAX_BACKOFF);
            self.until = Some(self.until.map_or(until, |old| old.max(until)));
        }
    }
}

// Dropping a preview (including aborting the refresher) cancels its current
// async request and closes admission to all later blocking-library reads.
#[derive(Default)]
struct Work {
    cancelled: AtomicBool,
    limited: AtomicBool,
    credential_changed: AtomicBool,
    credential: Mutex<Option<[u8; 32]>>,
    request: Mutex<Option<tokio::task::AbortHandle>>,
    sends: AtomicUsize,
}

/// Only response evidence from the last accepted preview. In particular, a
/// cache miss or a restart must not change where the scheduler starts scanning.
struct Carried {
    context: String,
    response_scope: String,
    responses: BTreeMap<String, Value>,
    pass_responses: BTreeMap<String, Value>,
}

impl Carried {
    fn new(context: String, state: board_forge::poll::State) -> Option<Self> {
        Some(Self {
            context,
            response_scope: state.response_scope?,
            responses: state.responses,
            pass_responses: state.pass_responses,
        })
    }

    fn into_state(self) -> board_forge::poll::State {
        board_forge::poll::State {
            response_scope: Some(self.response_scope),
            responses: self.responses,
            pass_responses: self.pass_responses,
            ..Default::default()
        }
    }
}

struct CancelOnDrop(Arc<Work>);

// A cancelled token future has not verified the current identity. In particular,
// the outer request timeout must not turn a stalled token read into an ordinary
// forge failure that preserves evidence from a possibly revoked credential.
struct UnverifiedCredential<'a>(Option<&'a AtomicBool>);

impl Drop for UnverifiedCredential<'_> {
    fn drop(&mut self) {
        if let Some(changed) = self.0 {
            changed.store(true, Ordering::SeqCst);
        }
    }
}

async fn preview_token(
    work: &Work,
    read: impl std::future::Future<Output = Result<String>>,
) -> Result<String> {
    let mut guard = UnverifiedCredential(Some(&work.credential_changed));
    let token = read
        .await
        .map_err(|_| anyhow::anyhow!("forge token unavailable"))?;
    guard.0 = None;
    Ok(token)
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        let mut request = self.0.request.lock().unwrap();
        self.0.cancelled.store(true, Ordering::SeqCst);
        if let Some(request) = request.take() {
            request.abort();
        }
    }
}

#[derive(Clone)]
pub struct Reader {
    config: Arc<String>,
    token: Arc<TokenSource>,
    http: reqwest::Client,
    private: Vec<String>,
    pacing: Arc<Mutex<Pacing>>,
    // Identity of the last published observation; never persist the token.
    credential: Arc<Mutex<Option<[u8; 32]>>>,
    // Taken by each refresh and replaced only by a committed preview, so a
    // failed, cancelled or credential-invalid refresh leaves the next one cold.
    carried: Arc<Mutex<Option<Carried>>>,
    active: Arc<tokio::sync::Semaphore>,
    #[cfg(test)]
    api_root: Option<String>,
}

impl Reader {
    pub async fn new(path: &Path, token: Arc<TokenSource>) -> Result<Self> {
        // A FIFO can block open itself, before any preview deadline applies.
        // Check the opened descriptor, not the path, to avoid replacement races
        // while still allowing symlinks used by mounted configuration files.
        let file = tokio::fs::OpenOptions::new()
            .read(true)
            .custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32)
            .open(path)
            .await
            .context("opening board config")?;
        ensure!(
            file.metadata()
                .await
                .context("checking board config")?
                .is_file(),
            "board config must be a regular file"
        );
        let config = read_config(file).await?;
        preview_config(&config)?;
        let mut private = Vec::new();
        private_urls(&serde_json::from_str(&config)?, &mut private);
        Ok(Self {
            config: Arc::new(config),
            token,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(REQUEST_TIMEOUT)
                .build()?,
            private,
            pacing: Default::default(),
            credential: Default::default(),
            carried: Default::default(),
            active: Arc::new(tokio::sync::Semaphore::new(1)),
            #[cfg(test)]
            api_root: None,
        })
    }

    pub async fn refresh(&self, prev: Option<&Section<Value>>, at: &str) -> Section<Value> {
        // Coalesce concurrent wakes rather than queuing another expensive pass.
        // The blocking worker owns the permit even if its caller is cancelled.
        let Ok(permit) = self.active.clone().try_acquire_owned() else {
            return deferred(prev, "board preview already running");
        };
        if self.pacing.lock().unwrap().waiting() {
            return deferred(prev, "board preview backing off");
        }
        let work = Arc::new(Work::default());
        let _cancel = CancelOnDrop(work.clone());
        let worker = work.clone();
        let reader = self.clone();
        let at_owned = at.to_owned();
        let runtime = tokio::runtime::Handle::current();
        // The exported API includes synchronous transports and non-Send futures.
        // Keep its entire computation off the HTTP runtime's worker threads.
        let result = tokio::task::spawn_blocking(move || {
            let transport = Direct {
                reader,
                runtime: runtime.clone(),
                deadline: Instant::now() + PASS_TIMEOUT,
                requests: Cell::new(0),
                checks: Cell::new(0),
                secrets: Arc::new(Mutex::new(Vec::new())),
                work: worker,
            };
            let carried = transport.reader.carried.lock().unwrap().take();
            let result = (|| -> Result<(Value, Option<Carried>, usize)> {
                let config = preview_config(&transport.reader.config)?;
                // Without the gate board-forge keeps no responses: read directly.
                let context = match config.state {
                    Some(_) => Some(
                        transport
                            .cache_context()
                            .context("preview credential unavailable")?,
                    ),
                    None => None,
                };
                let state = carried
                    .filter(|carried| context.as_ref() == Some(&carried.context))
                    .map(Carried::into_state)
                    .unwrap_or_default();
                let preview = runtime.block_on(decision::preview(
                    &transport,
                    &transport,
                    &config,
                    state,
                    Default::default(),
                    OffsetDateTime::parse(&at_owned, &Rfc3339)?,
                ))?;
                ensure!(
                    !transport.work.credential_changed.load(Ordering::SeqCst),
                    "preview credential changed"
                );
                let mut value = serde_json::to_value(preview.snapshot)?;
                let mut private = transport.reader.private.clone();
                private.extend(transport.secrets.lock().unwrap().iter().cloned());
                redact(&mut value, &private);
                let carried = context.and_then(|context| Carried::new(context, preview.state));
                Ok((value, carried, preview.spent.requests))
            })();
            (result, transport.requests.get(), permit)
        })
        .await;
        // Keep admission closed through publication of the credential binding,
        // not just through the blocking reads. Cancellation still leaves the
        // permit with the worker until it exits.
        let (result, carried, _permit) = match result {
            Ok((result, requests, permit)) => {
                let (value, carried, charged) = match result {
                    Ok((value, carried, charged)) => (Some(value), carried, Some(charged)),
                    Err(_) => (None, None, None),
                };
                let success = value.as_ref().is_some_and(|s| s["failures"] == 0);
                let complete = value.as_ref().is_some_and(|s| s["complete"] == true);
                let mut pacing = self.pacing.lock().unwrap();
                pacing.finished(success, complete, requests);
                pacing.network_sends = work.sends.load(Ordering::SeqCst);
                pacing.charged_requests = charged;
                (value, carried, Some(permit))
            }
            Err(_) => (None, None, None),
        };
        let credential = *work.credential.lock().unwrap();
        let prev = if let Some(credential) = credential {
            let mut previous = self.credential.lock().unwrap();
            let same = *previous == Some(credential);
            *previous = Some(credential);
            prev.filter(|_| same)
        } else {
            prev
        };
        if work.credential_changed.load(Ordering::SeqCst) {
            // Prior evidence may belong to the old credential too. Do not carry
            // it or its success age into a publication after an identity boundary.
            self.pacing.lock().unwrap().last_success = None;
            deferred(None, "board preview credential changed")
        } else if work.limited.load(Ordering::SeqCst) {
            deferred(prev, "board preview rate limited")
        } else {
            // The worker may finish after the awaiting refresh was dropped.
            // Only this path accepts the observation and its response evidence.
            *self.carried.lock().unwrap() = carried;
            observed(result, prev, at)
        }
    }

    pub fn status(&self) -> RefreshStatus {
        let pacing = self.pacing.lock().unwrap();
        let now = tokio::time::Instant::now();
        RefreshStatus {
            last_success_age_seconds: pacing
                .last_success
                .map(|at| now.duration_since(at).as_secs()),
            retry_in_seconds: pacing.until.map_or(0, |at| {
                let left = at.saturating_duration_since(now);
                left.as_secs() + u64::from(left.subsec_nanos() > 0)
            }),
            consecutive_failures: pacing.failures,
            rate_limit: pacing.limit.clone(),
            requests: pacing.requests,
            network_sends: pacing.network_sends,
            charged_requests: pacing.charged_requests,
        }
    }
}

fn deferred(prev: Option<&Section<Value>>, reason: &str) -> Section<Value> {
    Section {
        complete: false,
        error: Some(reason.into()),
        ..prev.cloned().unwrap_or_default()
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
    checks: Cell<usize>,
    secrets: Arc<Mutex<Vec<String>>>,
    work: Arc<Work>,
}

/// Pin the first credential a preview reads; any other one ends the preview.
fn pin(
    work: &Work,
    reader: &Reader,
    secrets: &Mutex<Vec<String>>,
    token: &str,
) -> Result<[u8; 32]> {
    let digest = Sha256::digest(token.as_bytes()).into();
    {
        let mut credential = work.credential.lock().unwrap();
        if credential.is_none() {
            *credential = Some(digest);
            if *reader.credential.lock().unwrap() != Some(digest) {
                // Success age and fallback evidence belong to the
                // prior credential, not merely to this board config.
                reader.pacing.lock().unwrap().last_success = None;
            }
        }
    }
    let mut secrets = secrets.lock().unwrap();
    // A single preview must not combine visibility scopes from different
    // credentials. Still reread the source each time, so rotation/revocation
    // is not hidden by a pinned token.
    if secrets.first().is_some_and(|first| first != token) {
        work.credential_changed.store(true, Ordering::SeqCst);
        bail!("preview credential changed");
    }
    if secrets.is_empty() {
        secrets.push(token.to_owned());
    }
    Ok(digest)
}

impl Direct {
    /// Run `future` on the runtime within `timeout`, cancellable by the
    /// refresh's drop. Serialize task registration with cancellation; no late
    /// detached spawn.
    fn block<T: Send + 'static>(
        &self,
        timeout: Duration,
        future: impl std::future::Future<Output = Result<T>> + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = mpsc::sync_channel(1);
        let mut active = self.work.request.lock().unwrap();
        ensure!(
            !self.work.cancelled.load(Ordering::SeqCst),
            "preview cancelled"
        );
        let task = self.runtime.spawn(async move {
            let result = tokio::time::timeout(timeout, future)
                .await
                .unwrap_or_else(|_| Err(anyhow::anyhow!("forge read timed out")));
            let _ = tx.send(result);
        });
        *active = Some(task.abort_handle());
        drop(active);
        let result = rx.recv_timeout(timeout + Duration::from_secs(1));
        // Also cancel if the synchronous waiter times out before the async task.
        task.abort();
        result.context("forge read timed out")?
    }

    /// Reread the credential source and check it is the one this preview
    /// pinned, returning its fingerprint. Within the request bounds; an
    /// unreadable or changed credential invalidates the preview.
    fn verify(&self) -> Result<[u8; 32]> {
        ensure!(
            !self.work.credential_changed.load(Ordering::SeqCst),
            "preview credential changed"
        );
        ensure!(
            self.checks.get() < MAX_CONTEXT_CHECKS && Instant::now() < self.deadline,
            "board credential check bound exhausted"
        );
        self.checks.set(self.checks.get() + 1);
        let timeout = REQUEST_TIMEOUT.min(self.deadline.saturating_duration_since(Instant::now()));
        let (reader, work) = (self.reader.clone(), self.work.clone());
        let token = self.block(timeout, async move {
            preview_token(&work, reader.token.token()).await
        });
        if token.is_err() {
            // A timed-out wait has not verified the identity either.
            self.work.credential_changed.store(true, Ordering::SeqCst);
        }
        pin(&self.work, &self.reader, &self.secrets, &token?)
    }

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
        let pacing = self.reader.pacing.clone();
        let work = self.work.clone();
        let secrets = self.secrets.clone();
        let validator = validator.map(|(k, v)| (k.to_owned(), v.to_owned()));
        self.block(timeout, async move {
            let token = preview_token(&work, reader.token.token()).await?;
            pin(&work, &reader, &secrets, &token)?;
            let is_query = query.is_some();
            let mut req = match query {
                Some(query) => reader.http.post(url).json(&query),
                None => reader.http.get(url),
            }
            .bearer_auth(&token)
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
            work.sends.fetch_add(1, Ordering::SeqCst);
            let mut response = req
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("forge request failed"))?;
            if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                // An unchanged token can have been revoked at the forge.
                // Reject all evidence before reading an untrusted error body.
                work.credential_changed.store(true, Ordering::SeqCst);
                return Err(board_forge::github::AuthenticationRequired.into());
            }
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
            let evidence = limit_evidence(response.headers(), std::time::SystemTime::now());
            // A temporarily unavailable forge can ask us to wait even when
            // its rate budget is nonzero. Stop this preview and later ticks
            // through the same bounded cooldown, before reading its body.
            let limited = out.status == 429
                || (out.status == 503 && evidence.retry_after_seconds.is_some())
                || (out.status == 403
                    && (response
                        .headers()
                        .get("x-ratelimit-remaining")
                        .is_some_and(|v| v == "0")
                        || response.headers().contains_key("retry-after")));
            let exhausted = response
                .headers()
                .get("x-ratelimit-remaining")
                .is_some_and(|v| v == "0");
            if limited || exhausted {
                work.limited.store(true, Ordering::SeqCst);
                let wait = retry_wait(&evidence, OffsetDateTime::now_utc().unix_timestamp());
                pacing.lock().unwrap().limited(evidence.clone(), wait);
            }
            let mut body = Vec::new();
            // Header-classified refusals need no body evidence. A stalled
            // error stream must not hold the preview until its timeout or
            // turn a known throttle into a generic body-read failure.
            if !limited {
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| anyhow::anyhow!("forge body failed"))?
                {
                    ensure!(body.len() + chunk.len() <= MAX_BODY, "forge body too large");
                    body.extend_from_slice(&chunk);
                }
            }
            drop(response);
            // The last response has no subsequent request to detect a
            // rotation. Recheck before accepting its evidence, within the
            // same request timeout (including token acquisition).
            let current = preview_token(&work, reader.token.token()).await?;
            if current != token {
                work.credential_changed.store(true, Ordering::SeqCst);
                bail!("preview credential changed");
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
            if limited
                || (out.status == 403 && message.contains("rate limit"))
                || (is_query && query_limited(&out.body))
            {
                if !limited && !exhausted {
                    work.limited.store(true, Ordering::SeqCst);
                    let wait = retry_wait(&evidence, OffsetDateTime::now_utc().unix_timestamp());
                    pacing.lock().unwrap().limited(evidence, wait);
                }
                return Err(board_forge::github::RateLimited("forge rate limited".into()).into());
            }
            Ok(out)
        })
    }

    fn admit(&self) -> Result<()> {
        ensure!(
            !self.work.credential_changed.load(Ordering::SeqCst),
            "preview credential changed"
        );
        ensure!(
            !self.work.cancelled.load(Ordering::SeqCst),
            "preview cancelled"
        );
        if self.reader.pacing.lock().unwrap().waiting() {
            return Err(board_forge::github::RateLimited("forge cooling down".into()).into());
        }
        ensure!(
            self.requests.get() < MAX_REQUESTS && Instant::now() < self.deadline,
            "board read bound exhausted"
        );
        self.requests.set(self.requests.get() + 1);
        Ok(())
    }
}

impl Rest for Direct {
    fn network_requests(&self) -> Option<usize> {
        Some(self.work.sends.load(Ordering::SeqCst))
    }

    /// A digest of the pinned credential's fingerprint, never the credential.
    /// Every call rereads the source, so a cache hit that sends nothing is
    /// still bound to the credential every request of this preview uses.
    fn cache_context(&self) -> Option<String> {
        let digest = self.verify().ok()?;
        let context = Sha256::new()
            .chain_update(CONTEXT_DOMAIN)
            .chain_update(board_forge::github::API_ROOT)
            .chain_update(b"\0")
            .chain_update(digest)
            .finalize();
        Some(format!("{context:x}"))
    }

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

fn query_limited(body: &Value) -> bool {
    body["errors"].as_array().is_some_and(|errors| {
        errors.iter().any(|e| {
            ["RATE_LIMITED", "RATE_LIMIT"].contains(&e["type"].as_str().unwrap_or_default())
                || e["code"] == "graphql_rate_limit"
                || e["extensions"]["code"] == "RATE_LIMITED"
        })
    })
}

fn limit_evidence(
    headers: &reqwest::header::HeaderMap,
    now: std::time::SystemTime,
) -> LimitEvidence {
    let text = |key| headers.get(key).and_then(|v| v.to_str().ok());
    let retry_after_seconds = text("retry-after").and_then(|s| {
        s.parse::<u64>().ok().or_else(|| {
            httpdate::parse_http_date(s).ok().map(|at| {
                let wait = at.duration_since(now).unwrap_or_default();
                wait.as_secs() + u64::from(wait.subsec_nanos() > 0)
            })
        })
    });
    LimitEvidence {
        retry_after_seconds,
        reset_at_unix: text("x-ratelimit-reset").and_then(|s| s.parse().ok()),
    }
}

fn retry_wait(evidence: &LimitEvidence, now: i64) -> Duration {
    let reset = evidence
        .reset_at_unix
        .map_or(0, |at| at.saturating_sub(now).max(0) as u64);
    Duration::from_secs(reset.max(evidence.retry_after_seconds.unwrap_or(0)))
        .clamp(BACKOFF, MAX_RETRY)
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

    const PRODUCER_REPLAY: &str = "../test/fixtures/service-decision-producer.json";

    #[tokio::test(start_paused = true)]
    async fn incomplete_reads_do_not_freshen_last_complete_preview() {
        let reader = reader(None, TokenSource::Fixed("fixture".into()));
        reader.pacing.lock().unwrap().finished(true, false, 3);
        assert_eq!(reader.status().last_success_age_seconds, None);
        assert_eq!(reader.status().retry_in_seconds, 0);

        reader.pacing.lock().unwrap().finished(true, true, 4);
        tokio::time::advance(Duration::from_secs(60)).await;
        reader.pacing.lock().unwrap().finished(false, false, 1);
        tokio::time::advance(BACKOFF).await;
        reader.pacing.lock().unwrap().finished(true, false, 3);
        let status = reader.status();
        assert_eq!(status.last_success_age_seconds, Some(90));
        // Missing coverage is not a transport failure: don't back off forever
        // when a configured preview cannot supply every optional projection.
        assert_eq!(status.consecutive_failures, 0);
        assert_eq!(status.retry_in_seconds, 0);
        assert_eq!(status.requests, 3);

        reader.pacing.lock().unwrap().finished(true, true, 4);
        assert_eq!(reader.status().last_success_age_seconds, Some(0));
    }

    #[tokio::test(start_paused = true)]
    async fn pacing_preserves_evidence_caps_backoff_and_recovers_without_freshening_sources() {
        let reader = reader(None, TokenSource::Fixed("fixture".into()));
        let previous = observed(
            Some(json!({"complete":true,"failures":0,"validated_at":AT})),
            None,
            AT,
        );
        reader.pacing.lock().unwrap().finished(true, true, 7);
        for (n, wait) in [30, 60, 120, 240, 480, 900, 900].into_iter().enumerate() {
            reader.pacing.lock().unwrap().finished(false, false, 1);
            assert_eq!(reader.status().retry_in_seconds, wait);
            assert_eq!(reader.status().consecutive_failures, n as u32 + 1);
            for _ in 0..10 {
                let skipped = reader
                    .refresh(Some(&previous), "2026-11-09T14:00:00Z")
                    .await;
                assert_eq!(skipped.items, previous.items);
                assert_eq!(skipped.read_at, previous.read_at);
                assert!(!skipped.complete);
            }
            tokio::time::advance(Duration::from_secs(wait)).await;
        }
        let age = reader.status().last_success_age_seconds.unwrap();
        assert!(age > 900);
        reader.pacing.lock().unwrap().limited(
            LimitEvidence {
                retry_after_seconds: Some(u64::MAX),
                reset_at_unix: Some(i64::MAX),
            },
            MAX_RETRY,
        );
        assert_eq!(reader.status().retry_in_seconds, 3600);
        tokio::time::advance(MAX_RETRY).await;
        reader.pacing.lock().unwrap().finished(true, true, 7);
        let status = reader.status();
        assert_eq!(status.last_success_age_seconds, Some(0));
        assert_eq!(status.consecutive_failures, 0);
        assert!(status.rate_limit.is_none());
        assert_eq!(previous.items[0]["validated_at"], AT);
        assert!(
            self::reader(None, TokenSource::Fixed("fixture".into()))
                .status()
                .last_success_age_seconds
                .is_none(),
            "restart has no invented success clock"
        );
    }

    #[test]
    fn parses_bounded_retry_hints_without_retaining_upstream_prose() {
        let now = std::time::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("retry-after", "120".parse().unwrap());
        headers.insert("x-ratelimit-reset", "1800000300".parse().unwrap());
        let evidence = limit_evidence(&headers, now);
        assert_eq!(retry_wait(&evidence, 1_800_000_000).as_secs(), 300);
        headers.insert(
            "retry-after",
            httpdate::fmt_http_date(now + Duration::from_secs(600))
                .parse()
                .unwrap(),
        );
        assert_eq!(limit_evidence(&headers, now).retry_after_seconds, Some(600));
        headers.insert("retry-after", "private upstream prose".parse().unwrap());
        headers.insert("x-ratelimit-reset", "invalid".parse().unwrap());
        let evidence = limit_evidence(&headers, now);
        assert_eq!(retry_wait(&evidence, 0), BACKOFF);
        assert_eq!(
            serde_json::to_value(evidence).unwrap(),
            json!({"retryAfterSeconds":null,"resetAtUnix":null})
        );
    }

    #[tokio::test]
    async fn throttling_stops_sends_across_ticks_and_repeated_limits_back_off() {
        use axum::http::StatusCode;
        let calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn({
            let calls = calls.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new().fallback(any(move || {
                        calls.fetch_add(1, Ordering::SeqCst);
                        async {
                            (
                                StatusCode::TOO_MANY_REQUESTS,
                                [("retry-after", "120"), ("x-ratelimit-reset", "123")],
                                "private refusal",
                            )
                        }
                    })),
                )
                .await
                .unwrap();
            }
        });
        let reader = reader(Some(root), TokenSource::Fixed("fixture".into()));
        // Bind the synthetic prior publication to the credential that read it.
        *reader.credential.lock().unwrap() = Some(Sha256::digest(b"fixture").into());
        let previous = observed(
            Some(json!({"complete":true,"failures":0,"validated_at":AT})),
            None,
            AT,
        );
        for failures in 1..=4 {
            // Clock-policy behavior is tested above with paused time. Here only
            // expire admission to exercise real HTTP responses without waiting.
            reader.pacing.lock().unwrap().until = None;
            let result = reader.refresh(Some(&previous), AT).await;
            assert_eq!(result.items, previous.items);
            assert_eq!(result.read_at, previous.read_at);
            assert!(!result.complete);
            let status = reader.status();
            assert_eq!(status.consecutive_failures, failures);
            assert_eq!(status.requests, 1);
            assert_eq!(status.rate_limit.unwrap().retry_after_seconds, Some(120));
            assert!(status.retry_in_seconds >= 119);
            for _ in 0..10 {
                reader.refresh(Some(&result), AT).await;
            }
            assert_eq!(calls.load(Ordering::SeqCst), failures as usize);
        }
        server.abort();
    }

    #[tokio::test]
    async fn concurrent_wakes_coalesce_and_cancellation_stops_detached_requests() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn({
            let (entered, release, calls) = (entered.clone(), release.clone(), calls.clone());
            async move {
                axum::serve(
                    listener,
                    Router::new().fallback(any(move || {
                        let (entered, release, calls) =
                            (entered.clone(), release.clone(), calls.clone());
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            entered.notify_one();
                            release.notified().await;
                            Json(json!({"data":{}}))
                        }
                    })),
                )
                .await
                .unwrap();
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let reader = gated(
            reader(Some(root), TokenSource::Fixed("fixture".into())),
            dir.path(),
        );
        *reader.carried.lock().unwrap() = Carried::new(
            String::new(),
            board_forge::poll::State {
                response_scope: Some("fixture-scope".into()),
                ..Default::default()
            },
        );
        let task = tokio::spawn({
            let reader = reader.clone();
            async move { reader.refresh(None, AT).await }
        });
        tokio::time::timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        for _ in 0..10 {
            let skipped = reader.refresh(None, AT).await;
            assert_eq!(
                skipped.error.as_deref(),
                Some("board preview already running")
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        // The blocking worker exits and returns its permit without waiting for
        // the slow response or leaving a request task detached from cancellation.
        let permit = tokio::time::timeout(
            Duration::from_secs(2),
            reader.active.clone().acquire_owned(),
        )
        .await
        .unwrap()
        .unwrap();
        release.notify_one();
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(reader.status().last_success_age_seconds, None);
        assert!(
            reader.carried.lock().unwrap().is_none(),
            "a cancelled refresh commits no state"
        );
        drop(permit);
        server.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn retry_hints_survive_ticks_and_natural_expiry_recovers_read_pacing() {
        use axum::response::IntoResponse;
        // Keep virtual time under explicit control while the blocking library
        // waits for real loopback I/O; auto-advance would expire request timers.
        let clock_guard = tokio::spawn(async {
            loop {
                tokio::task::yield_now().await;
            }
        });
        for (status, refusal_body, remaining) in [
            (200, r#"{"errors":[{"type":"RATE_LIMITED"}]}"#, "0"),
            (200, r#"{"errors":[{"type":"RATE_LIMITED"}]}"#, "50"),
            (503, "upstream temporarily unavailable", "50"),
        ] {
            let throttle = Arc::new(AtomicBool::new(false));
            let calls = Arc::new(AtomicUsize::new(0));
            let fake_state = Fake::default();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let root = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn({
                let (throttle, calls) = (throttle.clone(), calls.clone());
                async move {
                    axum::serve(
                        listener,
                        Router::new().fallback(any(
                            move |uri: axum::extract::OriginalUri,
                                  headers: HeaderMap,
                                  body: String| {
                                let (throttle, calls, fake_state) =
                                    (throttle.clone(), calls.clone(), fake_state.clone());
                                async move {
                                    calls.fetch_add(1, Ordering::SeqCst);
                                    if throttle.load(Ordering::SeqCst) {
                                        (
                                            axum::http::StatusCode::from_u16(status).unwrap(),
                                            [
                                                ("retry-after", "600"),
                                                ("x-ratelimit-reset", "123"),
                                                ("x-ratelimit-remaining", remaining),
                                            ],
                                            refusal_body,
                                        )
                                            .into_response()
                                    } else {
                                        fake(State(fake_state), uri, headers, body)
                                            .await
                                            .into_response()
                                    }
                                }
                            },
                        )),
                    )
                    .await
                    .unwrap();
                }
            });
            let mut reader = reader(Some(root), TokenSource::Fixed("fixture".into()));
            // A published-usage-only fixture avoids the deliberately unavailable
            // broker, allowing an actual failure-free library preview.
            let mut config: Value = serde_json::from_str(&reader.config).unwrap();
            config["usage"].as_object_mut().unwrap().remove("url");
            reader.config = Arc::new(config.to_string());
            let first = reader.refresh(None, AT).await;
            assert_eq!(first.items[0]["failures"], 0, "{first:?}");
            assert!(!first.complete);
            assert_eq!(reader.status().last_success_age_seconds, None);
            let cold = calls.load(Ordering::SeqCst);
            throttle.store(true, Ordering::SeqCst);
            let limited = reader.refresh(Some(&first), AT).await;
            assert_eq!(calls.load(Ordering::SeqCst), cold + 1);
            assert_eq!(reader.status().retry_in_seconds, 600);
            let evidence = reader.status().rate_limit.unwrap();
            assert_eq!(evidence.retry_after_seconds, Some(600));
            assert_eq!(evidence.reset_at_unix, Some(123));
            for _ in 0..10 {
                let skipped = reader.refresh(Some(&limited), AT).await;
                assert_eq!(skipped.items, first.items);
                assert_eq!(skipped.read_at, first.read_at);
                assert!(!skipped.complete);
            }
            assert_eq!(calls.load(Ordering::SeqCst), cold + 1);
            tokio::time::advance(Duration::from_secs(599)).await;
            reader.refresh(Some(&limited), AT).await;
            assert_eq!(calls.load(Ordering::SeqCst), cold + 1);
            assert_eq!(reader.status().last_success_age_seconds, None);
            tokio::time::advance(Duration::from_secs(1)).await;
            throttle.store(false, Ordering::SeqCst);
            let recovered = reader.refresh(Some(&limited), AT).await;
            assert_eq!(recovered.items, first.items);
            assert_eq!(calls.load(Ordering::SeqCst), 2 * cold + 1);
            let status = reader.status();
            assert_eq!(status.last_success_age_seconds, None);
            assert_eq!(status.consecutive_failures, 0);
            assert_eq!(status.retry_in_seconds, 0);
            assert!(status.rate_limit.is_none());
            server.abort();
        }
        clock_guard.abort();
    }

    fn config() -> String {
        json!({"operator":"operator", "bot":"robot", "dispatchRepo":"example/runner",
            "dispatchWorkflow":"dispatch.yml", "dispatchRef":"main",
            "board":{"owner":"example", "project":1}, "wip":8,
            "usage":{"repository":"example/ops", "issue":1},
            "pools":{"test": {"target":0.9, "burst":3}}, "planPools":["test"]})
        .to_string()
    }

    #[tokio::test]
    async fn config_read_stops_at_limit_plus_one() {
        let bytes = vec![b' '; 2 * MAX_CONFIG as usize];
        let mut input = bytes.as_slice();
        let error = read_config(&mut input).await.unwrap_err();
        assert_eq!(error.to_string(), "board config too large");
        assert_eq!(bytes.len() - input.len(), MAX_CONFIG as usize + 1);
        assert!(read_config(&b"\xff"[..]).await.is_err());
    }

    #[tokio::test]
    async fn config_requires_regular_file_and_allows_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("board.json");
        let link = dir.path().join("mounted.json");
        tokio::fs::write(&path, config()).await.unwrap();
        std::os::unix::fs::symlink(&path, &link).unwrap();
        let token = Arc::new(TokenSource::Fixed("fixture".into()));
        assert_eq!(
            Reader::new(&link, token.clone())
                .await
                .unwrap()
                .config
                .as_str(),
            config()
        );
        for path in [dir.path(), Path::new("/dev/null")] {
            let result =
                tokio::time::timeout(Duration::from_secs(2), Reader::new(path, token.clone()))
                    .await
                    .expect("special config input must not block");
            assert_eq!(
                result.err().unwrap().to_string(),
                "board config must be a regular file"
            );
        }
    }

    #[tokio::test]
    async fn preview_config_rejects_local_status_ledgers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("board.json");
        let ledger = dir.path().join("status.fifo");
        rustix::fs::mknodat(
            rustix::fs::CWD,
            &ledger,
            rustix::fs::FileType::Fifo,
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
            0,
        )
        .unwrap();
        let token = Arc::new(TokenSource::Fixed("fixture".into()));
        let mut config: Value = serde_json::from_str(&config()).unwrap();
        config["livingStatus"] = ledger.to_str().unwrap().into();
        for gated in [false, true] {
            if gated {
                config["state"] = "pass-state.json".into();
            }
            tokio::fs::write(&path, config.to_string()).await.unwrap();
            let result =
                tokio::time::timeout(Duration::from_secs(2), Reader::new(&path, token.clone()))
                    .await
                    .expect("preview admission must not wait for a FIFO writer");
            assert_eq!(
                result.err().expect("ledger must be rejected").to_string(),
                "service preview does not support livingStatus"
            );
        }
    }

    #[tokio::test]
    async fn config_file_size_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("board.json");
        let token = Arc::new(TokenSource::Fixed("fixture".into()));
        for size in [
            MAX_CONFIG as usize - 1,
            MAX_CONFIG as usize,
            MAX_CONFIG as usize + 1,
        ] {
            let mut bytes = config().into_bytes();
            bytes.resize(size, b' ');
            tokio::fs::write(&path, bytes).await.unwrap();
            let result = Reader::new(&path, token.clone()).await;
            if size <= MAX_CONFIG as usize {
                assert_eq!(result.unwrap().config.len(), size);
            } else {
                assert_eq!(result.err().unwrap().to_string(), "board config too large");
            }
        }
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
                .retry(reqwest::retry::never())
                .build()
                .unwrap(),
            private: Vec::new(),
            pacing: Default::default(),
            credential: Default::default(),
            carried: Default::default(),
            active: Arc::new(tokio::sync::Semaphore::new(1)),
            api_root: root,
        }
    }

    fn direct(reader: Reader) -> Direct {
        Direct {
            reader,
            runtime: tokio::runtime::Handle::current(),
            deadline: Instant::now() + PASS_TIMEOUT,
            requests: Cell::new(0),
            checks: Cell::new(0),
            secrets: Arc::new(Mutex::new(Vec::new())),
            work: Default::default(),
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
        rotate_token: Arc<Mutex<Option<std::path::PathBuf>>>,
        rotate_at: Arc<Mutex<Option<usize>>>,
        remove_token: Arc<Mutex<Option<(usize, std::path::PathBuf)>>>,
        reject_at: Arc<Mutex<Option<usize>>>,
        // REST validators received, and the 304s answered to them.
        validators: Arc<Mutex<Vec<String>>>,
        revalidated: Arc<AtomicUsize>,
        fail: Arc<AtomicBool>,
    }

    async fn fake(
        State(fake): State<Fake>,
        uri: axum::extract::OriginalUri,
        headers: HeaderMap,
        body: String,
    ) -> axum::response::Response {
        use axum::{http::StatusCode, response::IntoResponse};
        let call = fake.calls.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut remove = fake.remove_token.lock().unwrap();
            if remove.as_ref().is_some_and(|(at, _)| *at == call) {
                std::fs::remove_file(remove.take().unwrap().1).unwrap();
            }
        }
        fake.auth
            .lock()
            .unwrap()
            .push(headers["authorization"].to_str().unwrap().to_owned());
        if *fake.reject_at.lock().unwrap() == Some(call) {
            return (StatusCode::UNAUTHORIZED, "not JSON").into_response();
        }
        if fake.fail.load(Ordering::SeqCst) {
            return (StatusCode::BAD_GATEWAY, "upstream failure").into_response();
        }
        if fake.rotate_at.lock().unwrap().is_none_or(|at| at == call)
            && let Some(path) = fake.rotate_token.lock().unwrap().take()
        {
            std::fs::write(path, "fixture-rotated").unwrap();
        }
        let query: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        if query.is_null() {
            let body = if uri.path().contains("/actions/") {
                json!({"total_count":0, "workflow_runs":[]})
            } else {
                match fake.usage.lock().unwrap().clone() {
                    Some(usage) => {
                        json!([{"user":{"login":"robot"}, "body": format!("<!-- bot-usage v1 -->\n```json\n{usage}\n```")}])
                    }
                    None => json!([]),
                }
            };
            // A content validator: the same for every credential, so only the
            // service's scoping can keep one identity's from another's reads.
            let etag = format!("\"{:x}\"", Sha256::digest(body.to_string()));
            if let Some(validator) = headers.get("if-none-match") {
                let validator = validator.to_str().unwrap().to_owned();
                fake.validators.lock().unwrap().push(validator.clone());
                if validator == etag {
                    fake.revalidated.fetch_add(1, Ordering::SeqCst);
                    return (StatusCode::NOT_MODIFIED, [("etag", etag)]).into_response();
                }
            }
            return ([("etag", etag)], Json(body)).into_response();
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
        Json(json!({"data":data})).into_response()
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
        let cold_sends = fake.calls.load(Ordering::SeqCst);
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
        reader.pacing.lock().unwrap().until = None;
        let lost = reader.refresh(None, AT).await;
        assert_eq!(
            first.items, lost.items,
            "losing disposable state changes no authority"
        );
        reader.pacing.lock().unwrap().until = None;
        let repeated = reader.refresh(Some(&first), AT).await;
        let repeated_sends = fake.calls.load(Ordering::SeqCst) - 2 * cold_sends;
        eprintln!(
            "synthetic direct preview: cold={cold_sends} sends, repeated={repeated_sends} sends; charged requests not measured"
        );
        assert_eq!(repeated_sends, cold_sends);
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
        reader.pacing.lock().unwrap().until = None;
        let partial = reader.refresh(Some(&first), "2026-11-09T12:01:00Z").await;
        assert!(!partial.complete);
        assert_eq!(partial.read_at.as_deref(), Some("2026-11-09T12:01:00Z"));
        assert!(partial.error.is_some());
        assert!(partial.items[0]["failures"].as_u64().unwrap() > 0);
        fake.partial.store(false, Ordering::SeqCst);
        *reader.pacing.lock().unwrap() = Pacing::default();
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
    async fn between_preview_rotation_cannot_retain_throttled_old_identity() {
        let fake = Fake::default();
        let root = serve(fake.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        std::fs::write(&file, "fixture-before").unwrap();
        let reader = reader(Some(root), TokenSource::File(file.clone()));
        let first = reader.refresh(None, AT).await;
        assert_eq!(first.items.len(), 1);
        // The fixture lacks complete usage; seed a prior complete success to
        // verify its age cannot cross the credential boundary either.
        reader.pacing.lock().unwrap().last_success = Some(tokio::time::Instant::now());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(any(move || {
                    let count = count.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        (axum::http::StatusCode::TOO_MANY_REQUESTS, Json(json!({})))
                    }
                })),
            )
            .await
            .unwrap();
        });
        let mut throttled = reader.clone();
        throttled.api_root = Some(format!("http://{address}"));
        reader.pacing.lock().unwrap().until = None;
        let same = throttled.refresh(Some(&first), AT).await;
        assert_eq!(same.items, first.items);
        assert_eq!(same.read_at, first.read_at);
        assert!(reader.status().last_success_age_seconds.is_some());

        std::fs::write(&file, "fixture-after").unwrap();
        reader.pacing.lock().unwrap().until = None;
        let changed = throttled.refresh(Some(&same), AT).await;
        assert!(changed.items.is_empty(), "{changed:?}");
        assert_eq!(changed.read_at, None);
        assert!(!changed.complete);
        assert_eq!(changed.error.as_deref(), Some("board preview rate limited"));
        assert_eq!(reader.status().last_success_age_seconds, None);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let skipped = throttled.refresh(Some(&changed), AT).await;
        assert!(skipped.items.is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        reader.pacing.lock().unwrap().until = None;
        let recovered = reader.refresh(Some(&skipped), AT).await;
        assert_eq!(recovered.items, first.items);
        assert_eq!(recovered.read_at.as_deref(), Some(AT));
        assert_eq!(
            fake.auth.lock().unwrap().last().unwrap(),
            "Bearer fixture-after"
        );
        server.abort();
    }

    #[tokio::test]
    async fn mid_preview_rotation_discards_evidence_and_recovers() {
        let fake = Fake::default();
        let root = serve(fake.clone()).await;
        let dir =
            std::env::temp_dir().join(format!("review-board-rotation-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("token");
        std::fs::write(&file, "fixture-original").unwrap();
        let reader = reader(Some(root), TokenSource::File(file.clone()));
        let previous = reader.refresh(None, AT).await;
        assert_eq!(previous.items.len(), 1);
        *reader.pacing.lock().unwrap() = Pacing::default();
        // The minimal fixture omits usage coverage. Model an earlier complete
        // success so invalidation must clear its age, not just an already-null age.
        reader.pacing.lock().unwrap().finished(true, true, 0);
        let before = fake.calls.load(Ordering::SeqCst);
        *fake.rotate_token.lock().unwrap() = Some(file);

        let changed = reader.refresh(Some(&previous), AT).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), before + 1);
        assert!(
            changed.items.is_empty(),
            "must not retain old-identity evidence"
        );
        assert_eq!(changed.read_at, None);
        assert!(!changed.complete);
        assert_eq!(
            changed.error.as_deref(),
            Some("board preview credential changed")
        );
        assert_eq!(reader.status().consecutive_failures, 1);
        assert_eq!(reader.status().last_success_age_seconds, None);
        assert!(
            !fake
                .auth
                .lock()
                .unwrap()
                .iter()
                .any(|a| a.contains("rotated"))
        );

        // The existing cooldown applies; no immediate retry or credential loop.
        reader.refresh(Some(&changed), AT).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), before + 1);
        *reader.pacing.lock().unwrap() = Pacing::default();
        let recovered = reader.refresh(Some(&changed), AT).await;
        assert_eq!(recovered.items, previous.items);
        assert!(
            fake.auth
                .lock()
                .unwrap()
                .iter()
                .skip(before + 1)
                .all(|a| a == "Bearer fixture-rotated")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn final_response_rotation_discards_preview_and_prior_evidence() {
        let fake = Fake::default();
        let root = serve(fake.clone()).await;
        let dir = std::env::temp_dir().join(format!(
            "review-board-final-rotation-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("token");
        std::fs::write(&file, "fixture-original").unwrap();
        let mut reader = reader(Some(root), TokenSource::File(file.clone()));
        let mut config: Value = serde_json::from_str(&reader.config).unwrap();
        config["usage"].as_object_mut().unwrap().remove("url");
        reader.config = Arc::new(config.to_string());
        let previous = reader.refresh(None, AT).await;
        assert_eq!(previous.items[0]["failures"], 0);
        let count = fake.calls.load(Ordering::SeqCst);
        assert!(count > 0);
        *fake.rotate_at.lock().unwrap() = Some(2 * count);
        *fake.rotate_token.lock().unwrap() = Some(file);
        reader.pacing.lock().unwrap().finished(true, true, 0);

        let changed = reader.refresh(Some(&previous), AT).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2 * count);
        assert!(changed.items.is_empty());
        assert_eq!(changed.read_at, None);
        assert!(!changed.complete);
        assert_eq!(
            changed.error.as_deref(),
            Some("board preview credential changed")
        );
        assert_eq!(reader.status().consecutive_failures, 1);
        reader.refresh(Some(&changed), AT).await;
        assert_eq!(reader.status().last_success_age_seconds, None);
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2 * count);

        reader.pacing.lock().unwrap().until = None;
        let recovered = reader.refresh(Some(&changed), AT).await;
        assert_eq!(recovered.items, previous.items);
        assert_eq!(reader.status().consecutive_failures, 0);
        assert!(
            fake.auth
                .lock()
                .unwrap()
                .iter()
                .skip(2 * count)
                .all(|auth| auth == "Bearer fixture-rotated")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn unavailable_credential_discards_evidence_and_recovers() {
        for stage in ["before", "first", "last"] {
            let fake = Fake::default();
            let root = serve(fake.clone()).await;
            let dir = std::env::temp_dir().join(format!(
                "review-board-unavailable-{stage}-{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let file = dir.join("token");
            std::fs::write(&file, "fixture-original").unwrap();
            let mut reader = reader(Some(root), TokenSource::File(file.clone()));
            let mut config: Value = serde_json::from_str(&reader.config).unwrap();
            config["usage"].as_object_mut().unwrap().remove("url");
            reader.config = Arc::new(config.to_string());
            let previous = reader.refresh(None, AT).await;
            assert_eq!(previous.items[0]["failures"], 0);
            let count = fake.calls.load(Ordering::SeqCst);
            assert!(count > 1);
            *reader.pacing.lock().unwrap() = Pacing::default();
            reader.pacing.lock().unwrap().finished(true, true, 0);
            let sends = match stage {
                "before" => {
                    std::fs::remove_file(&file).unwrap();
                    0
                }
                "first" => 1,
                "last" => count,
                _ => unreachable!(),
            };
            if sends > 0 {
                *fake.remove_token.lock().unwrap() = Some((count + sends, file.clone()));
            }

            let changed = reader.refresh(Some(&previous), AT).await;
            assert!(changed.items.is_empty(), "{stage}: {changed:?}");
            assert_eq!(changed.read_at, None);
            assert!(!changed.complete);
            assert_eq!(
                changed.error.as_deref(),
                Some("board preview credential changed")
            );
            assert_eq!(fake.calls.load(Ordering::SeqCst), count + sends);
            assert_eq!(reader.status().consecutive_failures, 1);
            assert_eq!(reader.status().last_success_age_seconds, None);

            // Restoration does not bypass backoff or replay the discarded view.
            std::fs::write(&file, "fixture-restored").unwrap();
            let waiting = reader.refresh(Some(&changed), AT).await;
            assert!(waiting.items.is_empty());
            assert_eq!(fake.calls.load(Ordering::SeqCst), count + sends);
            reader.pacing.lock().unwrap().until = None;
            let recovered = reader.refresh(Some(&changed), AT).await;
            assert_eq!(recovered.items, previous.items);
            assert_eq!(reader.status().consecutive_failures, 0);
            assert_eq!(reader.status().last_success_age_seconds, None);
            assert!(
                fake.auth
                    .lock()
                    .unwrap()
                    .iter()
                    .skip(count + sends)
                    .all(|auth| auth == "Bearer fixture-restored")
            );
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn token_timeout_marks_identity_unverified_but_forge_timeout_does_not() {
        for token_pending in [false, true] {
            let work = Work::default();
            let result = tokio::time::timeout(REQUEST_TIMEOUT, async {
                preview_token(&work, async {
                    if token_pending {
                        std::future::pending::<()>().await;
                    }
                    Ok("fixture".into())
                })
                .await
                .unwrap();
                std::future::pending::<()>().await;
            })
            .await;
            assert!(result.is_err());
            assert_eq!(
                work.credential_changed.load(Ordering::SeqCst),
                token_pending
            );
        }
        let work = Work::default();
        work.credential_changed.store(true, Ordering::SeqCst);
        preview_token(&work, async { Ok("fixture".into()) })
            .await
            .unwrap();
        assert!(work.credential_changed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn stalled_token_exchange_discards_previous_preview_and_recovers() {
        use axum::{Router, routing::get};
        use std::sync::atomic::AtomicUsize;

        let fake = Fake::default();
        let root = serve(fake.clone()).await;
        let mut reader = reader(Some(root), TokenSource::Fixed("fixture".into()));
        let mut config: Value = serde_json::from_str(&reader.config).unwrap();
        config["usage"].as_object_mut().unwrap().remove("url");
        reader.config = Arc::new(config.to_string());
        let previous = reader.refresh(None, AT).await;
        assert_eq!(previous.items.len(), 1);
        assert_eq!(previous.items[0]["failures"], 0);
        *reader.pacing.lock().unwrap() = Pacing::default();
        let calls = fake.calls.load(Ordering::SeqCst);

        let exchanges = Arc::new(AtomicUsize::new(0));
        reader.pacing.lock().unwrap().finished(true, true, 0);
        let count = exchanges.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/sts/exchange",
                    get(move || {
                        let count = count.clone();
                        async move {
                            count.fetch_add(1, Ordering::SeqCst);
                            std::future::pending::<String>().await
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let file =
            std::env::temp_dir().join(format!("review-board-stalled-sts-{}", std::process::id()));
        std::fs::write(&file, "fixture-oidc").unwrap();
        reader.token = Arc::new(TokenSource::OctoSts(
            crate::token::OctoSts::new(
                &format!("http://{address}"),
                "fixture".into(),
                "fixture".into(),
                file.clone(),
            )
            .unwrap(),
        ));

        // The request's ten-second deadline, not STS's thirty-second deadline,
        // cancels acquisition. Bound the regression even if admission breaks.
        let changed = tokio::time::timeout(
            REQUEST_TIMEOUT + Duration::from_secs(5),
            reader.refresh(Some(&previous), AT),
        )
        .await
        .unwrap();
        assert!(changed.items.is_empty(), "{changed:?}");
        assert_eq!(changed.read_at, None);
        assert!(!changed.complete);
        assert_eq!(
            changed.error.as_deref(),
            Some("board preview credential changed")
        );
        assert_eq!(exchanges.load(Ordering::SeqCst), 1);
        assert_eq!(fake.calls.load(Ordering::SeqCst), calls);
        assert_eq!(reader.status().consecutive_failures, 1);

        reader.token = Arc::new(TokenSource::Fixed("fixture-restored".into()));
        assert_eq!(reader.status().last_success_age_seconds, None);
        let waiting = reader.refresh(Some(&changed), AT).await;
        assert!(waiting.items.is_empty());
        assert_eq!(fake.calls.load(Ordering::SeqCst), calls);
        reader.pacing.lock().unwrap().until = None;
        let recovered = reader.refresh(Some(&changed), AT).await;
        assert_eq!(recovered.items, previous.items);
        assert_eq!(reader.status().consecutive_failures, 0);
        server.abort();
        std::fs::remove_file(file).unwrap();
    }

    #[tokio::test]
    async fn rejected_credential_discards_evidence_and_recovers() {
        for stage in ["first", "last"] {
            let fake = Fake::default();
            let root = serve(fake.clone()).await;
            let mut reader = reader(Some(root), TokenSource::Fixed("fixture".into()));
            let mut config: Value = serde_json::from_str(&reader.config).unwrap();
            config["usage"].as_object_mut().unwrap().remove("url");
            reader.config = Arc::new(config.to_string());
            let previous = reader.refresh(None, AT).await;
            assert_eq!(previous.items[0]["failures"], 0);
            let count = fake.calls.load(Ordering::SeqCst);
            assert!(count > 1);
            let sends = if stage == "first" { 1 } else { count };
            *fake.reject_at.lock().unwrap() = Some(count + sends);
            reader.pacing.lock().unwrap().finished(true, true, 0);

            let rejected = reader.refresh(Some(&previous), AT).await;
            assert!(rejected.items.is_empty(), "{stage}: {rejected:?}");
            assert_eq!(rejected.read_at, None);
            assert!(!rejected.complete);
            assert_eq!(
                rejected.error.as_deref(),
                Some("board preview credential changed")
            );
            assert_eq!(fake.calls.load(Ordering::SeqCst), count + sends);
            assert_eq!(reader.status().consecutive_failures, 1);

            // No retry burst or replay of facts after the forge rejects auth.
            assert_eq!(reader.status().last_success_age_seconds, None);
            let waiting = reader.refresh(Some(&rejected), AT).await;
            assert!(waiting.items.is_empty());
            assert_eq!(fake.calls.load(Ordering::SeqCst), count + sends);
            reader.pacing.lock().unwrap().until = None;
            let recovered = reader.refresh(Some(&rejected), AT).await;
            assert_eq!(recovered.items, previous.items);
            assert_eq!(reader.status().consecutive_failures, 0);
        }
    }

    const NOT_STATE: &str = "not a pass state file";

    /// The board config with board-forge's state gate, naming a file that is
    /// not a state file: reading it would fail the preview.
    fn gated(mut reader: Reader, dir: &Path) -> Reader {
        std::fs::write(dir.join("pass-state.json"), NOT_STATE).unwrap();
        let mut config: Value = serde_json::from_str(&reader.config).unwrap();
        config["usage"].as_object_mut().unwrap().remove("url");
        config["state"] = dir.join("pass-state.json").to_str().unwrap().into();
        reader.config = Arc::new(config.to_string());
        reader
    }

    fn untouched(dir: &Path) {
        assert_eq!(
            std::fs::read_to_string(dir.join("pass-state.json")).unwrap(),
            NOT_STATE
        );
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["pass-state.json", "token"], "no state is written");
    }

    /// One refresh: what it published, its sends and the validators it sent.
    async fn counted(
        reader: &Reader,
        fake: &Fake,
        prev: Option<&Section<Value>>,
    ) -> (Section<Value>, usize, usize) {
        let (sends, validators) = (
            fake.calls.load(Ordering::SeqCst),
            fake.validators.lock().unwrap().len(),
        );
        reader.pacing.lock().unwrap().until = None;
        let section = reader.refresh(prev, AT).await;
        (
            section,
            fake.calls.load(Ordering::SeqCst) - sends,
            fake.validators.lock().unwrap().len() - validators,
        )
    }

    #[test]
    fn warm_input_carries_only_scoped_responses() {
        let responses = board_forge::poll::State {
            response_scope: Some("fixture-scope".into()),
            responses: BTreeMap::from([("poll-read".into(), json!({"etag":"one"}))]),
            pass_responses: BTreeMap::from([("pass-read".into(), json!({"etag":"two"}))]),
            ..Default::default()
        };
        // Simulate a budgeted preview that returned progress along with its
        // response evidence. A warm preview must start from the cold positions.
        let output = board_forge::poll::State {
            scan_cursor: Some("example/repo#1".into()),
            follow_cursor: Some("example/repo".into()),
            holds_pending: vec!["example/repo#2".into()],
            ..responses.clone()
        };
        let carried = Carried::new("fixture-context".into(), output).unwrap();
        assert_eq!(carried.into_state(), responses);
        assert!(Carried::new("fixture-context".into(), Default::default()).is_none());
    }

    #[tokio::test]
    async fn warm_previews_revalidate_responses_without_replaying_a_snapshot() {
        let fake = Fake::default();
        *fake.usage.lock().unwrap() = Some(json!({"schema":"bot-usage/v1", "updated_at":AT,
            "pools":{"test":{"observed_at":AT,"used_percent":10,"allowed_percent":50,"hold":false}}}));
        let root = serve(fake.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("token"), "fixture-one").unwrap();
        let token = TokenSource::File(dir.path().join("token"));
        let reader = gated(reader(Some(root.clone()), token), dir.path());

        let (cold, cold_sends, validators) = counted(&reader, &fake, None).await;
        assert_eq!(cold.items[0]["failures"], 0, "{cold:?}");
        assert_eq!(validators, 0);
        let status = reader.status();
        assert_eq!(status.network_sends, cold_sends);
        let cold_charged = status.charged_requests.unwrap();
        assert!(reader.carried.lock().unwrap().is_some());

        let (warm, warm_sends, validators) = counted(&reader, &fake, Some(&cold)).await;
        let status = reader.status();
        let warm_charged = status.charged_requests.unwrap();
        eprintln!(
            "gated preview: cold {cold_sends} sends/{cold_charged} charged; warm {warm_sends} sends/{warm_charged} charged, {} 304s",
            fake.revalidated.load(Ordering::SeqCst)
        );
        assert_eq!(warm.items, cold.items, "reuse changes no decision");
        assert_eq!(warm.read_at, cold.read_at);
        assert!(validators > 0);
        assert_eq!(fake.revalidated.load(Ordering::SeqCst), validators);
        // A 304 still costs a send; board-forge refunds it from its budget.
        assert_eq!(status.network_sends, warm_sends);
        assert_eq!(warm_sends, cold_sends);
        assert_eq!(warm_charged, cold_charged - validators);
        // The counts service/README.md quotes.
        assert_eq!(
            (cold_sends, cold_charged, warm_charged, validators),
            (9, 9, 4, 5)
        );

        // On this board, losing the response index makes revalidation cold.
        *reader.carried.lock().unwrap() = None;
        let (lost, sends, validators) = counted(&reader, &fake, Some(&warm)).await;
        assert_eq!(
            (lost.items.as_slice(), sends, validators),
            (&cold.items[..], cold_sends, 0)
        );
        assert_eq!(reader.status().charged_requests, Some(cold_charged));
        let restarted = gated(
            self::reader(Some(root), TokenSource::File(dir.path().join("token"))),
            dir.path(),
        );
        let (fresh, sends, validators) = counted(&restarted, &fake, None).await;
        assert_eq!(
            (fresh.items.as_slice(), sends, validators),
            (&cold.items[..], cold_sends, 0)
        );
        untouched(dir.path());
    }

    #[tokio::test]
    async fn dropping_completed_worker_result_does_not_accept_responses() {
        use std::future::Future;
        use std::task::{Context, Wake, Waker};

        struct Ready(tokio::sync::Notify);

        impl Wake for Ready {
            fn wake(self: Arc<Self>) {
                self.0.notify_one();
            }
        }

        let fake = Fake::default();
        let root = serve(fake.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        let reader = gated(
            reader(Some(root), TokenSource::Fixed("fixture".into())),
            dir.path(),
        );
        let (first, cold_sends, _) = counted(&reader, &fake, None).await;
        assert!(reader.carried.lock().unwrap().is_some());
        let ready = Arc::new(Ready(tokio::sync::Notify::new()));
        let waker = Waker::from(ready.clone());
        let mut refresh = Box::pin(reader.refresh(Some(&first), AT));
        assert!(
            refresh
                .as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        // The join handle wakes the caller with a finished result. Drop the
        // caller before it polls again, rather than aborting an active request.
        tokio::time::timeout(Duration::from_secs(2), ready.0.notified())
            .await
            .unwrap();
        assert_eq!(reader.active.available_permits(), 0);
        assert!(fake.revalidated.load(Ordering::SeqCst) > 0);
        drop(refresh);
        drop(
            tokio::time::timeout(Duration::from_secs(2), reader.active.acquire())
                .await
                .unwrap()
                .unwrap(),
        );
        assert!(reader.carried.lock().unwrap().is_none());
        let (_, sends, validators) = counted(&reader, &fake, Some(&first)).await;
        assert_eq!((sends, validators), (cold_sends, 0));
    }

    #[tokio::test]
    async fn without_the_state_gate_previews_read_directly() {
        let fake = Fake::default();
        let root = serve(fake.clone()).await;
        let mut reader = reader(Some(root), TokenSource::Fixed("fixture".into()));
        let mut config: Value = serde_json::from_str(&reader.config).unwrap();
        config["usage"].as_object_mut().unwrap().remove("url");
        reader.config = Arc::new(config.to_string());
        let (first, cold_sends, _) = counted(&reader, &fake, None).await;
        let (second, sends, validators) = counted(&reader, &fake, Some(&first)).await;
        assert_eq!(second.items, first.items);
        assert_eq!((sends, validators), (cold_sends, 0));
        assert!(reader.carried.lock().unwrap().is_none());
        assert_eq!(reader.status().network_sends, cold_sends);
        assert_eq!(reader.status().charged_requests, Some(cold_sends));
    }

    #[tokio::test]
    async fn credential_changes_never_reuse_old_identity_state() {
        let fake = Fake::default();
        let root = serve(fake.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        std::fs::write(&file, "fixture-one").unwrap();
        let reader = gated(
            reader(Some(root), TokenSource::File(file.clone())),
            dir.path(),
        );
        let (cold, cold_sends, _) = counted(&reader, &fake, None).await;
        assert_eq!(cold.items[0]["failures"], 0, "{cold:?}");

        // Between refreshes: the new identity reads cold, then warms its own.
        std::fs::write(&file, "fixture-two").unwrap();
        let (rotated, sends, validators) = counted(&reader, &fake, Some(&cold)).await;
        assert_eq!((sends, validators), (cold_sends, 0));
        assert_eq!(rotated.items, cold.items);
        let (_, _, validators) = counted(&reader, &fake, Some(&rotated)).await;
        assert!(validators > 0);

        // During a refresh: no decision, evidence or state survives it.
        let before = fake.calls.load(Ordering::SeqCst);
        *fake.rotate_at.lock().unwrap() = Some(before + 1);
        *fake.rotate_token.lock().unwrap() = Some(file.clone());
        let (changed, sends, _) = counted(&reader, &fake, Some(&rotated)).await;
        assert_eq!(sends, 1);
        assert!(changed.items.is_empty(), "{changed:?}");
        assert_eq!(
            changed.error.as_deref(),
            Some("board preview credential changed")
        );
        assert!(reader.carried.lock().unwrap().is_none());
        assert_eq!(reader.status().charged_requests, None);
        assert_eq!(reader.status().network_sends, 1);
        let (recovered, sends, validators) = counted(&reader, &fake, Some(&changed)).await;
        assert_eq!((sends, validators), (cold_sends, 0));
        assert_eq!(recovered.items, cold.items);
        assert!(
            fake.auth
                .lock()
                .unwrap()
                .iter()
                .skip(before + 1)
                .all(|auth| auth == "Bearer fixture-rotated")
        );

        // An unreadable credential before any send also drops the state.
        assert!(reader.carried.lock().unwrap().is_some());
        std::fs::remove_file(&file).unwrap();
        let (unreadable, sends, _) = counted(&reader, &fake, Some(&recovered)).await;
        assert_eq!(sends, 0);
        assert!(unreadable.items.is_empty());
        assert!(reader.carried.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn partial_and_failed_refreshes_keep_stale_semantics() {
        let fake = Fake::default();
        let root = serve(fake.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("token"), "fixture").unwrap();
        let token = TokenSource::File(dir.path().join("token"));
        let reader = gated(reader(Some(root), token), dir.path());
        let (cold, cold_sends, _) = counted(&reader, &fake, None).await;

        fake.partial.store(true, Ordering::SeqCst);
        let (partial, _, _) = counted(&reader, &fake, Some(&cold)).await;
        assert!(partial.items[0]["failures"].as_u64().unwrap() > 0);
        assert!(partial.error.is_some());
        assert!(reader.carried.lock().unwrap().is_some());
        fake.partial.store(false, Ordering::SeqCst);

        fake.fail.store(true, Ordering::SeqCst);
        let (failed, sends, _) = counted(&reader, &fake, Some(&partial)).await;
        // board-forge reports upstream failures as a partial observation.
        assert!(!failed.complete);
        assert_eq!(
            failed.error.as_deref(),
            Some("board preview has incomplete reads")
        );
        assert!(failed.items[0]["failures"].as_u64().unwrap() > 0);
        let status = reader.status();
        assert_eq!(
            (status.network_sends, status.charged_requests),
            (sends, Some(1))
        );
        assert!(reader.carried.lock().unwrap().is_some());
        fake.fail.store(false, Ordering::SeqCst);
        *reader.pacing.lock().unwrap() = Pacing::default();
        let (recovered, _, validators) = counted(&reader, &fake, Some(&failed)).await;
        assert_eq!(recovered.items, cold.items);
        assert!(validators > 0, "the returned state stays warm");

        // A preview that returns nothing commits nothing: the next is cold.
        let mut invalid = reader.clone();
        invalid.config = Arc::new("{}".into());
        let (stale, sends, _) = counted(&invalid, &fake, Some(&recovered)).await;
        assert_eq!(sends, 0);
        assert_eq!(stale.items, recovered.items);
        assert_eq!(stale.read_at, recovered.read_at);
        assert_eq!(stale.error.as_deref(), Some("board preview unavailable"));
        assert!(reader.carried.lock().unwrap().is_none());
        let (_, sends, validators) = counted(&reader, &fake, Some(&stale)).await;
        assert_eq!((sends, validators), (cold_sends, 0));
        untouched(dir.path());
    }

    #[tokio::test]
    async fn context_checks_bind_cache_hits_to_the_pinned_credential() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        std::fs::write(&file, "fixture-one").unwrap();
        let runtime = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let _guard = runtime.enter();
            let fixed = direct(reader(None, TokenSource::Fixed("fixture".into())));
            let context = fixed.cache_context().unwrap();
            assert_eq!(fixed.cache_context().unwrap(), context);
            assert!(!context.contains("fixture"));
            fixed.checks.set(MAX_CONTEXT_CHECKS);
            assert!(fixed.cache_context().is_none(), "checks are bounded");

            // No send happens here: the check alone rereads the source.
            let client = direct(reader(None, TokenSource::File(file.clone())));
            let one = client.cache_context().unwrap();
            assert_ne!(one, context);
            std::fs::write(&file, "fixture-two").unwrap();
            assert!(client.cache_context().is_none());
            assert!(client.work.credential_changed.load(Ordering::SeqCst));
            std::fs::write(&file, "fixture-one").unwrap();
            assert!(
                client.cache_context().is_none(),
                "switching back is not enough"
            );

            let client = direct(reader(None, TokenSource::File(file.clone())));
            assert_eq!(client.cache_context().unwrap(), one);
            std::fs::remove_file(&file).unwrap();
            assert!(client.cache_context().is_none());
            assert!(client.work.credential_changed.load(Ordering::SeqCst));
            assert_eq!(client.network_requests(), Some(0));
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn one_shot_emits_existing_envelope_and_reports_partial_reads() {
        let fake = Fake::default();
        let root = serve(fake.clone()).await;
        let mut reader = reader(Some(root), TokenSource::Fixed("fixture".into()));
        let mut config: Value = serde_json::from_str(&reader.config).unwrap();
        config["usage"].as_object_mut().unwrap().remove("url");
        reader.config = Arc::new(config.to_string());
        for partial in [false, true] {
            fake.partial.store(partial, Ordering::SeqCst);
            let state = crate::preview_once(&reader, || AT.into()).await;
            let mut output = Vec::new();
            let result = crate::write_preview(&state, &mut output);
            // This minimal config omits needs-you and usage evidence, so even
            // failure-free reads must not be advertised as complete coverage.
            assert!(result.is_err());
            let value: Value = serde_json::from_slice(&output).unwrap();
            assert_eq!(value["schema"], crate::state::SCHEMA);
            assert_eq!(value["generation"], 1);
            assert_eq!(value["refreshedAt"], AT);
            assert_eq!(value["decision"]["readAt"], AT);
            assert_eq!(value["decision"]["complete"], false);
            assert_eq!(value["decision"]["items"][0]["failures"] == 0, !partial);
            assert_eq!(value["decision"]["items"][0]["schema"], decision::SCHEMA);
            assert_eq!(
                value["decision"]["items"][0]["confirmed_effects"]["comments_created"],
                0
            );
            for section in ["runs", "prs", "waiting"] {
                assert_eq!(value[section]["complete"], false);
                assert_eq!(value[section]["readAt"], Value::Null);
                assert_eq!(value[section]["items"], json!([]));
            }
            assert!(fake.calls.load(Ordering::SeqCst) <= 2 * MAX_REQUESTS);
        }
        // An unavailable observation is still a JSON document, not empty stdout
        // or an invented successful result. It does not retry the failed pass.
        reader.config = Arc::new("{}".into());
        *reader.pacing.lock().unwrap() = Pacing::default();
        let calls = fake.calls.load(Ordering::SeqCst);
        let state = crate::preview_once(&reader, || AT.into()).await;
        let mut output = Vec::new();
        assert!(crate::write_preview(&state, &mut output).is_err());
        let value: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(value["decision"]["items"], json!([]));
        assert_eq!(value["decision"]["readAt"], Value::Null);
        assert_eq!(fake.calls.load(Ordering::SeqCst), calls);
    }

    #[tokio::test]
    async fn header_throttles_skip_stalled_bodies_but_recheck_credentials() {
        use axum::{body::Body, http::StatusCode, response::IntoResponse};

        for status in [403, 429, 503] {
            for rotate in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let file = dir.path().join("token");
                tokio::fs::write(&file, "fixture-before").await.unwrap();
                let calls = Arc::new(AtomicUsize::new(0));
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let root = format!("http://{}", listener.local_addr().unwrap());
                let server = tokio::spawn({
                    let file = file.clone();
                    let calls = calls.clone();
                    async move {
                        axum::serve(
                            listener,
                            Router::new().fallback(any(move || {
                                let file = file.clone();
                                let calls = calls.clone();
                                async move {
                                    calls.fetch_add(1, Ordering::SeqCst);
                                    if rotate {
                                        tokio::fs::write(file, "fixture-after").await.unwrap();
                                    }
                                    (
                                        StatusCode::from_u16(status).unwrap(),
                                        [("retry-after", "600")],
                                        Body::from_stream(futures_util::stream::pending::<
                                            Result<axum::body::Bytes, std::io::Error>,
                                        >(
                                        )),
                                    )
                                        .into_response()
                                }
                            })),
                        )
                        .await
                        .unwrap();
                    }
                });
                let reader = reader(Some(root), TokenSource::File(file));
                let runtime = tokio::runtime::Handle::current();
                let work = Arc::new(Work::default());
                let cancel = CancelOnDrop(work.clone());
                let request = tokio::task::spawn_blocking({
                    let reader = reader.clone();
                    let work = work.clone();
                    move || {
                        let _guard = runtime.enter();
                        let mut client = direct(reader);
                        client.work = work;
                        client
                            .get("https://api.github.com/stalled", None)
                            .err()
                            .unwrap()
                    }
                });
                let result = tokio::time::timeout(Duration::from_secs(2), request).await;
                drop(cancel);
                server.abort();
                let error = result
                    .expect("throttle must not wait for its body")
                    .unwrap();
                assert_eq!(error.is::<board_forge::github::RateLimited>(), !rotate);
                assert_eq!(work.credential_changed.load(Ordering::SeqCst), rotate);
                assert_eq!(calls.load(Ordering::SeqCst), 1);
                let status = reader.status();
                assert!(status.retry_in_seconds >= 598);
                assert_eq!(status.rate_limit.unwrap().retry_after_seconds, Some(600));
                for _ in 0..3 {
                    reader.refresh(None, AT).await;
                }
                assert_eq!(calls.load(Ordering::SeqCst), 1);
            }
        }
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
                *client.reader.pacing.lock().unwrap() = Pacing::default();
                let url = format!("https://api.github.com/{status}");
                assert!(
                    client
                        .get(&url, None)
                        .err()
                        .unwrap()
                        .is::<board_forge::github::NotFound>()
                );
                *client.reader.pacing.lock().unwrap() = Pacing::default();
                assert_eq!(client.send("GET", &url, &Value::Null).unwrap().0, status);
            }
            for status in [403, 429] {
                *client.reader.pacing.lock().unwrap() = Pacing::default();
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
                *client.reader.pacing.lock().unwrap() = Pacing::default();
                assert!(
                    Transport::graphql(&client, "query { x }", error)
                        .unwrap_err()
                        .is::<board_forge::github::RateLimited>()
                );
            }
            *client.reader.pacing.lock().unwrap() = Pacing::default();
            assert!(
                client
                    .get("https://api.github.com/401", None)
                    .err()
                    .unwrap()
                    .is::<board_forge::github::AuthenticationRequired>()
            );
            assert!(client.work.credential_changed.load(Ordering::SeqCst));
            let requests = client.requests.get();
            assert!(client.get("https://api.github.com/200", None).is_err());
            assert_eq!(client.requests.get(), requests);
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
        for generation in 1..=5 {
            if generation != 4 {
                reader.pacing.lock().unwrap().until = None;
            }
            fake.partial.store(generation == 2, Ordering::SeqCst);
            let mut source = reader.clone();
            if generation == 3 {
                source.config = Arc::new("{}".into());
            }
            let prev = tx.borrow().clone();
            let sends_before = fake.calls.load(Ordering::SeqCst);
            let clocks = AtomicUsize::new(0);
            let state = crate::refresh_generation(
                &Recorded::fixture(),
                Some(&source),
                None::<(&Recorded, _)>,
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
            assert_eq!(
                value["decision"]["items"][0]["confirmed_effects"],
                json!({
                    "comments_created":0,"comments_edited":0,"starts":{},"starts_by_pool":{}
                })
            );
            assert_eq!(value["decision"]["items"][0]["observed_at"], AT);
            assert_eq!(
                value["decision"]["items"][0]["provenance"]["usage"],
                "observed"
            );
            if generation == 1 {
                // The TypeScript clients replay this exact producer output.
                let replay = json!({"schema": value["schema"], "generation": value["generation"],
                    "decision": value["decision"]});
                let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(PRODUCER_REPLAY);
                if std::env::var_os("UPDATE_FIXTURES").is_some() {
                    std::fs::write(&path, serde_json::to_string_pretty(&replay).unwrap() + "\n")
                        .unwrap();
                }
                let committed: Value =
                    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
                assert_eq!(
                    committed, replay,
                    "{PRODUCER_REPLAY} is stale; rerun with UPDATE_FIXTURES=1"
                );
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
            if generation == 4 {
                assert_eq!(fake.calls.load(Ordering::SeqCst), sends_before);
                assert_eq!(value["decision"]["items"], expected[2]["decision"]["items"]);
                assert_eq!(
                    value["decision"]["readAt"],
                    expected[2]["decision"]["readAt"]
                );
                assert_eq!(value["decision"]["error"], "board preview backing off");
                assert!(value["decisionRefresh"]["retryInSeconds"].as_u64().unwrap() > 0);
            }
            if generation == 5 {
                assert!(fake.calls.load(Ordering::SeqCst) > sends_before);
                assert_ne!(value["decision"]["error"], "board preview backing off");
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
