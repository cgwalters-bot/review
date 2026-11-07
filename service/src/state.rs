//! The control plane's state, built from GitHub queries on each refresh:
//! live Actions runs, the bot's open PRs with their merge state, and the
//! issues and PRs waiting on the operator. A section whose reads fail
//! keeps its last good items and says why it is stale.

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use futures_util::future::join_all;
use serde::Serialize;
use serde_json::Value;

use crate::github::Source;

pub const SCHEMA: &str = "review-service/v1";

/// Where runs come from: every workflow of the tracker (passes and the jobs
/// they dispatch), and the devspace agent runs (bin/bot-runs in homegit).
pub const RUN_SOURCES: &[(&str, Option<&str>)] = &[
    ("cgwalters-forge/tracker", None),
    ("bootc-dev/cgwalters-devspace-sandbox", Some("agent.yml")),
];

/// The run statuses that mean not finished, each its own list query.
const LIVE_STATUSES: &[&str] = &["requested", "waiting", "pending", "queued", "in_progress"];

/// Items per page, the API's maximum. Only the first page is read: a
/// longer list marks its section incomplete rather than paging on.
const PAGE_SIZE: usize = 100;

/// Merge-state reads in flight at once; GitHub's secondary limits punish more.
const CONCURRENCY: usize = 4;

/// The searches for what waits on the operator (OPERATOR in
/// src/github/config.ts), with the reason each gives.
/// `user-review-requested:` names him alone, not teams he is on.
const WAITING_QUERIES: &[(&str, &str)] = &[
    (
        "review-requested",
        "is:open archived:false user-review-requested:cgwalters",
    ),
    ("assigned", "is:open archived:false assignee:cgwalters"),
];

/// The bot's (BOT_LOGIN's) open PRs anywhere, as the app's OTHER_QUERY.
const BOT_PRS_QUERY: &str = "is:pr is:open archived:false author:cgwalters-bot";

/// One part of the state, as last read.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section<T> {
    pub items: Vec<T>,
    /// False when a list was longer than one page, or part of it unread.
    pub complete: bool,
    /// When `items` were read; null until the first read succeeds.
    pub read_at: Option<String>,
    /// Why the last read failed; `items` are then from `read_at`.
    pub error: Option<String>,
}

impl<T> Default for Section<T> {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            complete: false,
            read_at: None,
            error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub repository: String,
    /// The workflow's file name, e.g. agent.yml.
    pub workflow: String,
    pub id: u64,
    pub url: String,
    pub title: String,
    pub status: String,
    pub created_at: String,
    pub started_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pr {
    pub repository: String,
    pub number: u64,
    pub url: String,
    pub title: String,
    pub draft: bool,
    /// GitHub's mergeable_state (clean, dirty, blocked, behind, unstable,
    /// draft, unknown...); null if it couldn't be read.
    pub merge_state: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Waiting {
    pub repository: String,
    pub number: u64,
    pub url: String,
    pub title: String,
    pub pull_request: bool,
    /// Why it waits on him: review-requested, assigned, or both.
    pub reasons: Vec<&'static str>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub schema: &'static str,
    /// When the last refresh finished; null before the first.
    pub refreshed_at: Option<String>,
    pub runs: Section<Run>,
    pub prs: Section<Pr>,
    pub waiting: Section<Waiting>,
}

/// One repository's part of the state, case-insensitively by name.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoBoard<'a> {
    pub repository: String,
    pub runs: Vec<&'a Run>,
    pub prs: Vec<&'a Pr>,
    pub waiting: Vec<&'a Waiting>,
}

impl State {
    pub fn empty() -> Self {
        Self {
            schema: SCHEMA,
            ..Self::default()
        }
    }

    pub fn repo(&self, name: &str) -> RepoBoard<'_> {
        let on = |r: &str| r.eq_ignore_ascii_case(name);
        RepoBoard {
            repository: name.to_owned(),
            runs: self
                .runs
                .items
                .iter()
                .filter(|r| on(&r.repository))
                .collect(),
            prs: self
                .prs
                .items
                .iter()
                .filter(|p| on(&p.repository))
                .collect(),
            waiting: self
                .waiting
                .items
                .iter()
                .filter(|w| on(&w.repository))
                .collect(),
        }
    }
}

/// Read every section afresh; one that fails keeps `prev`'s items.
pub async fn refresh<S: Source>(src: &S, prev: &State, now: &str) -> State {
    fn section<T: Clone>(read: Result<(Vec<T>, bool)>, prev: &Section<T>, now: &str) -> Section<T> {
        match read {
            Ok((items, complete)) => Section {
                items,
                complete,
                read_at: Some(now.to_owned()),
                error: None,
            },
            Err(e) => Section {
                error: Some(format!("{e:#}")),
                ..prev.clone()
            },
        }
    }
    let (runs, prs, waiting) = tokio::join!(load_runs(src), load_prs(src), load_waiting(src));
    State {
        schema: SCHEMA,
        refreshed_at: Some(now.to_owned()),
        runs: section(runs, &prev.runs, now),
        prs: section(prs, &prev.prs, now),
        waiting: section(waiting, &prev.waiting, now),
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("answer has no string {key:?}"))
}

fn u64_of(v: &Value, key: &str) -> Result<u64> {
    v.get(key)
        .and_then(Value::as_u64)
        .with_context(|| format!("answer has no number {key:?}"))
}

fn list<'a>(v: &'a Value, key: &str) -> Result<&'a [Value]> {
    v.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .with_context(|| format!("answer has no list {key:?}"))
}

/// Whether a list answer holds all of its `total_count`.
fn whole(v: &Value, items: &[Value]) -> bool {
    v.get("total_count")
        .and_then(Value::as_u64)
        .is_some_and(|n| n as usize <= items.len())
}

/// OWNER/REPO from a github.com issue, PR or run URL.
fn repository_of(url: &str) -> Result<String> {
    let rest = url
        .strip_prefix("https://github.com/")
        .with_context(|| format!("{url} is not a github.com URL"))?;
    let mut parts = rest.split('/');
    match (parts.next(), parts.next()) {
        (Some(owner), Some(repo)) if !owner.is_empty() && !repo.is_empty() => {
            Ok(format!("{owner}/{repo}"))
        }
        _ => anyhow::bail!("{url} names no repository"),
    }
}

/// GET each path, CONCURRENCY at a time; the answers in the paths' order.
async fn get_all<S: Source>(src: &S, paths: &[String]) -> Vec<Result<Value>> {
    let mut answers = Vec::with_capacity(paths.len());
    for chunk in paths.chunks(CONCURRENCY) {
        answers.extend(join_all(chunk.iter().map(|p| src.get(p))).await);
    }
    answers
}

fn search_path(query: &str) -> String {
    format!("/search/issues?q={query}&sort=updated&order=desc&per_page={PAGE_SIZE}")
}

fn parse_run(v: &Value) -> Result<Run> {
    let url = str_of(v, "html_url")?;
    let workflow = str_of(v, "path")?;
    Ok(Run {
        repository: repository_of(url)?,
        workflow: workflow.rsplit('/').next().unwrap_or(workflow).to_owned(),
        id: u64_of(v, "id")?,
        url: url.to_owned(),
        title: str_of(v, "display_title")?.trim().to_owned(),
        status: str_of(v, "status")?.to_owned(),
        created_at: str_of(v, "created_at")?.to_owned(),
        started_at: v
            .get("run_started_at")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// Unfinished runs from RUN_SOURCES, newest first.
async fn load_runs<S: Source>(src: &S) -> Result<(Vec<Run>, bool)> {
    let mut paths = Vec::new();
    for (repo, workflow) in RUN_SOURCES {
        let base = match workflow {
            Some(w) => format!("/repos/{repo}/actions/workflows/{w}/runs"),
            None => format!("/repos/{repo}/actions/runs"),
        };
        paths.extend(
            LIVE_STATUSES
                .iter()
                .map(|s| format!("{base}?status={s}&per_page={PAGE_SIZE}")),
        );
    }
    let answers = get_all(src, &paths)
        .await
        .into_iter()
        .collect::<Result<Vec<_>>>()?;
    let mut complete = true;
    // A run can move between status lists while they are read; one entry per run.
    let mut runs = BTreeMap::new();
    for a in &answers {
        let items = list(a, "workflow_runs")?;
        complete &= whole(a, items);
        for r in items {
            let run = parse_run(r)?;
            runs.insert((run.repository.to_lowercase(), run.id), run);
        }
    }
    let mut runs: Vec<Run> = runs.into_values().collect();
    runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok((runs, complete))
}

/// An issue or PR from a search answer.
struct Hit {
    repository: String,
    number: u64,
    url: String,
    title: String,
    draft: bool,
    pull_request: bool,
    updated_at: String,
}

/// A search answer's items, and whether they are all it found.
fn search_hits(a: &Value) -> Result<(Vec<Hit>, bool)> {
    let items = list(a, "items")?;
    let hits = items
        .iter()
        .map(|i| {
            let url = str_of(i, "html_url")?;
            Ok(Hit {
                repository: repository_of(url)?,
                number: u64_of(i, "number")?,
                url: url.to_owned(),
                title: str_of(i, "title")?.to_owned(),
                draft: i.get("draft").and_then(Value::as_bool).unwrap_or(false),
                pull_request: i.get("pull_request").is_some(),
                updated_at: str_of(i, "updated_at")?.to_owned(),
            })
        })
        .collect::<Result<_>>()?;
    Ok((
        hits,
        whole(a, items) && a.get("incomplete_results") != Some(&Value::Bool(true)),
    ))
}

/// The bot's open PRs, most recently updated first, each with its merge
/// state read from the PR itself (search doesn't give it). A PR whose read
/// fails has none, and makes the section incomplete.
async fn load_prs<S: Source>(src: &S) -> Result<(Vec<Pr>, bool)> {
    let answer = src.get(&search_path(BOT_PRS_QUERY)).await?;
    let (hits, mut complete) = search_hits(&answer)?;
    let paths: Vec<String> = hits
        .iter()
        .map(|h| format!("/repos/{}/pulls/{}", h.repository, h.number))
        .collect();
    let pulls = get_all(src, &paths).await;
    let prs = hits
        .into_iter()
        .zip(pulls)
        .map(|(h, pull)| {
            let merge_state = pull.ok().and_then(|p| {
                p.get("mergeable_state")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            complete &= merge_state.is_some();
            Pr {
                repository: h.repository,
                number: h.number,
                url: h.url,
                title: h.title,
                draft: h.draft,
                merge_state,
                updated_at: h.updated_at,
            }
        })
        .collect();
    Ok((prs, complete))
}

/// Open issues and PRs assigned to him or requesting his review, most
/// recently updated first; one entry for an item with both reasons.
async fn load_waiting<S: Source>(src: &S) -> Result<(Vec<Waiting>, bool)> {
    let mut complete = true;
    let mut found: Vec<Waiting> = Vec::new();
    for (reason, query) in WAITING_QUERIES {
        let answer = src.get(&search_path(query)).await?;
        let (hits, whole) = search_hits(&answer)?;
        complete &= whole;
        for h in hits {
            if let Some(w) = found
                .iter_mut()
                .find(|w| w.number == h.number && w.repository.eq_ignore_ascii_case(&h.repository))
            {
                w.reasons.push(reason);
                continue;
            }
            found.push(Waiting {
                repository: h.repository,
                number: h.number,
                url: h.url,
                title: h.title,
                pull_request: h.pull_request,
                reasons: vec![reason],
                updated_at: h.updated_at,
            });
        }
    }
    found.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok((found, complete))
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::HashMap;

    use super::*;

    /// Recorded answers by request path; a path without one fails as a 404 would.
    pub(crate) struct Recorded(pub HashMap<String, Value>);

    impl Recorded {
        pub(crate) fn fixture() -> Self {
            let v: Value = serde_json::from_str(include_str!("../fixtures/github.json")).unwrap();
            let answers = v["answers"].as_object().unwrap();
            Self(
                answers
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            )
        }
    }

    impl Source for Recorded {
        async fn get(&self, path: &str) -> Result<Value> {
            self.0
                .get(path)
                .cloned()
                .with_context(|| format!("GET {path}: HTTP 404: Not Found"))
        }
    }

    const NOW: &str = "2026-11-07T12:00:00Z";

    #[tokio::test]
    async fn builds_state_from_queries() {
        let state = refresh(&Recorded::fixture(), &State::empty(), NOW).await;
        let v = serde_json::to_value(&state).unwrap();
        let expected: Value = serde_json::from_str(include_str!("../fixtures/state.json")).unwrap();
        assert_eq!(
            v,
            expected,
            "got {}",
            serde_json::to_string_pretty(&v).unwrap()
        );
    }

    #[tokio::test]
    async fn failed_section_keeps_last_items() {
        let first = refresh(&Recorded::fixture(), &State::empty(), NOW).await;
        let mut src = Recorded::fixture();
        src.0
            .retain(|k, _| !k.starts_with("/search/issues?q=is:open"));
        let later = "2026-11-07T12:01:00Z";
        let second = refresh(&src, &first, later).await;
        assert_eq!(second.refreshed_at.as_deref(), Some(later));
        assert_eq!(second.runs.read_at.as_deref(), Some(later));
        assert_eq!(second.waiting.read_at.as_deref(), Some(NOW));
        assert_eq!(second.waiting.items.len(), first.waiting.items.len());
        let error = second.waiting.error.unwrap();
        assert!(
            error.starts_with(
                "GET /search/issues?q=is:open archived:false user-review-requested:cgwalters"
            ),
            "{error}"
        );
        // Before any read succeeded, a failure leaves the section empty and unread.
        let none = refresh(&src, &State::empty(), later).await;
        assert!(
            none.waiting.items.is_empty()
                && none.waiting.read_at.is_none()
                && none.waiting.error.is_some()
        );
    }

    #[tokio::test]
    async fn unread_merge_state_is_incomplete() {
        let mut src = Recorded::fixture();
        src.0.remove("/repos/bootc-dev/bootc/pulls/1201");
        let state = refresh(&src, &State::empty(), NOW).await;
        assert!(!state.prs.complete);
        let pr = state.prs.items.iter().find(|p| p.number == 1201).unwrap();
        assert_eq!(pr.merge_state, None);
        assert!(state.prs.error.is_none());
    }

    #[tokio::test]
    async fn repo_board_is_case_insensitive() {
        let state = refresh(&Recorded::fixture(), &State::empty(), NOW).await;
        let board = state.repo("BOOTC-DEV/bootc");
        assert_eq!(
            board.prs.iter().map(|p| p.number).collect::<Vec<_>>(),
            [1201]
        );
        assert_eq!(
            board.waiting.iter().map(|w| w.number).collect::<Vec<_>>(),
            [1188]
        );
        assert!(board.runs.is_empty());
        let tracker = state.repo("cgwalters-forge/tracker");
        assert_eq!(tracker.runs.len(), 2);
        assert!(state.repo("nobody/nothing").prs.is_empty());
    }

    #[test]
    fn repository_of_urls() {
        assert_eq!(
            repository_of("https://github.com/o/r/pull/3").unwrap(),
            "o/r"
        );
        assert!(repository_of("https://example.com/o/r/pull/3").is_err());
        assert!(repository_of("https://github.com/o").is_err());
    }
}
