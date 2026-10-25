import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { currentStep, type DispatchData, loadDispatch, parseDispatchTitle, type ResultCache, statusResult } from "../src/github/dispatch.ts";
import { dispatchPanel } from "../src/github/dispatchview.ts";
import type { RunJob } from "../src/github/runs.ts";
import { installDom } from "./helpers.ts";

const NOW = Date.parse("2026-10-25T13:40:00Z");
const RUNS = "/repos/cgwalters-forge/tracker/actions/workflows/dispatch.yml/runs?per_page=100";

const run = (id: number, title: string, status: string, at: string, conclusion: string | null = null) => ({
  id, html_url: `https://github.com/cgwalters-forge/tracker/actions/runs/${id}`, display_title: title, status, conclusion, created_at: at, run_started_at: at, updated_at: at,
});

const LIVE = run(40197564332, "implement cgwalters-forge/review#154 (claude)", "in_progress", "2026-10-25T13:25:50Z");
const QUEUED = run(40197566746, "implement cgwalters-forge/review#155 (openai)", "queued", "2026-10-25T13:39:00Z");
const DONE = run(40196581101, "fix cgwalters-forge/review#159 (openai)", "completed", "2026-10-25T13:22:07Z", "success");
const OLD = run(40100000000, "fix cgwalters-forge/review#100 (claude)", "completed", "2026-10-25T06:00:00Z", "failure");

/** The agent job's steps as GitHub lists them, the setup job before it. */
const JOBS: RunJob[] = [
  { name: "run / policy / notify", status: "completed", started_at: "2026-10-25T13:26:34Z", completed_at: "2026-10-25T13:26:43Z", steps: [{ name: "A comment that says the run started", status: "completed", started_at: "2026-10-25T13:26:38Z" }] },
  { name: "run / agent", status: "in_progress", started_at: "2026-10-25T13:26:48Z", steps: [
    { name: "Set up job", status: "completed", started_at: "2026-10-25T13:26:48Z" },
    { name: "Join the tailnet", status: "completed", started_at: "2026-10-25T13:26:52Z" },
    { name: "Run ./.agentic-job-source/run", status: "in_progress", started_at: "2026-10-25T13:27:38Z" },
    { name: "Post Join the tailnet", status: "pending", started_at: null },
  ] },
];

const statusComment = (id: number, line: string, login = "cgwalters-bot") => ({
  user: { login }, body: `${line}\n\n<!-- agentic-job-run: ${id} -->\n\n<!-- agentic-job-status -->`,
});

function fixtureGitHub() {
  const calls: string[] = [];
  const gh = new GitHub(async () => "fixture", async (url) => {
    const path = url.replace("https://api.github.com", "");
    calls.push(path);
    if (path === `${RUNS}&status=in_progress`) return Response.json({ total_count: 1, workflow_runs: [LIVE] });
    if (path === `${RUNS}&status=queued`) return Response.json({ total_count: 1, workflow_runs: [QUEUED] });
    if (path === RUNS) return Response.json({ total_count: 4, workflow_runs: [QUEUED, LIVE, DONE, OLD] });
    if (path === `/repos/cgwalters-forge/tracker/actions/runs/${LIVE.id}/jobs?per_page=100`) return Response.json({ total_count: JOBS.length, jobs: JOBS });
    if (path === `/repos/cgwalters-forge/tracker/actions/runs/${QUEUED.id}/jobs?per_page=100`) return Response.json({ total_count: 0, jobs: [] });
    if (path.startsWith("/repos/cgwalters-forge/review/issues/159/comments?")) {
      return Response.json([statusComment(DONE.id, `✅ [dispatch](${DONE.html_url}) ended well. Result: https://github.com/cgwalters-forge/review/pull/159`)]);
    }
    throw new Error(`unexpected request: ${path}`);
  });
  return { gh, calls };
}

describe("dispatch run titles", () => {
  const cases: [string, ReturnType<typeof parseDispatchTitle>][] = [
    ["implement cgwalters-forge/review#154 (claude)", { kind: "implement", owner: "cgwalters-forge", repo: "review", number: 154, pool: "claude" }],
    ["triage cgwalters-forge/agent-board#325 (openai)", { kind: "triage", owner: "cgwalters-forge", repo: "agent-board", number: 325, pool: "openai" }],
    ["implement cgwalters-forge/review#154", undefined],
    ["pass: Follow up ended triages", undefined],
    ["implement cgwalters-forge/review#0 (claude)", undefined],
  ];
  for (const [title, want] of cases) it(title, () => assert.deepEqual(parseDispatchTitle(title), want));
});

describe("a run's current step", () => {
  it("is the agent job's step in progress", () => {
    assert.deepEqual(currentStep(JOBS), { job: "run / agent", name: "Run ./.agentic-job-source/run", since: "2026-10-25T13:27:38Z" });
  });

  it("is a setup job's before the agent job starts, and none while all wait", () => {
    const setup: RunJob[] = [{ name: "run / policy / policy", status: "in_progress", started_at: "2026-10-25T13:26:05Z", steps: [{ name: "Get the binary", status: "in_progress", started_at: "2026-10-25T13:26:11Z" }] }, { name: "run / agent", status: "queued" }];
    assert.equal(currentStep(setup)?.name, "Get the binary");
    assert.equal(currentStep([{ name: "run / agent", status: "queued" }]), undefined);
  });
});

describe("a finished run's status comment", () => {
  it("is the bot's about that run, as plain text with its result", () => {
    const comments = [
      statusComment(4019658110, "✅ [dispatch](x) ended well. Result: https://github.com/o/r/pull/1"),
      statusComment(40196581101, "✅ forged", "someone"),
      statusComment(40196581101, "❌ [dispatch](https://github.com/x) handed back no result. Its reason:\n\n> data was missing"),
    ];
    assert.deepEqual(statusResult(comments, 40196581101), { text: "❌ dispatch handed back no result. Its reason: data was missing" });
    assert.equal(statusResult(comments.slice(0, 2), 40196581101), undefined);
  });
});

describe("loading dispatch runs", () => {
  it("shows a card per live run with its step and age, and reads a concluded run's comments once", async () => {
    const { gh, calls } = fixtureGitHub();
    const results: ResultCache = new Map();
    const data = await loadDispatch(gh, results, NOW);
    assert.equal(data.state, "ok");
    // The live lists' runs, and nothing else, are live.
    assert.deepEqual(data.live.map((r) => r.id), [QUEUED.id, LIVE.id]);
    // The run from 7 h ago has left the view.
    assert.deepEqual(data.finished.map((r) => r.id), [DONE.id]);
    assert.equal(data.finished[0]?.result?.url, "https://github.com/cgwalters-forge/review/pull/159");

    const comments = () => calls.filter((p) => p.includes("/comments")).length;
    assert.equal(comments(), 1);
    const again = await loadDispatch(gh, results, NOW + 60_000);
    assert.equal(comments(), 1);
    assert.deepEqual(again.finished[0]?.result, data.finished[0]?.result);

    const win = installDom();
    try {
      const panel = dispatchPanel(data, NOW);
      const live = panel.querySelectorAll(".dispatch-run.live");
      assert.equal(live.length, data.live.length);
      assert.match(panel.querySelector("h2")?.textContent ?? "", /2 live/);
      const card = panel.querySelector(`[data-run-id="${LIVE.id}"]`);
      assert.match(card?.textContent ?? "", /implement.*cgwalters-forge\/review#154.*claude.*14m/);
      assert.equal(card?.querySelector(".dr-step")?.textContent, "Run ./.agentic-job-source/run (since 12m)");
      assert.equal(panel.querySelector(`[data-run-id="${QUEUED.id}"] .dr-step`)?.textContent, "Waiting for a runner.");
      const done = panel.querySelector(`[data-run-id="${DONE.id}"]`);
      assert.equal(done?.querySelector(".dr-result")?.textContent, "PR");
      assert.match(done?.querySelector(".dr-head")?.textContent ?? "", /finished 17m ago/);
      assert.match(done?.querySelector(".dr-step")?.textContent ?? "", /^✅ dispatch ended well\. Result: /);
    } finally {
      win.close();
    }
  });

  it("is unavailable when a list can't be read, and doesn't read jobs", async () => {
    const calls: string[] = [];
    const gh = new GitHub(async () => "fixture", async (url) => {
      calls.push(url);
      return Response.json({ message: "Not Found" }, { status: 404 });
    });
    const data: DispatchData = await loadDispatch(gh, new Map(), NOW);
    assert.equal(data.state, "unavailable");
    assert.match(data.warnings[0] ?? "", /Dispatch runs unavailable/);
    assert.ok(calls.every((u) => u.includes("/workflows/dispatch.yml/runs")));
  });
});
