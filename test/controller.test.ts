// The controller panel: its config, the reads, and the rendering.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { CONTROLLER, type ControllerConfig, type ControllerData, loadController, parseControllerConfig, sessionPresent } from "../src/github/controller.ts";
import type { Heartbeat } from "../src/github/heartbeat.ts";
import { opsDetail, tickOps } from "../src/github/opsview.ts";
import { installDom } from "./helpers.ts";

installDom();
const NOW = Date.parse("2026-10-14T19:20:00Z");
const EVIL = "<img src=x onerror=alert(1)>";
const REPO = "example-org/tracker";

const cfg: ControllerConfig = parseControllerConfig({
  hosted: [
    { label: "Poll", what: "fixes", repo: REPO, workflow: "poll.yml" },
    { label: "Usage", what: "publishes usage", repo: REPO, workflow: "usage.yml" },
    { label: "Coordinator", what: "epics", repo: REPO, workflow: "coordinator.yml" },
    { label: "Dispatch", what: "agent runs", repo: REPO, workflow: "dispatch.yml", read: "in-flight" },
  ],
});

describe("parseControllerConfig", () => {
  it("accepts the shipped controller.json", () => {
    const shipped = parseControllerConfig(CONTROLLER);
    assert.ok(shipped.hosted.length > 0);
    assert.ok(shipped.hosted.some((p) => p.read === "in-flight"));
    assert.throws(() => parseControllerConfig({ hosted: [null] }), /object/);
  });

  it("refuses an entry that isn't plain names, before it becomes an API path", () => {
    const one = (p: Record<string, unknown>) => () => parseControllerConfig({ hosted: [{ label: "x", what: "y", repo: REPO, workflow: "a.yml", ...p }] });
    assert.throws(one({ repo: "../../user" }), /OWNER\/NAME/);
    assert.throws(one({ workflow: "../x.yml" }), /workflow/);
    assert.throws(one({ workflow: "a.yml?per_page=1" }), /workflow/);
    for (const read of ["logs", "scheduler"]) assert.throws(one({ read }), /read/);
    assert.throws(one({ label: "" }), /label/);
    assert.throws(() => parseControllerConfig({}), /list/);
    assert.throws(() => parseControllerConfig({ hosted: Array.from({ length: 13 }, () => ({ label: "x", what: "y", repo: REPO, workflow: "a.yml" })) }), /at most/);
    assert.deepEqual(one({})().hosted[0], { label: "x", what: "y", repo: REPO, workflow: "a.yml" });
    for (const staleAfterMinutes of [0, -1, 1.5, 10081, "60", null, Infinity]) assert.throws(one({ staleAfterMinutes }), /staleAfterMinutes/);
    for (const staleAfterMinutes of [1, 60, 10080]) assert.equal(one({ staleAfterMinutes })().hosted[0]?.staleAfterMinutes, staleAfterMinutes);
  });
});

const run = (id: number, status: string, conclusion: string | null, created: string, title = "poll") => ({
  id, html_url: `https://github.com/${REPO}/actions/runs/${id}`, display_title: title, status, conclusion, created_at: created, run_started_at: created, updated_at: created,
});

function script() {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(url);
    const u = new URL(url);
    const p = u.pathname;
    if (p === `/repos/${REPO}/actions/workflows/poll.yml/runs`) return json({ workflow_runs: [run(2, "in_progress", null, "2026-10-14T19:14:00Z"), run(1, "completed", "failure", "2026-10-14T19:10:00Z")] });
    if (p === `/repos/${REPO}/actions/workflows/usage.yml/runs`) return json({ workflow_runs: [run(5, "completed", "success", "2026-10-14T19:07:00Z", "usage")] });
    if (p === `/repos/${REPO}/actions/workflows/coordinator.yml/runs`) return json({ message: "Not Found" }, 404);
    if (p === `/repos/${REPO}`) return json({ full_name: REPO });
    if (p.startsWith("/repos/hidden-org/")) return json({ message: "Not Found" }, 404);
    if (p === `/repos/${REPO}/actions/workflows/dispatch.yml/runs`) {
      // An old run still going, past the newest runs read unfiltered.
      const old = run(3, "in_progress", null, "2026-10-13T09:00:00Z", "implement example-org/c#9");
      const st = u.searchParams.get("status");
      if (st === "in_progress") return json({ workflow_runs: [run(8, "in_progress", null, "2026-10-14T19:05:00Z", `implement ${EVIL}#64`), old] });
      if (st === "queued") return json({ workflow_runs: [run(7, "queued", null, "2026-10-14T19:04:00Z", "triage example-org/a#2")] });
      if (st === "pending") return json({ workflow_runs: [run(4, "pending", null, "2026-10-14T19:01:00Z", "fix example-org/b#2")] });
      if (st === "waiting" || st === "requested") return json({ workflow_runs: [] });
      return json({ workflow_runs: [run(8, "in_progress", null, "2026-10-14T19:05:00Z", `implement ${EVIL}#64`), run(7, "queued", null, "2026-10-14T19:04:00Z", "triage example-org/a#2"), run(6, "completed", "success", "2026-10-14T18:00:00Z", "fix example-org/b#1")] });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { fetchImpl, calls };
}

describe("loadController", () => {
  it("derives monitored workflow liveness from bounded run lists alone", async () => {
    const calls: string[] = [];
    const config = { hosted: cfg.hosted.filter((p) => p.label === "Poll" || p.label === "Coordinator").map((p) => ({ ...p, staleAfterMinutes: 60 })) };
    const gh = new GitHub(async () => "t", async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ workflow_runs: [
        run(3, "queued", null, "2026-10-14T19:19:00Z"),
        run(2, "in_progress", null, "2026-10-14T19:14:00Z"),
        run(1, "completed", "failure", "2026-10-14T18:00:00Z"),
      ] }), { status: 200 });
    });
    const data = await loadController(gh, config);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((url) => url.endsWith("/runs?per_page=30")));
    for (const p of data.pieces) {
      assert.equal(p.last?.url, `https://github.com/${REPO}/actions/runs/1`);
      assert.equal(p.last?.conclusion, "failure");
      assert.equal(p.running?.status, "queued");
    }
    const panel = opsDetail({ at: NOW, warnings: [], controller: data }, NOW);
    assert.equal(panel.querySelectorAll(".ctl-pass-age.warn").length, 2);
    assert.match(panel.querySelector(".ctl-list")?.textContent ?? "", /last pass 1h ago · stale/);
  });

  it("reads each piece's latest run and the runs in flight, and no job", async () => {
    const { fetchImpl, calls } = script();
    const data = await loadController(new GitHub(async () => "t", fetchImpl), cfg);
    const [poll, usage, coord, dispatch] = data.pieces;
    assert.equal(poll?.state, "ok");
    assert.deepEqual(poll?.last, { url: `https://github.com/${REPO}/actions/runs/1`, at: "2026-10-14T19:10:00Z", conclusion: "failure" });
    assert.equal(poll?.running?.url, `https://github.com/${REPO}/actions/runs/2`);
    assert.deepEqual(usage?.last, { url: `https://github.com/${REPO}/actions/runs/5`, at: "2026-10-14T19:07:00Z", conclusion: "success" });
    assert.equal(usage?.running, undefined);
    assert.equal(coord?.state, "absent");
    assert.deepEqual(dispatch?.inFlight?.map((r) => [r.title, r.status]), [[`implement ${EVIL}#64`, "in_progress"], ["triage example-org/a#2", "queued"], ["fix example-org/b#2", "pending"], ["implement example-org/c#9", "in_progress"]]);
    assert.equal(calls.filter((c) => c.includes("/jobs") || c.includes("/annotations")).length, 0);
  });

  it("renders a cached copy without throwing: pieces not cached are loading", async () => {
    const { fetchImpl } = script();
    const gh = new GitHub(async () => "t", fetchImpl);
    await loadController(gh, cfg);
    const cached = await loadController(gh.cacheOnly(), cfg);
    const [poll, , coord] = cached.pieces;
    assert.equal(poll?.last?.conclusion, "failure");
    // A 404 isn't cached.
    assert.equal(coord?.state, "uncached");
  });

  it("says unread, not \"not built\", when the repository itself can't be seen", async () => {
    const hidden = parseControllerConfig({ hosted: [{ label: "Hidden", what: "x", repo: "hidden-org/tracker", workflow: "poll.yml" }] });
    const [piece] = (await loadController(new GitHub(async () => "t", script().fetchImpl), hidden)).pieces;
    assert.equal(piece?.state, "error");
  });

  it("refuses a bad config, for loadOps to warn about", async () => {
    await assert.rejects(loadController(new GitHub(async () => "t", script().fetchImpl), { hosted: [{ label: "x", what: "y", repo: "../x", workflow: "a.yml" }] }), /OWNER\/NAME/);
  });

  it("marks one piece unread and leaves the others", async () => {
    const { fetchImpl } = script();
    const broken = parseControllerConfig({ hosted: [...cfg.hosted, { label: "Gone", what: "x", repo: REPO, workflow: "boom.yml" }] });
    const data = await loadController(new GitHub(async () => "t", fetchImpl), broken);
    assert.equal(data.pieces.at(-1)?.state, "error");
    assert.equal(data.pieces[0]?.state, "ok");
  });
});

describe("the controller panel", () => {
  it("ages passes independently of heartbeat, preserves failures, and updates stale warnings on tick", () => {
    const piece = { ...cfg.hosted[0]!, staleAfterMinutes: 10 };
    const last = { url: `https://github.com/${REPO}/actions/runs/1`, at: "2026-10-14T19:10:00Z", conclusion: "failure" };
    for (const local of [undefined, null, hb("2026-10-14T19:20:00Z"), hb("2026-10-14T17:00:00Z")]) {
      const el = opsDetail({ at: NOW, warnings: [], ...(local !== undefined ? { local } : {}), controller: { pieces: [{ piece, state: "ok", last }] } }, NOW);
      const pass = el.querySelector(".ctl-pass-age")!;
      assert.equal(pass.textContent, "last pass 10m ago");
      assert.equal(pass.parentElement?.getAttribute("href"), last.url);
      assert.equal(pass.classList.contains("warn"), false);
      assert.equal(el.querySelector(".ctl .st")?.textContent, "failure");
      tickOps(el, NOW + 60_000);
      assert.equal(pass.textContent, "last pass 11m ago · stale");
      assert.equal(pass.classList.contains("warn"), true);
    }
  });

  it("keeps freshness opt-in and does not invent a completed pass", () => {
    for (const at of ["bad", "2026-10-15T00:00:00Z"]) {
      const el = opsDetail({ at: NOW, warnings: [], controller: { pieces: [{ piece: { ...cfg.hosted[0]!, staleAfterMinutes: 60 }, state: "ok", last: { at, url: "https://github.com/example-org/tracker/actions/runs/1" } }] } }, NOW);
      assert.equal(el.querySelector(".ctl-pass-age.warn")?.textContent, "last pass time unknown · stale");
    }
    const el = opsDetail({ at: NOW, warnings: [], controller: { pieces: [
      { piece: cfg.hosted[0]!, state: "ok", last: { at: "2026-10-14T00:00:00Z", url: "https://github.com/example-org/tracker/actions/runs/1" } },
      { piece: { ...cfg.hosted[0]!, staleAfterMinutes: 60 }, state: "ok", running: { at: "2026-10-14T19:19:00Z", url: "https://github.com/example-org/tracker/actions/runs/2", status: "queued" } },
    ] } }, NOW);
    assert.equal(el.querySelector(".ctl-pass-age"), null);
    assert.match(el.querySelectorAll(".ctl")[1]?.textContent ?? "", /No completed pass.*queued now/);
  });

  const hb = (updatedAt: string, loopState = "sleeping"): Heartbeat => ({ updatedAt, session: "abcdef0123", loopState, workers: [], skipped: 0, commentUrl: "https://github.com/example-org/tracker/issues/176#issuecomment-1" });

  async function render(local: Heartbeat | null | undefined): Promise<HTMLElement> {
    const controller: ControllerData = await loadController(new GitHub(async () => "t", script().fetchImpl), cfg);
    return opsDetail({ at: NOW, warnings: [], controller, ...(local !== undefined ? { local } : {}) }, NOW);
  }

  it("lists each hosted piece with its run and the runs in flight", async () => {
    const el = await render(null);
    const rows = [...el.querySelectorAll(".ctl-list > .ctl")];
    assert.deepEqual(rows.map((r) => r.querySelector("strong")?.textContent), ["Poll", "Usage", "Coordinator", "Dispatch"]);
    assert.equal(rows[0]?.querySelector(".st")?.textContent, "failure");
    assert.equal(rows[0]?.querySelector(".now a")?.getAttribute("href"), `https://github.com/${REPO}/actions/runs/2`);
    assert.equal(rows[2]?.querySelector(".st")?.textContent, "not built");
    const flight = [...(rows[3]?.querySelectorAll(".flight a") ?? [])];
    assert.deepEqual(flight.map((a) => [a.textContent, a.getAttribute("href")]), [[`implement ${EVIL}#64`, `https://github.com/${REPO}/actions/runs/8`], ["triage example-org/a#2", `https://github.com/${REPO}/actions/runs/7`], ["fix example-org/b#2", `https://github.com/${REPO}/actions/runs/4`], ["implement example-org/c#9", `https://github.com/${REPO}/actions/runs/3`]]);
    assert.equal(el.querySelectorAll("img, script").length, 0);
  });

  it("says what it couldn't read, row by row", () => {
    const [poll, usage, coord] = cfg.hosted;
    const last = { url: `https://github.com/${REPO}/actions/runs/1`, at: "2026-10-14T19:11:32Z", conclusion: "success" };
    const controller: ControllerData = { pieces: [
      { piece: poll!, state: "error", error: "HTTP 500" },
      { piece: usage!, state: "ok", last },
      { piece: coord!, state: "uncached" },
      { piece: coord!, state: "absent" },
    ] };
    const rows = [...opsDetail({ at: NOW, warnings: [], controller, local: null }, NOW).querySelectorAll(".ctl-list > .ctl")];
    assert.deepEqual(rows.map((r) => r.querySelector(".st")?.textContent), ["unread", "ok", "…", "not built"]);
    assert.equal(rows[1]?.querySelector(".when a")?.getAttribute("href"), last.url);
    assert.equal(rows[1]?.querySelector(".detail"), null);
  });

  it("shows the interactive session only while its heartbeat is fresh", async () => {
    const fresh = hb("2026-10-14T19:15:00Z");
    assert.ok(sessionPresent(fresh, NOW));
    const present = await render(fresh);
    assert.match(present.querySelector(".ctl-session")?.textContent ?? "", /present Controller chat · heartbeat 5m ago/);
    // Asleep until a wake time it gave: still present, as Local agents has it.
    assert.ok(sessionPresent({ ...hb("2026-10-14T17:00:00Z"), nextWakeAt: "2026-10-14T19:30:00Z" }, NOW));
    const unread = await render(undefined);
    assert.match(unread.querySelector(".ctl-session")?.textContent ?? "", /unknown/);
    assert.equal(unread.querySelector(".ctl-session.none"), null);
    for (const gone of [null, hb("2026-10-14T17:00:00Z"), hb("2026-10-14T19:15:00Z", "stopped")]) {
      assert.equal(sessionPresent(gone, NOW), false);
      const el = await render(gone);
      assert.match(el.querySelector(".ctl-session.none")?.textContent ?? "", /No interactive session: new work starts only from the board scheduler\./);
    }
  });
});
