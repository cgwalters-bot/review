import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { GitHub } from "../src/github/api.ts";
import { ResponseCache } from "../src/github/cache.ts";
import { IdbStore } from "../src/github/idbstore.ts";
import type { Item } from "../src/github/board.ts";
import {
  agentRuns,
  botEvents,
  coreHourBuckets,
  coresOf,
  type Devspace,
  devspaceOf,
  history,
  type JobCache,
  jobsFinal,
  loadOps,
  loadActive,
  outcomeOf,
  parseDevspaceTitle,
  parseEvent,
  parseJobs,
  type RawEvent,
  type RawJob,
  type RawRun,
  timeLeft,
  workGroups,
} from "../src/github/ops.ts";
import { fields, fixture, installDom, scriptedFetch } from "./helpers.ts";

installDom();

const API = "https://api.github.com";
const REPO = `${API}/repos/bootc-dev/cgwalters-devspace-sandbox`;
const NOW = Date.parse("2026-09-28T15:12:05Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

// Trimmed from the real API on 2026-09-28: one live devspace, two
// stopped, one that ran out its duration.
const runs = () => fixture<{ workflow_runs: RawRun[] }>("ops-runs.json").workflow_runs;
const jobs = () => fixture<Record<string, RawJob[]>>("ops-jobs.json");
const events = () => fixture<RawEvent[]>("ops-events.json");
// What bin/bot-heartbeat publish wrote for a sample heartbeat, at 15:05Z.
const heartbeat = () => fixture<unknown[]>("heartbeat-comments.json");
const HEARTBEAT_PATH = "/repos/cgwalters-forge/tracker/issues/176/comments";
// What bin/bot-heartbeat publish wrote to the private repository for the same sample, after someone else's copy.
const usageComments = () => fixture<unknown[]>("usage-comments.json");
const USAGE_PATH = "/repos/cgwalters-forge/bot-ops/issues/1/comments";

function row(id: number): Devspace {
  const run = runs().find((r) => r.id === id);
  assert.ok(run);
  const d = devspaceOf(run, parseJobs(jobs()[String(id)] ?? []));
  assert.ok(d);
  return d;
}

describe("parseDevspaceTitle", () => {
  const cases: [string | undefined, ReturnType<typeof parseDevspaceTitle>][] = [
    ["Devspace review-ops", { name: "review-ops" }],
    ["Devspace bootc-2482 (16c, 120m)", { name: "bootc-2482", cores: 16, durationMin: 120 }],
    [" Devspace a.b_c ", { name: "a.b_c" }],
    ["Devspace ", undefined],
    ["Devspace two words", undefined],
    ["Agent bootc#1", undefined],
    [undefined, undefined],
  ];
  for (const [title, want] of cases) it(JSON.stringify(title), () => assert.deepEqual(parseDevspaceTitle(title), want));
});

describe("coresOf", () => {
  const cases: [string[] | undefined, number | undefined][] = [
    [["rhel10-x86_64-4c-16g"], 4],
    [["rhel10-x86_64-16c-64g"], 16],
    [["self-hosted", "rhel10-x86_64-64c-256g"], 64],
    [["ubuntu-latest"], undefined],
    [["x86_64-abc-16g"], undefined],
    [undefined, undefined],
  ];
  for (const [labels, want] of cases) it(JSON.stringify(labels), () => assert.equal(coresOf(labels), want));
});

describe("outcomeOf", () => {
  const cases: [string | null, string][] = [
    ["cancelled", "stopped"],
    ["success", "expired"],
    ["failure", "failed"],
    ["timed_out", "failed"],
    ["startup_failure", "failed"],
    ["skipped", "other"],
    [null, "other"],
  ];
  for (const [c, want] of cases) it(String(c), () => assert.equal(outcomeOf(c), want));
});

describe("devspaceOf", () => {
  it("makes a live run a row with its host, size and phase", () => {
    assert.deepEqual(row(36439387350), {
      id: 36439387350,
      name: "selinux-3327",
      host: "cgwalters-devspace-36439387350",
      url: "https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/36439387350",
      phase: "ready",
      cores: 16,
      createdAt: "2026-09-28T14:53:31Z",
      startedAt: "2026-09-28T14:55:34Z",
      readyAt: "2026-09-28T14:56:26Z",
    });
  });
  it("counts a cancelled run as stopped, not failed", () => {
    const d = row(36439856834);
    assert.equal(d.phase, "done");
    assert.equal(d.outcome, "stopped");
    assert.equal(d.endedAt, "2026-09-28T15:04:10Z");
  });
  it("counts a successful run as expired", () => assert.equal(row(36422184366).outcome, "expired"));

  const base: RawRun = { id: 7, html_url: "https://github.com/x/actions/runs/7", display_title: "Devspace n (4c, 30m)", created_at: "2026-09-28T15:00:00Z" };
  const step = (status: string) => [{ name: "Prepare OpenSSH and keep the devspace available", status, started_at: status === "pending" ? null : "2026-09-28T15:02:00Z" }];
  const phases: [string, string, RawJob[] | undefined, string][] = [
    ["queued run", "queued", undefined, "queued"],
    ["in progress, no job yet", "in_progress", undefined, "queued"],
    ["setting up", "in_progress", [{ started_at: "2026-09-28T15:01:00Z", steps: step("pending") }], "starting"],
    ["keep step running", "in_progress", [{ started_at: "2026-09-28T15:01:00Z", steps: step("in_progress") }], "ready"],
    ["keep step done", "in_progress", [{ started_at: "2026-09-28T15:01:00Z", steps: step("completed") }], "ending"],
    ["completed", "completed", undefined, "done"],
  ];
  for (const [what, status, js, want] of phases) {
    it(`phase: ${what}`, () => assert.equal(devspaceOf({ ...base, status }, js ? parseJobs(js) : undefined)?.phase, want));
  }
  it("takes cores and minutes from the title when the job doesn't say", () => {
    const d = devspaceOf({ ...base, status: "queued" }, undefined);
    assert.equal(d?.cores, 4);
    assert.equal(d?.durationMin, 30);
  });
  it("skips runs that aren't devspaces", () => assert.equal(devspaceOf({ ...base, display_title: "Development runner" }, undefined), undefined));
});

describe("timeLeft", () => {
  const base: Devspace = {
    id: 1, name: "n", host: "h", url: "u", phase: "ready", createdAt: "2026-09-28T15:00:00Z",
    startedAt: "2026-09-28T15:00:00Z", readyAt: "2026-09-28T15:02:05Z",
  };
  const { readyAt: _, ...notReady } = base;
  const cases: [string, Devspace, ReturnType<typeof timeLeft>][] = [
    ["known duration, from the keep step", { ...base, durationMin: 30 }, { ms: 20 * MIN, totalMs: 30 * MIN, bound: "known" }],
    ["unknown: bounded by the longest", base, { ms: 230 * MIN, totalMs: 240 * MIN, bound: "max" }],
    ["past its end", { ...base, durationMin: 5 }, { ms: 0, totalMs: 5 * MIN, bound: "known" }],
    ["starting: from the job's start", { ...notReady, phase: "starting", durationMin: 60 }, { ms: 48 * MIN - 5000, totalMs: 60 * MIN, bound: "known" }],
    ["queued", { ...base, phase: "queued" }, undefined],
    ["done", { ...base, phase: "done" }, undefined],
  ];
  const now = Date.parse("2026-09-28T15:12:05Z");
  for (const [what, d, want] of cases) it(what, () => assert.deepEqual(timeLeft(d, now), want));
});

describe("coreHourBuckets and history", () => {
  const dev = (name: string, cores: number | undefined, start: number, end: number | undefined, outcome?: Devspace["outcome"]): Devspace => ({
    id: 1, name, host: "h", url: "u",
    phase: end === undefined ? "ready" : "done",
    createdAt: new Date(start).toISOString(),
    startedAt: new Date(start).toISOString(),
    ...(end !== undefined ? { endedAt: new Date(end).toISOString() } : {}),
    ...(cores ? { cores } : {}),
    ...(outcome ? { outcome } : {}),
  });
  const now = Date.parse("2026-09-28T12:00:00Z");
  const list = [
    // 16 cores for the last 30 minutes, still running: 8 core-hours in the last bucket.
    dev("live", 16, now - 30 * MIN, undefined),
    // 4 cores for two hours ending an hour ago: 4 core-hours in each of the two hours before the last.
    dev("two-hours", 4, now - 3 * HOUR, now - HOUR, "stopped"),
    // Started before the window: only its part inside counts, and it isn't counted as started.
    dev("old", 64, now - 25 * HOUR, now - 23 * HOUR - 30 * MIN, "expired"),
    dev("broken", 16, now - 2 * HOUR, now - 2 * HOUR + 6 * MIN, "failed"),
    dev("unsized", undefined, now - HOUR, now - 30 * MIN, "stopped"),
  ];
  it("spreads runner time over hourly buckets", () => {
    const b = coreHourBuckets(list, now, 4);
    assert.deepEqual(b.map((x) => Math.round(x * 100) / 100), [0, 4, 4 + 1.6, 8]);
  });
  it("sums the window and counts outcomes of devspaces started in it", () => {
    const h = history(list, now, 24);
    assert.equal(h.count, 4);
    assert.equal(Math.round(h.coreHours * 100) / 100, 8 + 8 + 1.6 + 32);
    assert.deepEqual(h.outcomes, { stopped: 2, expired: 0, failed: 1, other: 0 });
    assert.equal(h.unsized, 1);
  });
  it("on the real snapshot: 16 cores each, one still up", () => {
    const all = [36439387350, 36439856834, 36422184366, 36418863271].map(row);
    const h = history(all, NOW, 24);
    assert.equal(h.count, 4);
    assert.deepEqual(h.outcomes, { stopped: 2, expired: 1, failed: 0, other: 0 });
    // 16 × (16m31s live + 6m54s + 60m36s + 8m14s) of runner time.
    const minutes = (16 * 60 + 31 + 6 * 60 + 54 + 60 * 60 + 36 + 8 * 60 + 14) / 60;
    assert.equal(h.coreHours.toFixed(3), ((16 * minutes) / 60).toFixed(3));
  });
});

describe("agentRuns", () => {
  const run = (id: number, status: string, conclusion: string | null = null): RawRun => ({
    id, html_url: `https://github.com/x/actions/runs/${id}`, display_title: `Agent ${id}`, status, conclusion, created_at: "2026-09-28T10:00:00Z",
  });
  it("lists active runs first, then the newest finished", () => {
    const got = agentRuns([run(5, "completed", "success"), run(4, "in_progress"), run(3, "completed", "failure"), run(2, "completed", "cancelled")], 2);
    assert.deepEqual(got.map((r) => [r.id, r.active, r.outcome]), [[4, true, undefined], [5, false, "expired"], [3, false, "failed"]]);
  });
});

describe("workGroups", () => {
  const item = (nodeId: string, url: string | undefined, over: Partial<Item> = {}): Item => ({
    id: 1, nodeId, kind: url ? "issue" : "draft", title: nodeId, body: "", why: "", branch: [], gist: [], labels: [], assignees: [],
    ...(url ? { url, ref: { owner: url.split("/")[3] ?? "", repo: url.split("/")[4] ?? "", number: 1 } } : {}),
    ...over,
  });
  it("splits upstream from the bot's own like the queue's presets, by priority", () => {
    const groups = workGroups([
      item("infra", "https://github.com/cgwalters-bot/cgwalters-bot/issues/11", { org: "cgwalters-bot", priority: "P1" }),
      item("upstream-p2", "https://github.com/fedora-selinux/selinux-policy/pull/3327", { priority: "P2" }),
      item("upstream-p0", "https://github.com/cgwalters-forge/tracker/issues/160", { org: "bootc-dev", priority: "P0" }),
      item("tracker-no-org", "https://github.com/cgwalters-forge/tracker/issues/1"),
    ]);
    assert.deepEqual(groups.map((g) => [g.scope, g.items.map((i) => i.nodeId)]), [
      ["composefs", ["upstream-p0", "upstream-p2"]],
      ["infra", ["infra"]],
      ["none", ["tracker-no-org"]],
    ]);
  });
});

describe("parseEvent", () => {
  const ev = (type: string, payload: NonNullable<RawEvent["payload"]>, repo = "o/r"): RawEvent => ({ id: "1", type, created_at: "2026-09-28T15:00:00Z", repo: { name: repo }, payload });
  const head = "379ba6cfd2dcca2a36722271d8754d783e82312f";
  const cases: [string, RawEvent, Partial<ReturnType<typeof parseEvent>> | undefined][] = [
    ["push", ev("PushEvent", { ref: "refs/heads/bot/x", head }), { kind: "push", verb: "pushed", target: "bot/x", url: `https://github.com/o/r/commit/${head}` }],
    ["push without a head", ev("PushEvent", { ref: "refs/heads/bot/x" }), { url: "https://github.com/o/r" }],
    ["PR opened", ev("PullRequestEvent", { action: "opened", number: 31, pull_request: { number: 31 } }), { kind: "pr", verb: "opened PR", target: "#31", url: "https://github.com/o/r/pull/31" }],
    ["PR closed as merged", ev("PullRequestEvent", { action: "closed", pull_request: { number: 2, merged: true } }), { verb: "merged PR" }],
    ["review", ev("PullRequestReviewEvent", { pull_request: { number: 4 }, review: { state: "APPROVED", html_url: "https://github.com/o/r/pull/4#r" } }), { kind: "review", verb: "reviewed (approved)", url: "https://github.com/o/r/pull/4#r" }],
    ["issue comment", ev("IssueCommentEvent", { issue: { number: 9, title: "T" }, comment: { html_url: "https://github.com/o/r/issues/9#c" } }), { kind: "comment", verb: "commented on", title: "T", url: "https://github.com/o/r/issues/9#c" }],
    ["issue closed", ev("IssuesEvent", { action: "closed", issue: { number: 9, html_url: "https://github.com/o/r/issues/9" } }), { kind: "issue", verb: "closed issue" }],
    ["branch created", ev("CreateEvent", { ref: "bot/y", ref_type: "branch" }), { kind: "branch", verb: "created branch", url: "https://github.com/o/r/tree/bot/y" }],
    ["tag created", ev("CreateEvent", { ref: "v1", ref_type: "tag" }), undefined],
    ["star", ev("WatchEvent", {}), undefined],
    ["bad repo name", ev("PushEvent", { ref: "refs/heads/x" }, "javascript:alert(1)"), undefined],
  ];
  for (const [what, raw, want] of cases) {
    it(what, () => {
      const got = parseEvent(raw);
      if (want === undefined) assert.equal(got, undefined);
      else for (const [k, v] of Object.entries(want)) assert.deepEqual(got?.[k as keyof typeof got], v, k);
    });
  }
});

describe("botEvents", () => {
  it("parses the real snapshot, newest first, skipping nothing it knows", () => {
    const got = botEvents(events());
    assert.equal(got.length, 14);
    assert.deepEqual(got[0], { kind: "pr", repo: "cgwalters-bot/homegit", verb: "opened PR", target: "#31", url: "https://github.com/cgwalters-bot/homegit/pull/31", at: "2026-09-28T15:11:24Z", count: 1 });
    assert.ok(got.every((e, i) => i === 0 || (got[i - 1]?.at ?? "") >= e.at));
  });
  it("folds a run of the same action on the same thing", () => {
    const c = (id: string, at: string, n: number): RawEvent => ({ id, type: "IssueCommentEvent", created_at: at, repo: { name: "o/r" }, payload: { issue: { number: n } } });
    const got = botEvents([c("1", "2026-01-01T00:00:03Z", 1), c("2", "2026-01-01T00:00:02Z", 1), c("3", "2026-01-01T00:00:01Z", 2), c("4", "2026-01-01T00:00:00Z", 1)]);
    assert.deepEqual(got.map((e) => [e.target, e.count]), [["#1", 2], ["#2", 1], ["#1", 1]]);
  });
});

describe("loadOps", () => {
  const raw = (status: string, org: string, n: number) => ({
    id: n, node_id: `PVTI_${n}`, content_type: "Issue",
    content: { title: `<b>item ${n}</b>`, html_url: `https://github.com/cgwalters-forge/tracker/issues/${n}`, state: "open" },
    fields: [
      { id: 102, name: "Status", value: { name: { raw: status } } },
      { id: 105, name: "Org", value: { name: { raw: org } } },
      { id: 106, name: "Branch", value: { raw: "https://github.com/cgwalters-forge/bootc/pull/31" } },
    ],
  });
  const script = (agent: "missing" | "present") =>
    scriptedFetch((_m, url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/workflows/devspace.yml/runs")) return { body: { workflow_runs: runs() } };
      if (u.pathname.endsWith("/workflows/agent.yml/runs")) {
        return agent === "missing" ? { status: 404, body: { message: "Not Found" } } : { body: { workflow_runs: [{ id: 1, html_url: "https://github.com/x/actions/runs/1", display_title: "Agent", status: "in_progress", created_at: "2026-09-28T15:00:00Z" }] } };
      }
      const job = /\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
      if (job?.[1]) return { body: { jobs: jobs()[job[1]] ?? [] } };
      if (u.pathname.endsWith("/projectsV2/1/fields")) return { body: fields() };
      if (u.pathname.endsWith("/projectsV2/1/items")) return { body: [raw("In Progress", "bootc-dev", 1), raw("In Progress", "cgwalters-bot", 2), raw("Draft", "bootc-dev", 3)] };
      if (u.pathname === "/users/cgwalters-bot/events/public") return { body: events() };
      if (u.pathname === HEARTBEAT_PATH) return { body: heartbeat() };
      if (u.pathname === USAGE_PATH) return { body: usageComments() };
      return undefined;
    });

  it("reads every section, and a finished run's job only once", async () => {
    const { fetchImpl, calls } = script("missing");
    const gh = new GitHub(async () => "t", fetchImpl);
    const cache: JobCache = new Map();
    const ops = await loadOps(gh, cache, NOW);
    assert.deepEqual(ops.warnings, []);
    assert.deepEqual(ops.agents, { deployed: false });
    assert.deepEqual(ops.devspaces?.devspaces.map((d) => [d.name, d.phase, d.cores]), [
      ["selinux-finalize", "done", 16],
      ["selinux-3327", "ready", 16],
      ["bootc-2504", "done", 16],
      ["praxis-opencode", "done", 16],
    ]);
    assert.equal(ops.devspaces?.partial, false);
    assert.deepEqual(ops.work?.map((i) => i.nodeId), ["PVTI_1", "PVTI_2"]);
    assert.equal(ops.events?.length, 14);
    assert.equal(ops.usage?.state === "ok" && ops.usage.usage.workers.length, 2);
    // The whole board, for the changes feed; active work is its In Progress items.
    assert.equal(new URL(calls.find((c) => c.url.includes("/items"))?.url ?? "").searchParams.get("q"), null);
    assert.deepEqual(ops.board?.map((i) => i.nodeId), ["PVTI_1", "PVTI_2", "PVTI_3"]);

    const before = calls.length;
    await loadOps(gh, cache, NOW);
    const jobReads = calls.slice(before).filter((c) => c.url.includes("/jobs"));
    assert.deepEqual(jobReads.map((c) => new URL(c.url).pathname), [`${new URL(REPO).pathname}/actions/runs/36439387350/jobs`]);
  });

  it("reads finished runs' jobs from the persistent cache, and renders from it alone", async () => {
    const factory = new IDBFactory();
    const page = async () => {
      const store = await IdbStore.open(factory);
      assert.ok(store);
      const cache = new ResponseCache({ now: () => NOW });
      assert.ok(await cache.attach(store, "cgwalters", "h"));
      const { fetchImpl, calls } = script("missing");
      return { gh: new GitHub(async () => "t", fetchImpl, cache), cache, calls };
    };
    const first = await page();
    await loadOps(first.gh, new Map(), NOW);
    await first.cache.flushed();

    // A reload: the in-memory job map is gone, the persistent cache isn't.
    const second = await page();
    const cached = await loadOps(second.gh.cacheOnly(), new Map(), NOW);
    assert.equal(second.calls.length, 0, "a cache-only read never touches the network");
    // The agent workflow's 404 isn't cached: that section is just missing, without a warning.
    assert.deepEqual(cached.warnings, []);
    assert.equal(cached.agents, undefined);
    assert.deepEqual(cached.devspaces?.devspaces.map((d) => [d.name, d.cores]), [
      ["selinux-finalize", 16],
      ["selinux-3327", 16],
      ["bootc-2504", 16],
      ["praxis-opencode", 16],
    ]);
    await loadOps(second.gh, new Map(), NOW);
    const jobReads = second.calls.filter((c) => c.url.includes("/jobs"));
    assert.deepEqual(jobReads.map((c) => new URL(c.url).pathname), [`${new URL(REPO).pathname}/actions/runs/36439387350/jobs`], "only the live run's jobs");
  });

  it("takes a cached jobs copy as final only if its jobs of this attempt completed", async () => {
    const done = (attempt?: number) => ({ status: "completed", completed_at: "2026-09-28T15:04:10Z", ...(attempt ? { run_attempt: attempt } : {}) });
    const cases: [string, RawJob[], number, boolean][] = [
      ["completed", [done()], 1, true],
      ["completed, same attempt", [done(2)], 2, true],
      ["an earlier attempt's", [done(1)], 2, false],
      ["still running", [{ status: "in_progress", completed_at: null }], 1, false],
      ["one of two running", [done(), { status: "in_progress" }], 1, false],
      ["no jobs", [], 1, false],
    ];
    for (const [name, jobList, attempt, final] of cases) assert.equal(jobsFinal(jobList, attempt), final, name);

    // A copy cached while the run was going is read again, whatever the clocks say.
    let n = 0;
    const { fetchImpl, calls } = scriptedFetch(() => ({ body: { jobs: n++ === 0 ? [{ status: "in_progress", completed_at: null }] : [done()] }, headers: { etag: `"${n}"` } }));
    const gh = new GitHub(async () => "t", fetchImpl, new ResponseCache());
    const isFinal = (d: { jobs?: RawJob[] }) => jobsFinal(d.jobs, 1);
    await gh.get("/jobs");
    await assert.rejects(gh.cacheOnly().getSettled("/jobs", isFinal), /not cached in its final state/);
    assert.equal(jobsFinal((await gh.getSettled("/jobs", isFinal)).data.jobs, 1), true);
    const before = calls.length;
    await gh.getSettled("/jobs", isFinal);
    assert.equal(calls.length, before, "a final copy is used without asking GitHub");
    // A final copy doesn't make a cache-only read look old.
    const cached = gh.cacheOnly();
    await cached.getSettled("/jobs", isFinal);
    assert.equal(cached.oldest, undefined);
  });

  it("keeps the other sections when one fails", async () => {
    const failing = scriptedFetch(() => ({ status: 500, body: { message: "boom" } }));
    const ok = script("present");
    const gh = new GitHub(async () => "t", (url, init) => (url.includes("/events/") ? failing.fetchImpl(url, init) : ok.fetchImpl(url, init)));
    const ops = await loadOps(gh, new Map(), NOW);
    assert.equal(ops.events, undefined);
    assert.equal(ops.warnings.length, 1);
    assert.match(ops.warnings[0] ?? "", /cgwalters-bot's recent activity.*HTTP 500/);
    assert.equal(ops.agents?.deployed, true);
    assert.equal(ops.devspaces?.devspaces.length, 4);
  });

  it("keeps parallel cached source ages separate from each other and earlier reads", async () => {
    const { fetchImpl, calls } = script("present");
    const cache = new ResponseCache({ now: () => NOW });
    const gh = new GitHub(async () => "t", fetchImpl, cache);
    await loadOps(gh, new Map(), NOW);
    for (const url of new Set(calls.map((call) => call.url))) {
      const entry = await cache.get(url);
      if (!entry) continue;
      const path = new URL(url).pathname;
      const age = path === HEARTBEAT_PATH ? 5 * MIN : path === USAGE_PATH ? 30 * MIN : path.endsWith("/fields") ? 2 * HOUR : path.endsWith("/items") ? HOUR : 3 * HOUR;
      cache.put(url, { ...entry, fetchedAt: NOW - age }, JSON.stringify(entry.data).length);
    }
    const cached = gh.cacheOnly();
    const eventUrl = calls.find((call) => new URL(call.url).pathname === "/users/cgwalters-bot/events/public")!.url;
    await cached.get(eventUrl);
    const before = calls.length;
    const [active, ops] = await Promise.all([loadActive(cached, NOW), loadOps(cached, new Map(), NOW)]);
    for (const result of [active, ops]) {
      assert.equal(result.sources?.board?.fetchedAt, NOW - 2 * HOUR, "board uses its oldest page");
      assert.equal(result.sources?.heartbeat?.fetchedAt, NOW - 5 * MIN);
      assert.equal(result.sources?.usage?.fetchedAt, NOW - 30 * MIN);
      for (const name of ["board", "heartbeat", "usage"]) assert.equal(result.sources?.[name]?.state, "cached");
    }
    assert.equal(cached.oldest, NOW - 3 * HOUR, "the aggregate age remains available to existing callers");
    assert.equal(calls.length, before, "scoped cached reads never touch the network");
  });
});
