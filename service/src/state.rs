//! The control app's state, built from GitHub queries on each refresh:
//! live Actions runs, the bot's open PRs with their merge state, and the
//! issues and PRs waiting on the operator. A section whose reads fail
//! keeps its last good items and says why it is stale.

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use futures_util::future::join_all;
use serde::Serialize;
use serde_json::Value;

use crate::github::Source;
use crate::version::Version;

pub const SCHEMA: &str = "review-service/v1";

/// Equivalent names for the same full-state payload, not separate versions.
pub const SCHEMA_ALIASES: &[&str] = &["control-app/v1"];

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
/// `user-review-requested:` names the operator alone, not their teams.
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
    /// Why the last read failed. Wholly, when `read_at` is older than the
    /// state's `refreshedAt` and `items` are from then; or in part, when
    /// `complete` is false and the failed part's items are missing.
    pub error: Option<String>,
}

/// What a section's read found: its items, whether its lists were whole,
/// and the parts that failed, whose items are missing.
struct Read<T> {
    items: Vec<T>,
    complete: bool,
    failures: Vec<String>,
}

/// One message for a section's failures: the first, and how many more.
fn summarize(failures: &[String]) -> Option<String> {
    let (first, rest) = failures.split_first()?;
    Some(match rest.len() {
        0 => first.clone(),
        n => format!("{first} (and {n} more)"),
    })
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
    /// Why it waits on the operator: review-requested, assigned, or both.
    pub reasons: Vec<&'static str>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub schema: &'static str,
    pub schema_aliases: &'static [&'static str],
    pub version: Version,
    /// Counts refreshes, as the SSE event id.
    pub generation: u64,
    /// When the last refresh finished; null before the first.
    pub refreshed_at: Option<String>,
    pub runs: Section<Run>,
    pub prs: Section<Pr>,
    pub waiting: Section<Waiting>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<Section<Value>>,
}

/// One repository's part of the state, case-insensitively by name.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoBoard<'a> {
    pub repository: String,
    pub refreshed_at: Option<&'a str>,
    pub runs: RepoSection<'a, Run>,
    pub prs: RepoSection<'a, Pr>,
    pub waiting: RepoSection<'a, Waiting>,
}

/// A section's items in one repository, with the whole section's health.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSection<'a, T> {
    pub items: Vec<&'a T>,
    /// The whole section's: false when its lists were cut short or partly
    /// unread, so this repository's items may be missing even if none show.
    pub complete: bool,
    pub read_at: Option<&'a str>,
    pub error: Option<&'a str>,
}

impl<T> Section<T> {
    fn only<'a>(&'a self, keep: impl Fn(&T) -> bool) -> RepoSection<'a, T> {
        RepoSection {
            items: self.items.iter().filter(|i| keep(i)).collect(),
            complete: self.complete,
            read_at: self.read_at.as_deref(),
            error: self.error.as_deref(),
        }
    }
}

impl State {
    pub fn empty() -> Self {
        Self {
            schema: SCHEMA,
            schema_aliases: SCHEMA_ALIASES,
            ..Self::default()
        }
    }

    pub fn repo(&self, name: &str) -> RepoBoard<'_> {
        let on = |r: &str| r.eq_ignore_ascii_case(name);
        RepoBoard {
            repository: name.to_owned(),
            refreshed_at: self.refreshed_at.as_deref(),
            runs: self.runs.only(|r| on(&r.repository)),
            prs: self.prs.only(|p| on(&p.repository)),
            waiting: self.waiting.only(|w| on(&w.repository)),
        }
    }
}

/// Read every section afresh; one that fails wholly keeps `prev`'s items.
pub async fn refresh<S: Source>(src: &S, prev: &State, now: &str) -> State {
    fn section<T: Clone>(read: Result<Read<T>>, prev: &Section<T>, now: &str) -> Section<T> {
        match read {
            Ok(read) => Section {
                complete: read.complete && read.failures.is_empty(),
                error: summarize(&read.failures),
                items: read.items,
                read_at: Some(now.to_owned()),
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
        schema_aliases: SCHEMA_ALIASES,
        version: Version::default(),
        generation: prev.generation + 1,
        refreshed_at: Some(now.to_owned()),
        runs: section(runs, &prev.runs, now),
        prs: section(prs, &prev.prs, now),
        waiting: section(waiting, &prev.waiting, now),
        decision: prev.decision.clone(),
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

/// Unfinished runs from RUN_SOURCES, newest first. A source that can't be
/// read is a failure naming it, and doesn't hide the others' runs; the
/// section fails wholly, keeping its last items, only when every source does.
async fn load_runs<S: Source>(src: &S) -> Result<Read<Run>> {
    let mut lists = Vec::new();
    for (repo, workflow) in RUN_SOURCES {
        let base = match workflow {
            Some(w) => format!("/repos/{repo}/actions/workflows/{w}/runs"),
            None => format!("/repos/{repo}/actions/runs"),
        };
        lists.extend(
            LIVE_STATUSES
                .iter()
                .map(|s| (*repo, format!("{base}?status={s}&per_page={PAGE_SIZE}"))),
        );
    }
    let paths: Vec<String> = lists.iter().map(|(_, p)| p.clone()).collect();
    let answers = get_all(src, &paths).await;
    let mut complete = true;
    // One failure per source: its status lists usually fail alike.
    let mut failed: BTreeMap<&str, String> = BTreeMap::new();
    // A run can move between status lists while they are read; one entry per run.
    let mut runs = BTreeMap::new();
    for ((repo, path), answer) in lists.iter().zip(answers) {
        let parsed = answer.and_then(|a| {
            let items = list(&a, "workflow_runs")?;
            let runs = items.iter().map(parse_run).collect::<Result<Vec<_>>>();
            Ok((
                runs.with_context(|| format!("GET {path}"))?,
                whole(&a, items),
            ))
        });
        match parsed {
            Ok((read, whole)) => {
                complete &= whole;
                for run in read {
                    runs.insert((run.repository.to_lowercase(), run.id), run);
                }
            }
            Err(e) => {
                failed
                    .entry(repo)
                    .or_insert_with(|| format!("{repo}: {e:#}"));
            }
        }
    }
    let failures: Vec<String> = failed.into_values().collect();
    if failures.len() == RUN_SOURCES.len() {
        anyhow::bail!(summarize(&failures).unwrap_or_default());
    }
    let mut runs: Vec<Run> = runs.into_values().collect();
    runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(Read {
        items: runs,
        complete,
        failures,
    })
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
/// fails has none, and is a failure naming it.
async fn load_prs<S: Source>(src: &S) -> Result<Read<Pr>> {
    let answer = src.get(&search_path(BOT_PRS_QUERY)).await?;
    let (hits, complete) = search_hits(&answer)?;
    let paths: Vec<String> = hits
        .iter()
        .map(|h| format!("/repos/{}/pulls/{}", h.repository, h.number))
        .collect();
    let pulls = get_all(src, &paths).await;
    let mut failures = Vec::new();
    let prs = hits
        .into_iter()
        .zip(pulls)
        .map(|(h, pull)| {
            let merge_state = pull.and_then(|p| Ok(str_of(&p, "mergeable_state")?.to_owned()));
            let merge_state = merge_state
                .inspect_err(|e| {
                    failures.push(format!("{}#{}: merge state: {e:#}", h.repository, h.number))
                })
                .ok();
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
    Ok(Read {
        items: prs,
        complete,
        failures,
    })
}

/// Open issues and PRs assigned to the operator or requesting their review, most
/// recently updated first; one entry for an item with both reasons.
async fn load_waiting<S: Source>(src: &S) -> Result<Read<Waiting>> {
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
    Ok(Read {
        items: found,
        complete,
        failures: Vec::new(),
    })
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
        let mut expected: Value =
            serde_json::from_str(include_str!("../fixtures/state.json")).unwrap();
        expected["version"] = serde_json::to_value(Version::default()).unwrap();
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
        assert_eq!(state.prs.items.len(), 2, "the other PRs stay");
        assert_eq!(state.prs.read_at.as_deref(), Some(NOW));
        assert_eq!(
            state.prs.error.as_deref(),
            Some(
                "bootc-dev/bootc#1201: merge state: GET /repos/bootc-dev/bootc/pulls/1201: HTTP 404: Not Found"
            )
        );
        src.0.remove("/repos/cgwalters-forge/bootc/pulls/16");
        let state = refresh(&src, &State::empty(), NOW).await;
        assert!(
            state.prs.error.unwrap().ends_with("Not Found (and 1 more)"),
            "every failure is counted"
        );
    }

    #[tokio::test]
    async fn unreadable_run_source_keeps_the_others() {
        const DEVSPACE: &str = "/repos/bootc-dev/cgwalters-devspace-sandbox/";
        let mut src = Recorded::fixture();
        src.0.retain(|k, _| !k.starts_with(DEVSPACE));
        let state = refresh(&src, &State::empty(), NOW).await;
        assert_eq!(
            state.runs.items.iter().map(|r| r.id).collect::<Vec<_>>(),
            [9003, 9002]
        );
        assert!(!state.runs.complete);
        assert_eq!(state.runs.read_at.as_deref(), Some(NOW));
        let error = state.runs.error.unwrap();
        assert!(
            error.starts_with(&format!(
                "bootc-dev/cgwalters-devspace-sandbox: GET {DEVSPACE}actions/workflows/agent.yml/runs?status=requested"
            )) && error.ends_with("HTTP 404: Not Found"),
            "one failure for the source, naming it: {error}"
        );

        // With every source unreadable, the section keeps its last runs.
        let first = refresh(&Recorded::fixture(), &State::empty(), NOW).await;
        src.0.retain(|k, _| !k.contains("/actions/"));
        let later = "2026-11-07T12:01:00Z";
        let state = refresh(&src, &first, later).await;
        assert_eq!(state.runs.items.len(), 3);
        assert_eq!(state.runs.read_at.as_deref(), Some(NOW));
        assert!(state.runs.error.unwrap().ends_with("(and 1 more)"));
    }

    #[tokio::test]
    async fn repo_board_is_case_insensitive() {
        let state = refresh(&Recorded::fixture(), &State::empty(), NOW).await;
        let board = state.repo("BOOTC-DEV/bootc");
        assert_eq!(
            board.prs.items.iter().map(|p| p.number).collect::<Vec<_>>(),
            [1201]
        );
        assert_eq!(
            board
                .waiting
                .items
                .iter()
                .map(|w| w.number)
                .collect::<Vec<_>>(),
            [1188]
        );
        assert!(board.runs.items.is_empty());
        let tracker = state.repo("cgwalters-forge/tracker");
        assert_eq!(tracker.runs.items.len(), 2);
        assert!(state.repo("nobody/nothing").prs.items.is_empty());
    }

    #[tokio::test]
    async fn repo_board_carries_section_health() {
        let fresh = refresh(&Recorded::fixture(), &State::empty(), NOW).await;
        let board = serde_json::to_value(fresh.repo("nobody/nothing")).unwrap();
        assert_eq!(board["refreshedAt"], NOW);
        // The fixture's assignee search found more than it listed.
        for (section, complete) in [("runs", true), ("prs", true), ("waiting", false)] {
            assert_eq!(
                board[section],
                serde_json::json!({"items": [], "complete": complete, "readAt": NOW, "error": null}),
                "{section}"
            );
        }

        // A search cut short: an empty board isn't proof of an empty repository.
        let mut src = Recorded::fixture();
        let search = search_path(BOT_PRS_QUERY);
        src.0.get_mut(&search).unwrap()["total_count"] = 250.into();
        // And a failed one: the waiting items are stale.
        src.0
            .retain(|k, _| !k.starts_with("/search/issues?q=is:open"));
        let later = "2026-11-07T12:01:00Z";
        let state = refresh(&src, &fresh, later).await;
        let board = serde_json::to_value(state.repo("nobody/nothing")).unwrap();
        assert_eq!(board["prs"]["items"], serde_json::json!([]));
        assert_eq!(board["prs"]["complete"], false);
        assert_eq!(board["prs"]["readAt"], later);
        let board = serde_json::to_value(state.repo("bootc-dev/bootc")).unwrap();
        assert_eq!(board["waiting"]["items"][0]["number"], 1188);
        assert_eq!(board["waiting"]["readAt"], NOW);
        assert!(
            board["waiting"]["error"]
                .as_str()
                .unwrap()
                .contains("HTTP 404")
        );

        // Before the first refresh, nothing has been read.
        let board = serde_json::to_value(State::empty().repo("o/r")).unwrap();
        assert_eq!(board["refreshedAt"], Value::Null);
        assert_eq!(board["prs"]["readAt"], Value::Null);
        assert_eq!(board["prs"]["complete"], false);
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
