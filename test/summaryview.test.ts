// The summary at the top of the page: made from what the sections read,
// with no read of its own.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActiveAgent } from "../src/github/agents.ts";
import type { ControllerData } from "../src/github/controller.ts";
import type { RawComment } from "../src/github/heartbeat.ts";
import { findHolds } from "../src/github/holds.ts";
import { fillSummary, homeSkeleton } from "../src/github/homeview.ts";
import type { ActionRun, RunsData } from "../src/github/runs.ts";
import { showView } from "../src/github/shell.ts";
import { pageState } from "../src/github/state.ts";
import { parseUsage, USAGE_MARKER, type UsagePool } from "../src/github/usage.ts";
import { clock, time } from "../src/github/view.ts";
import { fixture, installDom } from "./helpers.ts";

const win = installDom();
const NOW = Date.parse("2026-10-09T14:00:00Z");
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const noHooks = { open: () => false, toggled: () => {}, opsToggled: () => {}, themesToggled: () => {} };

const run = (id: number, status: string, title: string): ActionRun => ({
  id, title, status, active: true, url: `https://github.com/example/runs/actions/runs/${id}`, startedAt: "2026-10-09T13:30:00Z",
  createdAt: "2026-10-09T13:30:00Z", attempt: 1, jobs: [], metrics: { tokens: null, cost: null },
});

describe("the summary", () => {
  const runs: RunsData = { state: "ok", at: NOW, partial: false, warnings: [], runs: [run(1, "in_progress", "Agent: implement example/work#3"), run(2, "queued", "Agent: review example/work#4")] };
  const usage = parseUsage(`${USAGE_MARKER}\n\`\`\`json\n${JSON.stringify(fixture("usage-pools.json"))}\n\`\`\``)!;
  usage.mistral!.budget = { limitUsd: 300, since: "2026-10-01T00:00:00.000Z", resetsAt: "2026-11-01T00:00:00.000Z" };
  const state = pageState({ active: { warnings: [], at: NOW, usage: { state: "ok", usage } }, runs }, NOW);

  it("comes first, and says agents, queued runs and each pool in a line, with held marked", () => {
    const home = homeSkeleton(noHooks);
    win.document.body.replaceChildren(home.el);
    fillSummary(home, state, undefined, NOW);
    assert.equal(home.el.firstElementChild, home.slots.summary);
    const lines = [...home.slots.summary.querySelectorAll("li")].map(text);
    assert.match(lines[0]!, /^Agents \d+ running/);
    assert.match(lines[1]!, /^Queued 1 run · Agent: review example\/work#4$/);
    assert.equal(lines[2], "Scheduler pass not read · broker not read: it is read when the ops detail is opened");
    assert.deepEqual(lines.slice(3), [
      "Claude 42% used · 52% of week gone · ~81% at reset · not held; limit not published",
      `OpenAI 80% used · 32% of week gone · ~253% at reset · held (pace): no new runs until ${clock(Date.parse("2026-10-13T00:57:18.315Z"))} (${time("2026-10-13T00:57:18.315Z")}); running runs continue`,
      "Mistral spend not published · $300 a month, 28% gone",
    ]);
    assert.ok(home.slots.summary.querySelectorAll("li")[4]!.classList.contains("hot"));
    assert.equal(home.slots.summary.querySelector<HTMLAnchorElement>("li:nth-child(2) a:not(.sum-jump)")?.href, "https://github.com/example/runs/actions/runs/2");
  });

  it("says what unconfirmed agents are, and a hold with no end or reason given", () => {
    const home = homeSkeleton(noHooks);
    const openai = { ...usage.pools!.openai! };
    delete openai.nextDispatchAt;
    delete openai.reason;
    const held = pageState({ active: { warnings: [], at: NOW, usage: { state: "ok", usage: { ...usage, pools: { openai } } } }, runs }, NOW);
    fillSummary(home, { ...held, agents: { ...held.agents, executionKnown: true, unconfirmed: 7 } }, undefined, NOW);
    const lines = [...home.slots.summary.querySelectorAll("li")].map(text);
    assert.match(lines[0]!, /^Agents \d+ running.* · 7 unconfirmed: claimed or last seen, not confirmed running/);
    // Claude is not in this snapshot: no line, rather than one made up.
    assert.equal(lines[3], "OpenAI 80% used · 32% of week gone · ~253% at reset · held (reason not published): no new runs; resume time not published; running runs continue");

    // A dispatch time already past promises no end.
    const later = Date.parse("2026-10-13T12:00:00Z");
    fillSummary(home, pageState({ active: { warnings: [], at: later, usage: { state: "ok", usage } }, runs }, later), undefined, later);
    const openaiLine = [...home.slots.summary.querySelectorAll("li")].map(text).find((l) => l.startsWith("OpenAI"));
    assert.equal(openaiLine, `OpenAI 80% used · 32% of week gone · ~253% at reset · held (pace): no new runs (was due to end ${time("2026-10-13T00:57:18.315Z")}; awaiting a new reading); running runs continue`);
  });

  it("keeps its lines while what they say is unchanged, and says when usage can't be read", () => {
    const home = homeSkeleton(noHooks);
    fillSummary(home, state, undefined, NOW);
    const first = home.slots.summary.firstElementChild;
    fillSummary(home, state, undefined, NOW);
    assert.equal(home.slots.summary.firstElementChild, first);
    fillSummary(home, pageState({ active: { warnings: [], at: NOW, usage: { state: "unreadable" } }, runs }, NOW), undefined, NOW);
    assert.equal(text(home.slots.summary.querySelectorAll("li")[3]), "Resources unreadable with this token");
  });

  it("links open the section they point at, switching to its view only if it isn't shown", () => {
    const home = homeSkeleton(noHooks);
    win.document.body.replaceChildren(home.el);
    showView(home.el, "inbox");
    Object.assign(win.HTMLElement.prototype, { scrollIntoView() {} });
    fillSummary(home, state, undefined, NOW);
    assert.equal(home.sections.agents.details.open, false);
    assert.equal(home.sections.agents.details.hidden, true);
    home.slots.summary.querySelector<HTMLAnchorElement>('a[href="#sec-agents"]')!.click();
    assert.equal(home.sections.agents.details.open, true);
    assert.equal(home.sections.agents.details.hidden, false);
    assert.equal(win.location.hash, "#agents");
    win.location.hash = "#x";
    home.slots.summary.querySelector<HTMLAnchorElement>('a[href="#ops"]')!.click();
    assert.equal(home.slots.opsBox.open, true);
    assert.equal(win.location.hash, "#x");
  });

  it("says what the pass published with its holds, and the broker probe's run once the ops detail has read it", () => {
    const home = homeSkeleton(noHooks);
    const at = Date.parse("2026-10-26T03:20:00Z");
    // The recorded comments: the older from before wip and pass, the newer with them.
    const [older, newer] = fixture<RawComment[]>("holds-comments.json");
    const line = (comment: RawComment, controller?: ControllerData) => {
      fillSummary(home, pageState({ active: { warnings: [], at, holds: findHolds([comment])! }, runs }, at), controller, at);
      return home.slots.summary.querySelectorAll("li")[2]!;
    };
    assert.equal(text(line(older!)), "Scheduler pass not published · WIP not published · as of 18h ago · broker not read: it is read when the ops detail is opened");
    assert.equal(text(line(newer!)), "Scheduler actions: started 1 · 7 candidates · 2 live epics · WIP 4/4 · as of 10m ago · broker not read: it is read when the ops detail is opened");
    const preview = { ...newer!, body: newer!.body!.replace('"mode":"actions","candidates":7', '"mode":"preview","candidates":null').replace('"in_flight":4', '"in_flight":null') };
    assert.equal(text(line(preview)), "Scheduler previewing (dry run): would start 1 · 2 live epics · WIP ?/4 · as of 10m ago · broker not read: it is read when the ops detail is opened");
    const probe = (last: { at: string; conclusion: string } | undefined): ControllerData => ({ pieces: [{ piece: { label: "Broker probe", what: "x", repo: "example/tracker", workflow: "broker-probe.yml" }, ...(last ? { state: "ok", last: { url: "https://github.com/x", ...last } } : { state: "absent" }) }] });
    const el = line(newer!, probe({ at: "2026-10-26T01:20:00Z", conclusion: "failure" }));
    assert.match(text(el), / · broker failure 2h ago$/);
    assert.match(el.querySelectorAll<HTMLElement>(".age")[1]!.title, /^finished .*2026/);
    // Its usual state while tracker's BROKER_OUTAGE isn't apply: the job is skipped, not passed.
    assert.match(text(line(newer!, probe({ at: "2026-10-26T03:05:00Z", conclusion: "skipped" }))), / · broker skipped 15m ago$/);
    // Not yet read (a workflow with no runs): said, not left out.
    assert.match(text(line(newer!, probe(undefined))), / · broker no pass$/);
  });

  const agent = (name: string, more: Partial<ActiveAgent>): ActiveAgent => ({
    name, location: "remote", status: "run", source: "actions", lane: "harness", stale: false,
    ...(more.location === "local" ? {} : { runUrl: `https://github.com/example/runs/actions/runs/${name}` }), ...more,
  });

  it("groups running agents by pool and links the first four, counting the rest", () => {
    const home = homeSkeleton(noHooks);
    const agents = [
      agent("a1", { engine: "claude" }),
      agent("a2", { engine: "openai" }),
      agent("a3", { engine: "claude" }),
      agent("a4", {}),
      agent("a5", { location: "local", itemUrl: "https://github.com/example/work/issues/5", itemRef: "example/work#5" }),
      agent("a6", { engine: "claude" }),
      agent("gone", { engine: "claude", stale: true }),
    ];
    fillSummary(home, { ...state, agents: { ...state.agents, executionKnown: true, unconfirmed: 0, agents } }, undefined, NOW);
    const line = home.slots.summary.querySelector("li")!;
    assert.equal(text(line), "Agents 6 running (claude 3, openai 1, Actions 1, local 1) · a1 · a2 · a3 · a4 · +2");
    assert.deepEqual([...line.querySelectorAll("a:not(.sum-jump)")].map((a) => a.getAttribute("href")), ["a1", "a2", "a3", "a4"].map((n) => `https://github.com/example/runs/actions/runs/${n}`));
  });

  it("shows a link whose URL isn't https as plain text", () => {
    const home = homeSkeleton(noHooks);
    const evil = "javascript:alert(1)";
    const agents = [agent("a1", { engine: "claude", runUrl: evil, itemUrl: evil })];
    const queued = { ...run(9, "queued", "Agent: triage example/work#9"), url: evil };
    fillSummary(home, { ...state, agents: { ...state.agents, executionKnown: true, unconfirmed: 0, agents }, runs: { ...state.runs!, runs: [queued] } }, undefined, NOW);
    const [agentsLine, queuedLine] = home.slots.summary.querySelectorAll("li");
    assert.equal(text(agentsLine), "Agents 1 running (claude 1) · a1");
    assert.equal(text(queuedLine), "Queued 1 run · Agent: triage example/work#9");
    assert.equal(home.slots.summary.querySelectorAll("a:not(.sum-jump)").length, 0);
    assert.ok(![...home.slots.summary.querySelectorAll("a")].some((a) => a.getAttribute("href")?.startsWith("javascript:")));
  });

  describe("says what the pass decided on a pool: held and why, else its headroom under the published limit", () => {
    // used, the pass's limit_percent, hold, reason; the words after the projection, and whether the line is hot
    const cases: [string, number, number | undefined, boolean, string | undefined, string, boolean][] = [
      ["under its limit", 18, 53, false, undefined, " · not held: 35 points of headroom", false],
      // The pass's call, not one made here: past the limit and not held says so, without "over pace".
      ["past its limit, not held", 60, 52, false, undefined, " · not held: -8 points of headroom", false],
      ["no limit published", 18, undefined, false, undefined, " · not held; limit not published", false],
      ["held on a window", 80, 33, true, "window", " · held (window): no new runs; resume time not published; running runs continue", true],
    ];
    for (const [name, used, limit, hold, reason, want, hot] of cases) it(name, () => {
      const home = homeSkeleton(noHooks);
      const claude: UsagePool = { hold, reading: { ...usage.pools!.claude!.reading!, usedPercent: used } };
      if (limit !== undefined) claude.limitPercent = limit;
      if (reason !== undefined) claude.reason = reason;
      fillSummary(home, pageState({ active: { warnings: [], at: NOW, usage: { state: "ok", usage: { ...usage, pools: { claude } } } }, runs }, NOW), undefined, NOW);
      const line = [...home.slots.summary.querySelectorAll("li")].find((l) => text(l).startsWith("Claude"))!;
      assert.equal(text(line).replace(/^.* at reset/, ""), want);
      assert.equal(line.classList.contains("hot"), hot);
    });
  });
});
