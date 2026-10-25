// The Dashboard view: its run history (finished days read once), items
// done by priority, merge queues and approved PRs, and the tiles and
// charts built from fixtures.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { parseItem, type RawItem } from "../src/github/board.ts";
import {
  APPROVED_QUERY,
  APPROVED_URL,
  approvedNotQueued,
  countRuns,
  type DashboardData,
  doneByDay,
  type HistoryCache,
  lastDays,
  loadDashboard,
  loadHistoryCache,
  loadMergeQueues,
  loadRunHistory,
  MAX_DAY_PAGES,
  successRate,
} from "../src/github/dashboard.ts";
import { dashboardView } from "../src/github/dashboardview.ts";
import type { DispatchData } from "../src/github/dispatch.ts";
import type { RawRun } from "../src/github/ops.ts";
import { isView, VIEWS } from "../src/github/shell.ts";
import type { UsageData, UsagePool } from "../src/github/usage.ts";
import { installDom } from "./helpers.ts";

installDom();

const NOW = Date.parse("2026-10-25T13:40:00Z");
const DAYS = lastDays(NOW);
const TODAY = DAYS.at(-1)!;
const RUNS = "/repos/cgwalters-forge/tracker/actions/workflows/dispatch.yml/runs";

let nextId = 1;
const run = (day: string, status: string, conclusion: string | null = null): RawRun => {
  const id = nextId++;
  return { id, html_url: `https://github.com/cgwalters-forge/tracker/actions/runs/${id}`, status, conclusion, created_at: `${day}T10:00:00Z` };
};

/** Two finished runs a day, and today one still going; the third day back, a run still going too. */
function dayRuns(day: string): RawRun[] {
  const runs = [run(day, "completed", "success"), run(day, "completed", day === DAYS[3] ? "failure" : "success")];
  if (day === TODAY || day === DAYS[DAYS.length - 3]) runs.push(run(day, "in_progress"));
  return runs;
}

const storage = new Map<string, string>();
const stub = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };

beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, "localStorage", { value: stub, configurable: true, writable: true });
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

/** A client answering the day pages from `pages` (by day, then page) and recording the days read. */
function historyGitHub(pages: (day: string, page: number) => { total_count: number; workflow_runs: RawRun[] } = (day) => {
  const runs = dayRuns(day);
  return { total_count: runs.length, workflow_runs: runs };
}) {
  const reads: string[] = [];
  const gh = new GitHub(async () => "fixture", async (url) => {
    const m = new RegExp(`^https://api\\.github\\.com${RUNS}\\?created=(\\d{4}-\\d{2}-\\d{2})&per_page=100&page=(\\d+)$`).exec(url);
    if (!m) throw new Error(`unexpected request: ${url}`);
    reads.push(`${m[1]}#${m[2]}`);
    return Response.json(pages(m[1]!, Number(m[2])));
  });
  return { gh, reads };
}

describe("run history", () => {
  it("counts runs by how they ended, and the success rate of the finished ones", () => {
    const counts = countRuns([run(TODAY, "completed", "success"), run(TODAY, "completed", "timed_out"), run(TODAY, "completed", "cancelled"), run(TODAY, "completed", "skipped"), run(TODAY, "queued")]);
    assert.deepEqual(counts, { success: 1, failure: 1, cancelled: 1, other: 1, running: 1 });
    assert.equal(successRate(counts), 50);
    assert.equal(successRate({ success: 0, failure: 0, cancelled: 2, other: 0, running: 1 }), undefined);
  });

  it("reads each of the 14 days once, then only today and a past day that still had a run going", async () => {
    const { gh, reads } = historyGitHub();
    const cache: HistoryCache = new Map();
    const first = await loadRunHistory(gh, cache, NOW);
    assert.deepEqual(first.days.map((d) => d.day), DAYS);
    assert.equal(DAYS.length, 14);
    assert.deepEqual(reads, DAYS.map((d) => `${d}#1`));
    assert.deepEqual(first.days[3]!.runs, { success: 1, failure: 1, cancelled: 0, other: 0, running: 0 });
    assert.equal(first.days.at(-1)!.runs!.running, 1);
    assert.deepEqual(first.warnings, []);

    reads.length = 0;
    const second = await loadRunHistory(gh, cache, NOW + 60_000);
    assert.deepEqual(reads, [`${DAYS[DAYS.length - 3]}#1`, `${TODAY}#1`]);
    assert.deepEqual(second.days, first.days);

    // A reload starts from what was kept: still no past day re-read.
    reads.length = 0;
    await loadRunHistory(gh, loadHistoryCache(), NOW + 120_000);
    assert.deepEqual(reads, [`${DAYS[DAYS.length - 3]}#1`, `${TODAY}#1`]);
  });

  it("drops days that left the window, and reads only the new ones", async () => {
    const { gh, reads } = historyGitHub();
    const cache: HistoryCache = new Map();
    await loadRunHistory(gh, cache, NOW);
    reads.length = 0;
    const tomorrow = NOW + 24 * 3600_000;
    await loadRunHistory(gh, cache, tomorrow);
    // Yesterday's today had a run going: read again, now as a past day; so is the day that still had one.
    assert.deepEqual(reads, [`${DAYS[DAYS.length - 3]}#1`, `${TODAY}#1`, `${lastDays(tomorrow).at(-1)}#1`]);
    assert.ok(!cache.has(DAYS[0]!));
  });

  it("pages through a busy day, and doesn't keep one past the page cap", async () => {
    const busy = DAYS[5]!;
    const full = (day: string) => Array.from({ length: 100 }, () => run(day, "completed", "success"));
    const { gh, reads } = historyGitHub((day, page) => (day === busy ? { total_count: 150 + MAX_DAY_PAGES * 100, workflow_runs: full(day) } : day === DAYS[6] ? { total_count: 150, workflow_runs: page === 1 ? full(day) : full(day).slice(0, 50) } : { total_count: 0, workflow_runs: [] }));
    const cache: HistoryCache = new Map();
    const { days, warnings } = await loadRunHistory(gh, cache, NOW);
    assert.equal(reads.filter((r) => r.startsWith(busy)).length, MAX_DAY_PAGES);
    assert.equal(days[5]!.partial, true);
    assert.ok(!cache.has(busy));
    assert.match(warnings.join(" "), new RegExp(busy));
    assert.equal(days[6]!.runs!.success, 150);
    assert.ok(cache.has(DAYS[6]!));
  });

  it("says which day it couldn't read, and keeps the others", async () => {
    const gh = new GitHub(async () => "fixture", async (url) => (url.includes(`created=${DAYS[2]}`) ? new Response("{}", { status: 500 }) : Response.json({ total_count: 0, workflow_runs: [] })));
    const { days, warnings } = await loadRunHistory(gh, new Map(), NOW);
    assert.equal(days[2]!.runs, undefined);
    assert.ok(days[3]!.runs);
    assert.match(warnings[0]!, new RegExp(`Runs of ${DAYS[2]} unavailable`));
  });
});

const boardItem = (n: number, priority: string | undefined, closed: string | null, extra: Record<string, unknown> = {}): RawItem => ({
  id: n,
  node_id: `PVTI_${n}`,
  content_type: "Issue",
  content: { title: `item ${n}`, html_url: `https://github.com/cgwalters-forge/tracker/issues/${n}`, state: closed ? "closed" : "open", closed_at: closed, ...extra },
  fields: priority ? [{ id: 1, name: "Priority", data_type: "single_select", value: { name: { raw: priority } } } as never] : [],
});

describe("items done", () => {
  it("counts the board's items closed or merged each day by priority, not those closed as not planned", () => {
    const board = [
      boardItem(1, "P0", `${TODAY}T08:00:00Z`),
      boardItem(2, "P2", `${TODAY}T09:00:00Z`),
      boardItem(3, undefined, `${DAYS[0]}T01:00:00Z`),
      boardItem(4, "P1", `${TODAY}T09:00:00Z`, { state_reason: "not_planned" }),
      boardItem(5, "P1", null),
      boardItem(6, "P3", "2026-09-01T00:00:00Z"),
      { ...boardItem(7, "P1", null), content_type: "PullRequest", content: { title: "pr", html_url: "https://github.com/cgwalters-forge/review/pull/7", state: "closed", merged_at: `${DAYS[10]}T12:00:00Z`, closed_at: `${DAYS[10]}T12:00:00Z` } },
    ].map(parseItem);
    const done = doneByDay(board, NOW);
    assert.deepEqual(done.map((d) => d.day), DAYS);
    assert.deepEqual(done.at(-1)!.byPriority, { P0: 1, P1: 0, P2: 1, P3: 0, none: 0 });
    assert.equal(done[0]!.byPriority.none, 1);
    assert.equal(done[10]!.byPriority.P1, 1);
    assert.equal(done.reduce((n, d) => n + Object.values(d.byPriority).reduce((a, b) => a + b, 0), 0), 4);
  });
});

/** The merge-queue query's answer: review has two PRs queued, agent-board no queue, the others nothing. */
function queueGitHub() {
  const bodies: { query: string; variables: Record<string, string> }[] = [];
  const searches: string[] = [];
  const gh = new GitHub(async () => "fixture", async (url, init) => {
    if (url === "https://api.github.com/graphql") {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      bodies.push(body);
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body.variables)) {
        if (!k.startsWith("n")) continue;
        const i = k.slice(1);
        const repo = `${body.variables[`o${i}`]}/${v}`;
        data[`r${i}`] = repo === "cgwalters-forge/review"
          ? { nameWithOwner: repo, mergeQueue: { url: "https://github.com/cgwalters-forge/review/queue/main", entries: { totalCount: 2, nodes: [{ pullRequest: { url: "https://github.com/cgwalters-forge/review/pull/1" } }, { pullRequest: { url: "https://github.com/cgwalters-forge/review/pull/2" } }] } } }
          : repo === "cgwalters-forge/agent-board" ? null : { nameWithOwner: repo, mergeQueue: null };
      }
      return Response.json({ data, errors: [{ message: "Could not resolve to a Repository with the name 'cgwalters-forge/agent-board'." }] });
    }
    searches.push(url);
    if (url.startsWith("https://api.github.com/search/issues?")) return Response.json({ total_count: 3, items: [1, 2, 3].map((n) => ({ html_url: `https://github.com/cgwalters-forge/review/pull/${n}` })) });
    if (url.includes("/actions/workflows/")) return Response.json({ total_count: 0, workflow_runs: [] });
    throw new Error(`unexpected request: ${url}`);
  });
  return { gh, bodies, searches };
}

describe("merge queues and approved PRs", () => {
  it("asks for every followed repository's queue in one query, its names as variables", async () => {
    const { gh, bodies } = queueGitHub();
    const { data, warnings } = await loadMergeQueues(gh, ["cgwalters-forge/review", "cgwalters-forge/agent-board", "cgwalters-forge/agentic-job"]);
    assert.equal(bodies.length, 1);
    assert.doesNotMatch(bodies[0]!.query, /cgwalters-forge/);
    assert.deepEqual(data.queues, [{ repo: "cgwalters-forge/review", url: "https://github.com/cgwalters-forge/review/queue/main", count: 2 }]);
    assert.match(warnings[0]!, /agent-board/);
  });

  it("finds the approved PRs not queued, and reads the three parts together", async () => {
    const { gh, searches } = queueGitHub();
    const { data, ok } = await loadDashboard(gh, new Map(), undefined, NOW);
    assert.ok(ok);
    assert.equal(decodeURIComponent(new URL(searches.find((s) => s.includes("/search/"))!).searchParams.get("q")!), APPROVED_QUERY);
    assert.deepEqual(approvedNotQueued(data.approved!, data.queues), ["https://github.com/cgwalters-forge/review/pull/3"]);
    assert.equal(data.history!.length, 14);
  });

  it("keeps a part last read when its read fails", async () => {
    const gh = new GitHub(async () => "fixture", async (url) => (url.includes("/search/") ? new Response("{}", { status: 500 }) : url.includes("graphql") ? Response.json({ data: {} }) : Response.json({ total_count: 0, workflow_runs: [] })));
    const last: DashboardData = { approved: { urls: ["https://github.com/cgwalters-forge/review/pull/9"], total: 1 }, warnings: [] };
    const { data, ok } = await loadDashboard(gh, new Map(), last, NOW);
    assert.equal(ok, false);
    assert.deepEqual(data.approved, last.approved);
    assert.match(data.warnings.join(" "), /Approved PRs unavailable/);
  });
});

const pool = (hold: boolean): UsagePool => ({ usedPercent: 60, allowedPercent: 50, resetsAt: "2026-10-27T00:00:00Z", observedAt: "2026-10-25T13:30:00Z", hold, windowMinutes: 7 * 24 * 60 });

describe("dashboard view", () => {
  it("is not a view while switched off", () => {
    assert.ok(VIEWS.includes("dashboard"));
    assert.equal(isView("dashboard"), false);
  });

  it("links each tile to its view, and builds the charts from the fixtures", async () => {
    const { gh } = historyGitHub();
    const history = (await loadRunHistory(gh, new Map(), NOW)).days;
    const dispatch = { state: "ok", at: NOW, live: [{ status: "in_progress" }, { status: "in_progress" }, { status: "queued" }], finished: [], warnings: [] } as unknown as DispatchData;
    const usage: UsageData = { state: "ok", usage: { updatedAt: "2026-10-25T13:30:00Z", windows: [], workers: [], pools: { claude: pool(false), openai: pool(true) } } };
    const done = doneByDay([parseItem(boardItem(1, "P0", `${TODAY}T08:00:00Z`))], NOW);
    const el = dashboardView({
      data: { history, queues: { queues: [{ repo: "cgwalters-forge/review", url: "u", count: 2 }], queued: new Set(["a"]) }, approved: { urls: ["a", "b"], total: 2 }, warnings: [] },
      dispatch, approvals: 4, usage, done, now: NOW,
    });
    const tiles = [...el.querySelectorAll<HTMLAnchorElement>("a.dash-tile")].map((a) => [a.getAttribute("href"), a.querySelector(".big")!.textContent, a.querySelector(".sub")!.textContent]);
    assert.deepEqual(tiles, [
      ["#agents", "2/60", "1 queued"],
      ["#inbox", "4", "PRs waiting on your review"],
      [APPROVED_URL, "2", "1 approved, not queued"],
      ["#usage", "1", "OpenAI"],
    ]);
    assert.equal(el.querySelectorAll(".dash-pools .pool").length, 2);
    const charts = [...el.querySelectorAll(".dash-chart")];
    assert.equal(charts.length, 3);
    // Runs: a bar segment per result a day had (two kinds on day 3 and on the days with a run going, else one).
    assert.equal(charts[0]!.querySelectorAll("svg rect").length, 14 + 3);
    assert.match(charts[0]!.querySelector("svg rect title")!.textContent!, new RegExp(`^${DAYS[0]}: 2 succeeded, 0 failed`));
    assert.equal(charts[0]!.querySelectorAll("tbody tr").length, 14);
    assert.match(charts[1]!.querySelector("h3")!.textContent!, /^Success rate: 96% over 14 days$/);
    assert.equal(charts[2]!.querySelectorAll("svg rect:not(.missing)").length, 1);
    assert.match(charts[2]!.querySelector("svg rect.s-p0 title")!.textContent!, new RegExp(`^${TODAY}: 1 P0`));
  });

  it("says what it is still reading", () => {
    const el = dashboardView({ data: undefined, dispatch: undefined, approvals: undefined, usage: undefined, done: undefined, now: NOW });
    assert.deepEqual([...el.querySelectorAll(".dash-tile .big")].map((b) => b.textContent), ["…/60", "…", "…", "…"]);
    assert.match(el.textContent!, /Reading the run history…/);
  });
});
