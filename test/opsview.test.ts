// Ops detail: empty sections, fixture rows, literal titles and replacement renders.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseItem } from "../src/github/board.ts";
import { findHeartbeat, type RawComment } from "../src/github/heartbeat.ts";
import { agentRuns, botEvents, devspaceOf, type Ops, parseJobs, type RawEvent, type RawJob, type RawRun } from "../src/github/ops.ts";
import { opsDetail } from "../src/github/opsview.ts";
import { fixture, installDom, rawItems } from "./helpers.ts";

installDom();
const NOW = Date.parse("2026-09-28T15:12:05Z");
const EVIL = "<img src=x onerror=alert(1)><script>alert(2)</script>\u202eRTL\u202c\u2066isolate\u2069\u0001";

function populated(): Ops {
  const runs = fixture<{ workflow_runs: RawRun[] }>("ops-runs.json").workflow_runs;
  const jobs = fixture<Record<string, RawJob[]>>("ops-jobs.json");
  const devspaces = runs.map((run) => {
    const d = devspaceOf(run, parseJobs(jobs[String(run.id)] ?? []));
    assert.ok(d);
    return d;
  });
  return {
    at: NOW, warnings: [], devspaces: { devspaces, partial: false },
    agents: { deployed: true, runs: agentRuns(runs, 3) },
    local: findHeartbeat(fixture<RawComment[]>("heartbeat-comments.json")) ?? null,
    work: [parseItem(rawItems()[0]!)],
    events: botEvents(fixture<RawEvent[]>("ops-events.json")),
  };
}

describe("opsDetail", () => {
  it("shows loading, then empty sections for a successful empty read", () => {
    assert.equal(opsDetail(undefined, NOW).textContent, "Loading…");
    const el = opsDetail({ at: NOW, warnings: [], devspaces: { devspaces: [], partial: false }, local: null, agents: { deployed: true, runs: [] }, work: [], events: [] }, NOW);
    for (const message of ["No devspace is running.", "No heartbeat published yet.", "No agent runs yet.", "Nothing is In Progress on the board.", "No recent public activity."]) {
      assert.ok(el.textContent?.includes(message), message);
    }
    assert.equal(el.querySelectorAll(".ds-row, .lw, .past, .work, .ev").length, 0);
  });

  it("shows fixture devspaces, local workers, runs, work and activity with links", () => {
    const ops = populated();
    const el = opsDetail(ops, NOW);
    assert.equal(el.querySelectorAll(".ds-row").length, 1);
    assert.equal(el.querySelector(".ds-row strong")?.textContent, "selinux-3327");
    assert.equal(el.querySelector(".host")?.textContent, "cgwalters-devspace-36439387350");
    assert.equal(el.querySelectorAll("details.history .past").length, 3);
    assert.deepEqual([...el.querySelectorAll(".lw strong")].map((n) => n.textContent), ["ops-v2", "bootc-2482"]);
    assert.equal(el.querySelector(".lw a")?.getAttribute("href"), "https://github.com/cgwalters-forge/review/pull/16");
    assert.equal(el.querySelectorAll(".ops-sec > .past-list > .past").length, ops.agents?.deployed ? ops.agents.runs.length : 0);
    assert.equal(el.querySelector(".work .title")?.textContent, ops.work?.[0]?.title);
    assert.equal(el.querySelector(".work .title a")?.getAttribute("href"), ops.work?.[0]?.url);
    assert.equal(el.querySelector(".ev .what a")?.getAttribute("href"), "https://github.com/cgwalters-bot/homegit/pull/31");
  });

  it("preserves untrusted work, run and event titles as inert literal text", () => {
    const ops = populated();
    ops.work = ops.work!.map((item) => ({ ...item, title: EVIL }));
    assert.ok(ops.agents?.deployed);
    ops.agents.runs = ops.agents.runs.map((run) => ({ ...run, title: EVIL }));
    ops.events = ops.events!.map((event) => ({ ...event, title: EVIL }));
    const el = opsDetail(ops, NOW);
    assert.equal(el.querySelector(".work .title")?.textContent, EVIL);
    assert.equal(el.querySelector(".ops-sec > .past-list > .past .name a")?.textContent, EVIL);
    assert.equal(el.querySelector(".etitle")?.textContent, ` ${EVIL}`);
    assert.equal(el.querySelectorAll("script, img, iframe, style").length, 0, el.outerHTML);
    for (const node of el.querySelectorAll("*")) {
      for (const attr of node.getAttributeNames()) assert.ok(!/^on/i.test(attr), attr);
    }
  });

  it("renders equivalent output on fresh replacement DOM", () => {
    const ops = populated();
    const first = opsDetail(ops, NOW);
    document.body.replaceChildren(first);
    const replacement = opsDetail(ops, NOW);
    document.body.replaceChildren(replacement);
    assert.notEqual(replacement, first);
    assert.equal(first.isConnected, false);
    assert.equal(document.body.firstElementChild, replacement);
    assert.equal(replacement.outerHTML, first.outerHTML);
  });
});
