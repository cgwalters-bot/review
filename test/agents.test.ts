import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeAgents, type ActiveAgent, isClaimed, laneOf } from "../src/github/agents.ts";
import { AGENT_ROW_CLASS, agentsBody, agentsSummary } from "../src/github/agentsview.ts";
import { GitHub } from "../src/github/api.ts";
import { type Item, parseItem } from "../src/github/board.ts";
import { DISPATCH_POLL_MS, loadDispatch } from "../src/github/dispatch.ts";
import type { Heartbeat, LocalWorker } from "../src/github/heartbeat.ts";
import { installDom } from "./helpers.ts";

installDom();

const MIN = 60_000;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const TRACKER = "https://github.com/cgwalters-forge/tracker/issues";

function item(nodeId: string, url: string | undefined, over: Partial<Item> = {}): Item {
  const m = url ? /github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)$/.exec(url) : null;
  return {
    id: 0,
    nodeId,
    kind: url?.includes("/pull/") ? "pr" : "issue",
    title: nodeId,
    body: "",
    why: "",
    labels: [],
    assignees: [],
    branch: [],
    gist: [],
    status: "In Progress",
    ...(url ? { url } : {}),
    ...(m ? { ref: { owner: m[1] as string, repo: m[2] as string, number: Number(m[3]) } } : {}),
    ...over,
  };
}

function worker(name: string, itemUrl: string, over: Partial<LocalWorker> = {}): LocalWorker {
  const m = /github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)$/.exec(itemUrl);
  return { name, itemUrl, itemRef: `${m?.[1]}/${m?.[2]}#${m?.[3]}`, startedAt: ago(30 * MIN), status: "working", ...over };
}

function heartbeat(workers: LocalWorker[], updatedAgo = 2 * MIN, over: Partial<Heartbeat> = {}): Heartbeat {
  return { updatedAt: ago(updatedAgo), session: "s", loopState: "working", workers, skipped: 0, ...over };
}

describe("isClaimed", () => {
  const cases: [string, Partial<Item>, boolean][] = [
    ["In Progress with a Lead", { lead: "wfc" }, true],
    ["In Progress with a Run", { run: "https://github.com/o/r/actions/runs/1" }, true],
    ["In Progress with neither", {}, false],
    ["a Lead on a Draft item", { status: "Draft", lead: "wfc" }, false],
  ];
  for (const [name, over, want] of cases) it(name, () => assert.equal(isClaimed(item("PVTI_x", `${TRACKER}/1`, over)), want));
});

describe("laneOf", () => {
  const cases: [string | undefined, string][] = [["cgwalters-bot", "harness"], ["cgwalters-forge", "harness"], ["bootc-dev", "upstream"], [undefined, "unknown"]];
  for (const [org, want] of cases) it(String(org), () => assert.equal(laneOf(org), want));
});

describe("activeAgents", () => {
  type Row = [name: string, source: ActiveAgent["source"], lane: ActiveAgent["lane"], status: string, stale: boolean];
  const row = (a: ActiveAgent): Row => [a.name, a.source, a.lane, a.status, a.stale];

  // name, board, heartbeat, the agents in order, running, lanes [harness, upstream, unknown], unconfirmed
  const cases: [string, Item[], Heartbeat | null | undefined, Row[], number, [number, number, number], number][] = [
    [
      "a worker on a claimed item is one agent seen in both",
      [item("PVTI_r", "https://github.com/cgwalters-forge/review/issues/31", { lead: "coordinator", org: "cgwalters-forge" })],
      heartbeat([worker("strip", "https://github.com/cgwalters-forge/review/issues/31")]),
      [["strip", "both", "harness", "working", false]],
      1,
      [1, 0, 0],
      0,
    ],
    [
      "a worker on a PR in a claimed item's Branch is matched by it",
      [item("PVTI_t", `${TRACKER}/173`, { lead: "bootc-fsck-173", org: "bootc-dev", branch: ["https://github.com/bootc-dev/bootc/pull/2501"] })],
      heartbeat([worker("rebase", "https://github.com/bootc-dev/bootc/pull/2501")]),
      [["rebase", "both", "upstream", "working", false]],
      1,
      [0, 1, 0],
      0,
    ],
    [
      "a worker on an item that isn't claimed gets its lane from it, and the board adds nothing",
      [item("PVTI_p4", "https://github.com/cgwalters-bot/praxis-credential-broker/pull/4", { status: "Draft", org: "cgwalters-bot" })],
      heartbeat([worker("praxis", "https://github.com/cgwalters-bot/praxis-credential-broker/pull/4")]),
      [["praxis", "heartbeat", "harness", "working", false]],
      1,
      [1, 0, 0],
      0,
    ],
    [
      "a worker on no board item takes its lane from the URL's owner; a tracker issue's is unknown",
      [],
      heartbeat([worker("up", "https://github.com/bootc-dev/bootc/issues/9", { startedAt: ago(5 * MIN) }), worker("tr", `${TRACKER}/264`, { startedAt: ago(10 * MIN) })]),
      [["tr", "heartbeat", "unknown", "working", false], ["up", "heartbeat", "upstream", "working", false]],
      2,
      [0, 1, 1],
      0,
    ],
    [
      "board claims without execution evidence stay unconfirmed",
      [
        item("PVTI_wfc", "https://github.com/cgwalters-forge/gh-aw/issues/1", { lead: "wfc", priority: "P1", org: "cgwalters-forge" }),
        item("PVTI_run", `${TRACKER}/58`, { run: "https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/1", priority: "P0", org: "bootc-dev" }),
        item("PVTI_idle", `${TRACKER}/62`, { priority: "P0" }),
      ],
      heartbeat([]),
      [["agent run", "board", "upstream", "run", true], ["wfc", "board", "harness", "claimed", true]],
      0,
      [0, 0, 0],
      2,
    ],
    [
      "board claims cannot rescue stale heartbeat workers",
      [item("PVTI_c", `${TRACKER}/173`, { lead: "fsck", org: "bootc-dev" })],
      heartbeat([worker("old", "https://github.com/bootc-dev/bootc/issues/9"), worker("fsck", `${TRACKER}/173`)], 3 * 60 * MIN),
      [["fsck", "both", "upstream", "working", true], ["old", "heartbeat", "upstream", "working", true]],
      0,
      [0, 0, 0],
      2,
    ],
    [
      "a stopped coordinator's workers are unconfirmed, however fresh its heartbeat",
      [],
      heartbeat([worker("left", "https://github.com/bootc-dev/bootc/issues/9")], 2 * MIN, { loopState: "stopped" }),
      [["left", "heartbeat", "upstream", "working", true]],
      0,
      [0, 0, 0],
      1,
    ],
    [
      "without a heartbeat, board claims are not execution",
      [item("PVTI_wfc", "https://github.com/cgwalters-forge/gh-aw/issues/1", { lead: "wfc", org: "cgwalters-forge" })],
      null,
      [["wfc", "board", "harness", "claimed", true]],
      0,
      [0, 0, 0],
      1,
    ],
  ];
  for (const [name, board, hb, want, running, [harness, upstream, unknown], unconfirmed] of cases) {
    it(name, () => {
      const s = activeAgents(board, hb, NOW);
      assert.deepEqual(s.agents.map(row), want);
      assert.equal(s.running, running);
      assert.deepEqual(s.lanes, { harness, upstream, unknown });
      assert.equal(s.unconfirmed, unconfirmed);
      assert.equal(s.target, 4);
    });
  }

  it("carries the item's title, priority, Lead and Run onto the merged agent", () => {
    const run = "https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/7";
    const board = [item("PVTI_t", `${TRACKER}/60`, { title: "safe outputs", priority: "P0", lead: "wfc", run })];
    const [a] = activeAgents(board, heartbeat([worker("w", `${TRACKER}/60`, { devspace: "ds-1" })]), NOW).agents;
    assert.deepEqual(a, {
      name: "w",
      itemUrl: `${TRACKER}/60`,
      itemRef: "cgwalters-forge/tracker#60",
      status: "working",
      since: ago(30 * MIN),
      source: "both",
      location: "remote",
      lane: "unknown",
      stale: true,
      title: "safe outputs",
      priority: "P0",
      lead: "wfc",
      runUrl: run,
      devspace: "ds-1",
    });
  });

  it("says how fresh the heartbeat is", () => {
    const cases: [Heartbeat | null | undefined, unknown][] = [
      [undefined, undefined],
      [null, null],
      [heartbeat([], 2 * MIN), { updatedAt: ago(2 * MIN), loopState: "working", stale: false, stopped: false }],
      [heartbeat([], 3 * 60 * MIN), { updatedAt: ago(3 * 60 * MIN), loopState: "working", stale: true, stopped: false }],
      [heartbeat([], 3 * 60 * MIN, { loopState: "stopped" }), { updatedAt: ago(3 * 60 * MIN), loopState: "stopped", stale: false, stopped: true }],
    ];
    for (const [hb, want] of cases) assert.deepEqual(activeAgents([], hb, NOW).heartbeat, want);
  });

  it("counts remote/local agents and OpenCode share, without counting stale workers", () => {
    const board = [item("remote", `${TRACKER}/1`, { run: "https://github.com/o/r/actions/runs/1", engine: "opencode" })];
    const hb = heartbeat([worker("local", `${TRACKER}/2`, { engine: "claude" }), worker("unknown", `${TRACKER}/3`)]);
    const s = activeAgents(board, hb, NOW);
    assert.deepEqual(s.locations, { remote: 0, local: 2 });
    assert.equal(s.opencode, 0);
    assert.equal(s.unknownEngine, 1);
    const stale = activeAgents(board, { ...hb, updatedAt: ago(60 * MIN) }, NOW);
    assert.deepEqual(stale.locations, { remote: 0, local: 0 });
    assert.equal(stale.running, 0);
  });

  it("reads Run from the board", () => {
    const run = "https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/7";
    const parsed = parseItem({ id: 1, node_id: "PVTI_1", content_type: "Issue", fields: [{ name: "Run", value: { raw: ` ${run} ` } }, { name: "Status", value: { name: { raw: "In Progress" } } }] });
    assert.equal(parsed.run, run);
    assert.ok(isClaimed(parsed));
    const junk = parseItem({ id: 1, node_id: "PVTI_1", content_type: "Issue", fields: [{ name: "Run", value: { raw: "javascript:alert(1)" } }] });
    assert.equal(junk.run, undefined);
  });
});

describe("agentsBody", () => {
  const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ");
  const board = [
    item("PVTI_wfc", "https://github.com/cgwalters-forge/gh-aw/issues/1", { lead: "wfc", org: "cgwalters-forge", priority: "P1" }),
    item("PVTI_t", `${TRACKER}/173`, { lead: "fsck", org: "bootc-dev" }),
  ];

  it("shows the lanes, each agent, the heartbeat's age, and the count against the target in the summary", () => {
    const data = { board, local: heartbeat([worker("fsck", `${TRACKER}/173`), worker("old", "https://github.com/bootc-dev/bootc/issues/9")], 3 * 60 * MIN), warnings: [], at: NOW };
    const el = agentsBody(data, NOW);
    const t = text(el);
    assert.match(t, /harness 0 · upstream 0/);
    assert.match(t, /\+3 unconfirmed/);
    assert.match(t, /heartbeat 3h ago/);
    assert.deepEqual([...el.querySelectorAll(`.${AGENT_ROW_CLASS} strong`)].map((s) => s.textContent), ["wfc", "fsck", "old"]);
    assert.equal(el.querySelectorAll(`.${AGENT_ROW_CLASS}.stale`).length, 3);
    assert.deepEqual(agentsSummary(data, NOW), { count: "0/4", title: "0 working, aiming for about 4", under: true });
  });

  it("links a remote agent run to its run", () => {
    const run = "https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/123";
    const el = agentsBody({ board: [item("PVTI_r", `${TRACKER}/9`, { lead: "remote", run })], local: heartbeat([]), warnings: [], at: NOW }, NOW);
    const a = el.querySelector<HTMLAnchorElement>(`.${AGENT_ROW_CLASS} a[href="${run}"]`);
    assert.equal(a?.textContent, "run ↗");
  });

  it("says what it couldn't read", () => {
    const cases: [Parameters<typeof agentsBody>[0], RegExp][] = [
      [undefined, /Reading…/],
      [{ warnings: ["x"], at: NOW }, /Couldn't read the board or the heartbeat/],
      [{ board, warnings: [], at: NOW }, /heartbeat unread/],
      [{ board, local: null, warnings: [], at: NOW }, /no heartbeat/],
      [{ local: heartbeat([]), warnings: [], at: NOW }, /board unread/],
      [{ board: [], local: heartbeat([]), warnings: [], at: NOW }, /No agent is working right now/],
      [{ board: [], local: heartbeat([], 2 * 24 * 60 * MIN, { loopState: "stopped" }), warnings: [], at: NOW }, /coordinator stopped · heartbeat 2d ago/],
    ];
    for (const [data, want] of cases) assert.match(text(agentsBody(data, NOW)), want);
    const failed = agentsBody({ local: heartbeat([]), warnings: ["Couldn't read the board: 502"], at: NOW }, NOW);
    assert.match(failed.querySelector(".as-head .warn")?.getAttribute("title") ?? "", /502/, "says why on hover");
    assert.equal(agentsSummary(undefined, NOW).count, "…");
    assert.equal(agentsSummary({ warnings: ["x"], at: NOW }, NOW).count, "?");
  });

  it("puts hostile board and heartbeat text on screen as text", () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const hostile = [item("PVTI_e", `${TRACKER}/9`, { lead: evil, title: evil, run: "https://github.com/o/r/actions/runs/1" })];
    const el = agentsBody({ board: hostile, local: heartbeat([]), warnings: [], at: NOW }, NOW);
    assert.equal(el.querySelector("img, script"), null);
    assert.match(text(el), /<img src=x/);
  });
});

describe("activeAgents from the tracker's recorded dispatch runs", () => {
  const RUNS = "/repos/cgwalters-forge/tracker/actions/workflows/dispatch.yml/runs?per_page=100";
  const run = (id: number, title: string, status: string) => ({
    id, html_url: `https://github.com/cgwalters-forge/tracker/actions/runs/${id}`, display_title: title, status, conclusion: null, created_at: ago(20 * MIN), run_started_at: ago(20 * MIN), updated_at: ago(MIN),
  });
  const A = run(101, "implement cgwalters-forge/review#154 (claude)", "in_progress");
  const B = run(102, "fix cgwalters-forge/agent-board#7 (openai)", "in_progress");
  const C = run(103, "triage cgwalters-forge/tracker#90 (openai)", "in_progress");
  const Q = run(104, "implement cgwalters-forge/review#155 (openai)", "queued");

  /** The in-progress and queued lists as GitHub returned them (the unfiltered list holds the same runs); null fails the reads. */
  async function dispatch(lists: { inProgress: ReturnType<typeof run>[]; queued: ReturnType<typeof run>[] } | null, at = NOW) {
    const gh = new GitHub(async () => "fixture", async (url) => {
      const path = url.replace("https://api.github.com", "");
      if (!lists) return Response.json({ message: "Server Error" }, { status: 500 });
      if (path === `${RUNS}&status=in_progress`) return Response.json({ total_count: lists.inProgress.length, workflow_runs: lists.inProgress });
      if (path === `${RUNS}&status=queued`) return Response.json({ total_count: lists.queued.length, workflow_runs: lists.queued });
      if (path === RUNS) return Response.json({ total_count: lists.inProgress.length + lists.queued.length, workflow_runs: [...lists.queued, ...lists.inProgress] });
      if (/\/actions\/runs\/\d+\/jobs\?/.test(path)) return Response.json({ total_count: 0, jobs: [] });
      throw new Error(`unexpected request: ${path}`);
    });
    return loadDispatch(gh, new Map(), at);
  }

  // name, the lists, when they were read, the board; running, the running ones' item refs, unconfirmed, queued, whether execution is known
  const cases: [string, Parameters<typeof dispatch>[0], number, Item[], number, string[], number, number, boolean][] = [
    ["three runs in flight are three agents (#170 read 0)", { inProgress: [A, B, C], queued: [] }, NOW, [], 3, ["cgwalters-forge/review#154", "cgwalters-forge/agent-board#7", "cgwalters-forge/tracker#90"], 0, 0, true],
    ["a queued run isn't running yet", { inProgress: [A], queued: [Q] }, NOW, [], 1, ["cgwalters-forge/review#154"], 0, 1, true],
    [
      "a board claim naming the run is that agent, not a second unconfirmed one",
      { inProgress: [A], queued: [] }, NOW,
      [item("PVTI_a", "https://github.com/cgwalters-forge/review/issues/154", { lead: "x", run: A.html_url, org: "cgwalters-forge", priority: "P1" })],
      1, ["cgwalters-forge/review#154"], 0, 0, true,
    ],
    ["a reading older than two polls is unconfirmed", { inProgress: [A, B], queued: [] }, NOW - 3 * DISPATCH_POLL_MS, [], 0, [], 2, 0, true],
    ["a failed read knows nothing", null, NOW, [], 0, [], 0, 0, false],
  ];
  for (const [name, lists, at, board, running, refs, unconfirmed, queued, known] of cases) it(name, async () => {
    const s = activeAgents(board, undefined, NOW, 8, { dispatch: await dispatch(lists, at) });
    assert.deepEqual([s.running, s.agents.filter((a) => !a.stale).map((a) => a.itemRef).sort(), s.unconfirmed, s.queued.length, s.executionKnown], [running, [...refs].sort(), unconfirmed, queued, known]);
  });
});
