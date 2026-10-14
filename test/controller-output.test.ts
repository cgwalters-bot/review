// Current tracker-main scheduler/census formats and the opt-in output reader.
import assert from "node:assert/strict";
import { it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { CONTROLLER, loadController, parseControllerConfig, schedulerPass, MAX_CONTROLLER_OUTPUT, sessionPresent } from "../src/github/controller.ts";
import { opsDetail } from "../src/github/opsview.ts";
import { fillOps, homeSkeleton } from "../src/github/homeview.ts";
import { installDom } from "./helpers.ts";

installDom();
const repo = "example-org/tracker";
const header = "3 open sub-issue(s) of 2 live epic(s), taken by their epic's Priority, then their own (P0 first, unset last), then oldest first; 1 of 4 run(s) in flight; at most 1 triage run(s) a pass; items of 2 followed repositories only";
const lines = [header, `${repo}#1 (epic ${repo}#9) dispatch: plan 7`, `${repo}#2 (epic ${repo}#9) triage: no plan`, `${repo}#3 (epic ${repo}#10) skip: cap reached`];
const census = `- ${repo}#9: live; 2 sub-issue(s) (Ready 2); 1 operator comment(s); fingerprint \`abc\``;

it("reads current scheduler candidates with their epic, skips and census", () => {
  for (const preview of [false, true]) {
    const output = lines.map(l => `${preview ? "[dry-run] " : ""}${l}`);
    const parsed = schedulerPass([...output, "### Epics", census].map(l => `2026-10-14T19:11:30Z ${l}`).join("\n"));
    assert.deepEqual(parsed, { mode: preview ? "preview" : "acting", starts: 2, candidates: 3, liveEpics: 2, items: output.slice(1), census: [census] });
  }
});

it("reads the current idle line and the last pass", () => {
  assert.deepEqual(schedulerPass("[dry-run] no live epics; nothing started"), { mode: "preview", starts: 0, candidates: 0, liveEpics: 0, items: [] });
  assert.equal(schedulerPass(`${lines.join("\n")}\n[ dry-run ] unknown\n[dry-run] no live epics; nothing started`).liveEpics, 0);
  assert.deepEqual(schedulerPass(`${lines.join("\n")}\n${census}\n[dry-run] no live epics; nothing started`).census, undefined);
});

it("does not invent counts from old, partial, unsafe or changed output", () => {
  for (const output of ["[dry-run] 3 ready item(s)", "no live epics; 1 epic(s) not read; nothing started", "[dry-run] new format", "schedule: failed", header.replace("3 open", "99999999999999999 open"), `${header}\n[dry-run] ${repo}#1 (epic ${repo}#9) dispatch: plan 7`]) {
    const pass = schedulerPass(output);
    assert.equal(pass.mode, "unknown");
    assert.equal(pass.starts, undefined);
    assert.ok(pass.raw);
  }
  assert.equal(schedulerPass("").starts, undefined);
  assert.match(schedulerPass("x".repeat(MAX_CONTROLLER_OUTPUT + 1)).raw!, /exceeds/);
});

it("keeps errors separate from starts", () => {
  const pass = schedulerPass(`${header}\n${repo}#1 (epic ${repo}#9) dispatch error: HTTP 500`);
  assert.equal(pass.starts, 0);
  assert.equal(pass.items?.length, 1);
});

it("checks shipped config and refuses paths that could redirect API reads", () => {
  assert.ok(parseControllerConfig(CONTROLLER).hosted.length);
  const piece = { label: "Board", what: "schedules", repo, workflow: "poll.yml", job: "board", read: "scheduler" };
  for (const override of [{ repo: "../../user" }, { workflow: "../poll.yml" }, { read: "logs" }]) assert.throws(() => parseControllerConfig({ hosted: [{ ...piece, ...override }] }));
});

it("loads the board run without requesting annotations tracker never publishes", async () => {
  const calls: string[] = [];
  const cfg = { hosted: [{ label: "Board", what: "schedules", repo, workflow: "poll.yml", job: "board", read: "scheduler" }] };
  const gh = new GitHub(async () => "token", async url => {
    calls.push(url);
    const body = url.includes("/jobs?") ? { jobs: [{ id: 12, name: "board", status: "completed", conclusion: "success", completed_at: "2026-10-14T19:11:00Z" }] } : { workflow_runs: [{ id: 1, html_url: `https://github.com/${repo}/actions/runs/1`, status: "completed", conclusion: "success", created_at: "2026-10-14T19:10:00Z" }] };
    return new Response(JSON.stringify(body));
  });
  const data = await loadController(gh, cfg);
  assert.deepEqual(data.pieces[0]?.scheduler, { mode: "unknown" });
  assert.equal(calls.length, 2);
  await loadController(gh.cacheOnly(), cfg);
  assert.equal(calls.length, 2);
  const panel = opsDetail({ at: Date.now(), warnings: [], controller: data, local: null }, Date.now());
  assert.match(panel.textContent!, /unknown/);
  assert.equal(panel.querySelector("details")?.hasAttribute("open"), false);
  const input = panel.querySelector("textarea")!;
  assert.equal(input.hasAttribute("maxlength"), false, "must not silently truncate pasted output");
  input.value = `[dry-run] ${header}\n[dry-run] ${repo}#1 (epic ${repo}#9) triage: <img src=x onerror=alert(1)>\n${census}`;
  input.dispatchEvent(new window.Event("input"));
  assert.match(panel.textContent!, /2 live epics · 3 candidates · would start 1/);
  assert.match(panel.textContent!, /fingerprint/);
  assert.equal(panel.querySelector("img"), null);
  input.value = "[dry-run] <script>new wording</script>";
  input.dispatchEvent(new window.Event("input"));
  assert.match(panel.textContent!, /unknown.*new wording/s);
  assert.equal(panel.querySelector("script"), null);
  input.value = `${header}\n${"\n".repeat(MAX_CONTROLLER_OUTPUT)}${lines[1]}`;
  input.dispatchEvent(new window.Event("input"));
  assert.match(panel.textContent!, /unknown.*Output exceeds/s);
  assert.doesNotMatch(panel.textContent!, /started 0/);
});

it("keeps transient pasted evidence across same-run refreshes, not new runs or navigation", () => {
  const home = homeSkeleton({ open: () => true, toggled: () => {}, opsToggled: () => {}, themesToggled: () => {} });
  const piece = parseControllerConfig({ hosted: [{ label: "Board", what: "schedules", repo, workflow: "poll.yml", job: "board", read: "scheduler" }] }).hosted[0]!;
  const data = { at: Date.now(), warnings: [], controller: { pieces: [{ piece, state: "ok" as const, last: { url: `https://github.com/${repo}/actions/runs/1/job/12`, at: "2026-10-14T19:11:00Z", conclusion: "success" } }] } };
  let panel = fillOps(home, data, data.at);
  const input = panel.querySelector("textarea")!;
  const disclosure = panel.querySelector<HTMLDetailsElement>(".ctl-output details")!;
  disclosure.open = true;
  input.value = lines.join("\n");
  input.dispatchEvent(new window.Event("input"));
  panel = fillOps(home, data, data.at + 60_000);
  assert.equal(panel.querySelector("textarea"), input);
  assert.equal(disclosure.open, true);
  assert.match(panel.textContent!, /started 2/);
  data.controller.pieces[0]!.last.at = "2026-10-14T19:21:00Z";
  panel = fillOps(home, data, data.at + 120_000);
  assert.equal(panel.querySelector("textarea")!.value, "");
  assert.match(panel.textContent!, /unknown/);
  home.slots.ops.replaceChildren();
  panel = fillOps(home, data, data.at);
  assert.equal(panel.querySelector("textarea")!.value, "");
});

it("does not claim an absent or stopped session is present", () => {
  assert.equal(sessionPresent(null, Date.now()), false);
  assert.equal(sessionPresent({ updatedAt: new Date().toISOString(), session: "abc", loopState: "stopped", workers: [], skipped: 0 }, Date.now()), false);
});
