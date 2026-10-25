// The Dashboard view's own reads (§1 of the #135 design): the tracker's
// dispatch runs of the last HISTORY_DAYS days, a day at a time, for the
// runs chart; the merge queues of the harness repositories, in one GraphQL
// query; and the approved open PRs of the forge, of which those not in a
// queue are waiting to be queued. The tiles and pool bars come from what
// the other views read already (dispatch.ts, the usage snapshot, the
// inbox's needs), and the items-done chart from the board's closed items.
//
// A day's runs stop changing once the day is over and every run of it has
// finished, so such a day is kept (in localStorage) and never read again;
// only today, and a past day that still had a run going, are re-read.

import type { GitHub } from "./api.ts";
import { DISPATCH_WORKFLOW, FORGE_ORG, NEWS_REPOS, TRACKER_REPO } from "./config.ts";
import type { Item } from "./board.ts";
import { PRIORITY_ORDER } from "./board.ts";
import config from "./dashboard-config.json" with { type: "json" };
import type { RawRun } from "./ops.ts";
import { load, save } from "./store.ts";

/**
 * Off by default: when on, the view adds the reads above (up to 14 run
 * pages on a first load, a GraphQL query and a search a minute), so it
 * is turned on by a reviewed change once tried against GitHub. `runCap`
 * is the number of jobs the plan runs at once, which the in-flight tile
 * counts against (GitHub's concurrency limit; nothing publishes it).
 */
export const DASHBOARD_CONFIG = config as { enabled: boolean; runCap: number };

export const HISTORY_DAYS = 14;
/** Pages of runs read for one day at most (GitHub lists no more than 1000 runs per filtered query). */
export const MAX_DAY_PAGES = 10;
const PAGE_SIZE = 100;
const DAY_MS = 24 * 3600_000;
const HISTORY_KEY = "dashboard.history";
/** The repositories whose merge queues the in-queue tile counts: the harness ones the news pane follows. */
export const QUEUE_REPOS: readonly string[] = NEWS_REPOS;
/** The open PRs approved and so ready to queue. */
export const APPROVED_QUERY = `is:pr is:open review:approved org:${FORGE_ORG}`;
export const APPROVED_URL = `https://github.com/pulls?q=${encodeURIComponent(APPROVED_QUERY)}`;

/** One day's dispatch runs by how they ended; `running` for those not finished when read. */
export interface DayRuns {
  success: number;
  failure: number;
  cancelled: number;
  other: number;
  running: number;
}

export const RUN_RESULTS = ["success", "failure", "cancelled", "other", "running"] as const satisfies readonly (keyof DayRuns)[];

export interface HistoryDay {
  /** The UTC day, YYYY-MM-DD. */
  day: string;
  /** Undefined when it couldn't be read. */
  runs?: DayRuns;
  /** More runs than MAX_DAY_PAGES pages hold: these are the first. */
  partial?: boolean;
}

/** Finished days' runs, by day, as kept between reads and reloads. */
export type HistoryCache = Map<string, DayRuns>;

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The last `n` UTC days, oldest first, today last. */
export function lastDays(now: number, n = HISTORY_DAYS): string[] {
  return Array.from({ length: n }, (_, i) => utcDay(now - (n - 1 - i) * DAY_MS));
}

export function countRuns(runs: readonly RawRun[]): DayRuns {
  const out: DayRuns = { success: 0, failure: 0, cancelled: 0, other: 0, running: 0 };
  for (const r of runs) {
    if (r.status !== "completed") out.running++;
    else if (r.conclusion === "success") out.success++;
    else if (r.conclusion === "cancelled") out.cancelled++;
    else if (FAILED.has(r.conclusion ?? "")) out.failure++;
    else out.other++;
  }
  return out;
}

/** Percent of finished runs that succeeded, cancelled and other endings left out; undefined with none. */
export function successRate(d: DayRuns): number | undefined {
  const n = d.success + d.failure;
  return n ? (100 * d.success) / n : undefined;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isDayRuns = (v: unknown): v is DayRuns => typeof v === "object" && v !== null && RUN_RESULTS.every((k) => isCount((v as Record<string, unknown>)[k]));
const isStored = (v: unknown): v is Record<string, DayRuns> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.entries(v).every(([k, d]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && isDayRuns(d));

/** The finished days kept from earlier loads. */
export function loadHistoryCache(): HistoryCache {
  return new Map(Object.entries(load(HISTORY_KEY, {}, isStored)));
}

async function readDay(gh: GitHub, day: string): Promise<{ runs: RawRun[]; partial: boolean }> {
  const base = `/repos/${TRACKER_REPO}/actions/workflows/${DISPATCH_WORKFLOW}/runs?created=${day}&per_page=${PAGE_SIZE}`;
  const runs: RawRun[] = [];
  for (let page = 1; page <= MAX_DAY_PAGES; page++) {
    const { workflow_runs: got, total_count: total } = (await gh.get<{ workflow_runs: RawRun[]; total_count: number }>(`${base}&page=${page}`)).data;
    runs.push(...got);
    if (got.length < PAGE_SIZE || runs.length >= total) return { runs, partial: false };
  }
  return { runs, partial: true };
}

/**
 * The runs of the last HISTORY_DAYS days. A day in `cache` is not read;
 * a past day read complete with every run finished goes into it, and
 * days that left the window go out of it. The cache is saved.
 */
export async function loadRunHistory(gh: GitHub, cache: HistoryCache, now = Date.now()): Promise<{ days: HistoryDay[]; warnings: string[] }> {
  const days = lastDays(now);
  const today = days.at(-1)!;
  const warnings: string[] = [];
  const out: HistoryDay[] = [];
  // One day after another: the client caps concurrency anyway, and a first load is 14 small pages.
  for (const day of days) {
    const kept = cache.get(day);
    if (kept && day !== today) {
      out.push({ day, runs: kept });
      continue;
    }
    try {
      const { runs, partial } = await readDay(gh, day);
      const counts = countRuns(runs);
      if (day !== today && !partial && counts.running === 0) cache.set(day, counts);
      out.push(partial ? { day, runs: counts, partial } : { day, runs: counts });
      if (partial) warnings.push(`More than ${MAX_DAY_PAGES * PAGE_SIZE} runs on ${day}; only the first are counted.`);
    } catch (e) {
      out.push({ day });
      warnings.push(`Runs of ${day} unavailable: ${message(e)}`);
    }
  }
  for (const day of cache.keys()) if (!days.includes(day)) cache.delete(day);
  save(HISTORY_KEY, Object.fromEntries(cache));
  return { days: out, warnings };
}

/** Items done per UTC day of the window, by priority (PRIORITY_ORDER, then "none"). */
export interface DoneDay {
  day: string;
  byPriority: Record<string, number>;
}

export const DONE_PRIORITIES: readonly string[] = [...PRIORITY_ORDER, "none"];
/** Closed this way, an issue wasn't done. */
const NOT_DONE = new Set(["not_planned", "duplicate"]);

/** The board's items closed or merged on each of the last HISTORY_DAYS days, by priority. */
export function doneByDay(board: readonly Item[], now: number): DoneDay[] {
  const days = lastDays(now);
  const out = days.map((day) => ({ day, byPriority: Object.fromEntries(DONE_PRIORITIES.map((p) => [p, 0])) }));
  const index = new Map(days.map((d, i) => [d, i]));
  for (const item of board) {
    if (!item.closedAt || (item.state !== "closed" && item.state !== "merged") || NOT_DONE.has(item.closedAs ?? "")) continue;
    const i = index.get(utcDay(Date.parse(item.closedAt)));
    if (i === undefined) continue;
    const p = item.priority && PRIORITY_ORDER.includes(item.priority) ? item.priority : "none";
    out[i]!.byPriority[p]!++;
  }
  return out;
}

/** One repository's merge queue. */
export interface MergeQueue {
  repo: string;
  url: string;
  count: number;
}

export interface Queues {
  queues: MergeQueue[];
  /** The URLs of the PRs in them (the first 100 of each). */
  queued: Set<string>;
}

interface RawQueueRepo {
  nameWithOwner: string;
  mergeQueue: { url: string; entries: { totalCount: number; nodes: ({ pullRequest: { url: string } | null } | null)[] } } | null;
}

/** The merge queues of `repos`' default branches, as one GraphQL query; a repository without one has none. */
export async function loadMergeQueues(gh: GitHub, repos: readonly string[] = QUEUE_REPOS): Promise<{ data: Queues; warnings: string[] }> {
  const vars: Record<string, string> = {};
  const params: string[] = [];
  const fields = repos.map((repo, i) => {
    const [owner, name] = repo.split("/") as [string, string];
    vars[`o${i}`] = owner;
    vars[`n${i}`] = name;
    params.push(`$o${i}: String!, $n${i}: String!`);
    return `r${i}: repository(owner: $o${i}, name: $n${i}) { nameWithOwner mergeQueue { url entries(first: 100) { totalCount nodes { pullRequest { url } } } } }`;
  });
  const query = `query(${params.join(", ")}) { ${fields.join(" ")} }`;
  const r = await gh.send<{ data?: Record<string, RawQueueRepo | null> | null; errors?: { message?: string }[] }>("POST", "/graphql", { query, variables: vars });
  // A repository this token can't see is an error beside the others' data, not a failure of them all.
  if (!r?.data) throw new Error(`merge queues: ${r?.errors?.map((e) => e.message).join("; ") || "no data"}`);
  const warnings = (r.errors ?? []).map((e) => `Merge queues: ${e.message ?? "error"}`);
  const queues: MergeQueue[] = [];
  const queued = new Set<string>();
  repos.forEach((_, i) => {
    const repo = r.data![`r${i}`];
    if (!repo?.mergeQueue) return;
    queues.push({ repo: repo.nameWithOwner, url: repo.mergeQueue.url, count: repo.mergeQueue.entries.totalCount });
    for (const n of repo.mergeQueue.entries.nodes) if (n?.pullRequest) queued.add(n.pullRequest.url);
  });
  return { data: { queues, queued }, warnings };
}

export interface Approved {
  /** The approved open PRs, as GitHub URLs. */
  urls: string[];
  total: number;
}

export async function loadApproved(gh: GitHub): Promise<Approved> {
  const { data } = await gh.get<{ total_count: number; items: { html_url: string }[] }>(`/search/issues?q=${encodeURIComponent(APPROVED_QUERY)}&per_page=${PAGE_SIZE}`);
  return { urls: data.items.map((i) => i.html_url), total: data.total_count };
}

/** What the Dashboard view reads itself; each part undefined until read. */
export interface DashboardData {
  history?: HistoryDay[];
  queues?: Queues;
  approved?: Approved;
  warnings: string[];
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Read the run history, the merge queues and the approved PRs. A part
 * that fails keeps what `last` had, with a warning; `ok` is false then.
 */
export async function loadDashboard(gh: GitHub, cache: HistoryCache, last: DashboardData | undefined, now = Date.now()): Promise<{ data: DashboardData; ok: boolean }> {
  const [history, queues, approved] = await Promise.allSettled([loadRunHistory(gh, cache, now), loadMergeQueues(gh), loadApproved(gh)]);
  const data: DashboardData = { warnings: [] };
  let ok = true;
  const keep = <K extends "history" | "queues" | "approved">(key: K, what: string, r: PromiseSettledResult<DashboardData[K]>) => {
    if (r.status === "fulfilled") {
      if (r.value !== undefined) data[key] = r.value;
      return;
    }
    ok = false;
    data.warnings.push(`${what} unavailable: ${message(r.reason)}`);
    if (last?.[key] !== undefined) data[key] = last[key];
  };
  keep("history", "Run history", history.status === "fulfilled" ? { status: "fulfilled", value: history.value.days } : history);
  if (history.status === "fulfilled") {
    data.warnings.push(...history.value.warnings);
    if (history.value.days.some((d) => !d.runs)) ok = false;
  }
  keep("queues", "Merge queues", queues.status === "fulfilled" ? { status: "fulfilled", value: queues.value.data } : queues);
  if (queues.status === "fulfilled") data.warnings.push(...queues.value.warnings);
  keep("approved", "Approved PRs", approved);
  if (data.approved && data.approved.total > data.approved.urls.length) data.warnings.push(`More than ${PAGE_SIZE} approved PRs; only the first are compared with the queues.`);
  return { data, ok };
}

/** The approved PRs not in a merge queue. */
export function approvedNotQueued(approved: Approved, queues: Queues | undefined): string[] {
  return approved.urls.filter((u) => !queues?.queued.has(u));
}
