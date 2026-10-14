import assert from "node:assert/strict";
import { it } from "node:test";
import fixture from "./fixtures/operator-action.json" with { type: "json" };
import { GitHub } from "../src/github/api.ts";
import { ACTION_CONFIG, actionConfig, comments, execute, loadProposals, marker, prepare, proposals, validateProposal, type Action, type Comment, type Offered, type Proposal } from "../src/github/actions.ts";
import { matchesActionSchema } from "../src/github/actionschema.ts";
import { actionsPanel } from "../src/github/actionsview.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const c = { operator: "operator", planner: "planner", tracker: "example/tracker", repositories: ["example/tasks", "example/tracker"], project: "PVT_example" };
const stamp = "2026-10-14T12:00:00Z";
const base = { repo: "example/tasks", number: 1, updatedAt: stamp };
const head = "a".repeat(40);

function offer(actions: Action[] = fixture.actions as Action[]): Offered {
  const p = { ...fixture, actions } as Proposal;
  const comment: Comment = { id: "IC_proposal", databaseId: 10, body: `\`\`\`agent-board-action\n${JSON.stringify(p)}\n\`\`\``, updatedAt: stamp, author: { login: c.planner }, editor: null, lastEditedAt: null };
  return { issue: 9, comment, proposal: p };
}

function mock(o = offer()) {
  const all = [o.comment];
  const calls: { method: string; path: string; body: any }[] = [];
  let viewer = c.operator;
  let failPath = "";
  let more = false;
  let closed = false;
  let issueOverride: Record<string, unknown> = {};
  let prOverride: Record<string, unknown> = {};
  let projectOverride: Record<string, unknown> = {};
  let intercept: (() => void) | undefined;
  const gh = new GitHub(async () => "viewer-secret", async (url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer viewer-secret");
    const path = url.replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path, body }); intercept?.();
    if (path === failPath) return Response.json({ message: "denied\n/promote" }, { status: 403 });
    if (path === "/user") return Response.json({ login: viewer });
    if (path === "/graphql") {
      if (body.query.includes("comments(first")) return Response.json({ data: { repository: { issue: { state: closed ? "CLOSED" : "OPEN", comments: { nodes: all, pageInfo: { hasNextPage: more } } } } } });
      if (body.query.includes("updateProject")) return Response.json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item" } } } });
      return Response.json({ data: { node: { projectItems: { nodes: [{ id: "item", project: { id: c.project }, fieldValueByName: { name: "P2" } }], pageInfo: { hasNextPage: false }, ...projectOverride } }, project: { fields: { nodes: [{ id: "field", name: "Priority", options: [{ id: "option", name: "P1" }] }], pageInfo: { hasNextPage: false } } } } });
    }
    if (path.includes("?state=open")) return Response.json([{ number: 9 }]);
    if (method === "POST" && path === `/repos/${c.tracker}/issues/9/comments`) {
      all.push({ id: "IC_receipt", databaseId: 20, body: body.body, updatedAt: stamp, author: { login: c.operator }, editor: null, lastEditedAt: null });
      return Response.json({ id: 20 });
    }
    if (method === "GET" && /\/pulls\/\d+$/.test(path)) return Response.json({ state: "open", merged: false, draft: false, head: { sha: head }, ...prOverride });
    if (method === "GET" && /\/issues\/\d+$/.test(path)) return Response.json({ id: 101, node_id: "I_target", title: "<script>target</script>", state: "open", updated_at: stamp, labels: [], ...issueOverride });
    if (method === "PUT" && path.endsWith("/merge")) return Response.json({ merged: true });
    return Response.json({});
  });
  return { gh, all, calls, setViewer: (v: string) => { viewer = v; }, fail: (v: string) => { failPath = v; }, more: () => { more = true; }, close: () => { closed = true; }, issue: (v: Record<string, unknown>) => { issueOverride = v; }, pr: (v: Record<string, unknown>) => { prOverride = v; }, project: (v: Record<string, unknown>) => { projectOverride = v; }, intercept: (v: () => void) => { intercept = v; } };
}

it("defaults off and requires repository-owned writer and target configuration", () => {
  assert.equal(ACTION_CONFIG, undefined);
  assert.deepEqual(actionConfig(c), c);
  for (const value of [{ ...c, operator: "" }, { ...c, operator: undefined }, { ...c, planner: undefined }, { ...c, tracker: undefined }, { ...c, repositories: ["../tasks"] }, { ...c, tracker: "https://evil" }, { ...c, project: "any" }]) assert.throws(() => actionConfig(value));
});

it("validates the vendored fixture, refuses malformed, oversized and unbounded actions", () => {
  assert.ok(matchesActionSchema(fixture));
  assert.deepEqual(validateProposal(fixture, c), fixture);
  const invalid = [null, { ...fixture, extra: true }, { ...fixture, title: "two\nlines" }, { ...fixture, actions: [] }, { ...fixture, actions: Array(21).fill(fixture.actions[0]) },
    ...[{ ...base, type: "request", path: "/evil" }, { ...base, type: "close_issue", reason: "\n/promote" }, { ...base, type: "close_issue", reason: " ", extra: true },
      { ...base, type: "add_label", label: "x", repo: "outside/tasks" }, { ...base, type: "add_label", label: "x", number: 0 }, { ...base, type: "approve_pr", head: "wrong" },
      { ...base, type: "remove_label", label: "." }, { ...base, type: "remove_label", label: ".." }, { ...base, type: "add_label", label: "." },
      { ...base, type: "move_sub_issue", parent: { ...base, number: 2 }, previousParent: "outside/tasks#3" }].map((a) => ({ ...fixture, actions: [a] })),
    { ...fixture, actions: [fixture.actions[0], fixture.actions[0]] }];
  for (const p of invalid) assert.throws(() => validateProposal(p, c));
});

it("accepts only named writers with trusted last editors and exactly one unquoted block", () => {
  const o = offer();
  assert.equal(proposals([o.comment], 9, c).length, 1);
  for (const comment of [{ ...o.comment, author: null }, { ...o.comment, author: { login: "visitor" } }, { ...o.comment, lastEditedAt: stamp, editor: null }, { ...o.comment, lastEditedAt: stamp, editor: { login: "visitor" } }, { ...o.comment, body: o.comment.body.split("\n").map((s) => `> ${s}`).join("\n") }]) assert.deepEqual(proposals([comment], 9, c), []);
  assert.equal(proposals([{ ...o.comment, lastEditedAt: stamp, editor: { login: c.operator } }], 9, c).length, 1);
  assert.throws(() => proposals([{ ...o.comment, body: `${o.comment.body}\n${o.comment.body}` }], 9, c));
  const receipt = { ...o.comment, databaseId: 20, body: `${marker(o)}\nDone`, author: { login: c.operator } };
  assert.deepEqual(proposals([o.comment, receipt], 9, c), []);
  assert.equal(proposals([o.comment, { ...receipt, author: { login: "visitor" } }], 9, c).length, 1);
  assert.equal(proposals([o.comment, { ...receipt, lastEditedAt: stamp, editor: null }], 9, c).length, 1);
});

it("bounds discovery and refuses truncated or closed proposal issues", async () => {
  const m = mock();
  assert.equal((await loadProposals(m.gh, c)).offers.length, 1);
  assert.ok(m.calls.some((v) => v.path.includes("per_page=20")));
  m.more(); await assert.rejects(comments(m.gh, c, 9), /100 comments/);
  const closed = mock(); closed.close(); await assert.rejects(comments(closed.gh, c, 9), /closed/);
});

it("keeps valid offers when another issue has unreadable or invalid proposals", async () => {
  const o = offer(); const requests: number[] = [];
  const gh = new GitHub(async () => "token", async (url, init) => {
    if (url.includes("?state=open")) return Response.json([{ number: 8 }, { number: 9 }, { number: 10 }]);
    const issue = JSON.parse(init!.body as string).variables.issue as number; requests.push(issue);
    return Response.json({ data: { repository: { issue: { state: "OPEN", comments: { nodes: issue === 10 ? [{ ...o.comment, body: "```agent-board-action\ninvalid\n```" }] : [o.comment], pageInfo: { hasNextPage: issue === 8 } } } } } });
  });
  const result = await loadProposals(gh, c);
  assert.deepEqual(requests, [8, 9, 10]);
  assert.equal(result.offers.length, 1); assert.equal(result.offers[0]!.issue, 9);
  assert.equal(result.warnings.length, 2);
});

it("rejects a self-target or containing parent before reserving an execution", async () => {
  for (const action of [
    { ...base, repo: c.tracker, number: 9, type: "close_issue", reason: "Done" } as Action,
    { ...base, type: "add_sub_issue", parent: { repo: c.tracker, number: 9, updatedAt: stamp }, previousParent: null } as Action,
  ]) {
    const o = offer([action]); const m = mock(o);
    assert.throws(() => proposals([o.comment], 9, c), /containing/);
    await assert.rejects(execute(m.gh, c, o, () => {}), /containing/);
    assert.equal(m.calls.length, 0);
  }
});

it("prepares every action with its exact current state and typed mutation", async () => {
  const cases: { action: Action; issue?: Record<string, unknown>; expected: { method: string; path: string; body?: unknown } }[] = [
    { action: { ...base, type: "close_issue", reason: "Superseded" }, expected: { method: "PATCH", path: "/repos/example/tasks/issues/1", body: { state: "closed" } } },
    { action: { ...base, type: "reopen_issue" }, issue: { state: "closed" }, expected: { method: "PATCH", path: "/repos/example/tasks/issues/1", body: { state: "open" } } },
    { action: { ...base, type: "add_label", label: "needs review" }, expected: { method: "POST", path: "/repos/example/tasks/issues/1/labels", body: { labels: ["needs review"] } } },
    { action: { ...base, type: "remove_label", label: "a/b" }, issue: { labels: [{ name: "a/b" }] }, expected: { method: "DELETE", path: "/repos/example/tasks/issues/1/labels/a%2Fb" } },
    { action: { ...base, type: "approve_pr", head }, expected: { method: "POST", path: "/repos/example/tasks/pulls/1/reviews", body: { event: "APPROVE", commit_id: head } } },
    { action: { ...base, type: "merge_pr", head, method: "squash" }, expected: { method: "PUT", path: "/repos/example/tasks/pulls/1/merge", body: { sha: head, merge_method: "squash" } } },
    { action: { ...base, type: "add_sub_issue", parent: { ...base, number: 2 }, previousParent: null }, expected: { method: "POST", path: "/repos/example/tasks/issues/2/sub_issues", body: { sub_issue_id: 101, replace_parent: false } } },
    { action: { ...base, type: "move_sub_issue", parent: { ...base, number: 2 }, previousParent: "example/tasks#3" }, issue: { parent_issue_url: "https://api.github.com/repos/example/tasks/issues/3" }, expected: { method: "POST", path: "/repos/example/tasks/issues/2/sub_issues", body: { sub_issue_id: 101, replace_parent: true } } },
    { action: { ...base, type: "set_project_field", field: "Priority", from: "P2", value: "P1" }, expected: { method: "POST", path: "/graphql" } },
  ];
  for (const { action, issue, expected } of cases) {
    validateProposal({ ...fixture, actions: [action] }, c);
    const m = mock(); if (issue) m.issue(issue);
    const next = await prepare(m.gh, c, action);
    assert.match(next.state, /target/);
    await next.apply();
    const call = m.calls.at(-1)!;
    assert.equal(call.method, expected.method); assert.equal(call.path, expected.path);
    // Fetch normalizes dot segments, so check the path that would actually be requested.
    assert.equal(new URL(new Request(`https://api.github.com${call.path}`).url).pathname, expected.path);
    if (expected.body) assert.deepEqual(call.body, expected.body);
    if (action.type === "set_project_field") assert.deepEqual(call.body.variables, { project: c.project, item: "item", field: "field", option: "option" });
  }
});

it("refuses stale timestamps, states, labels, heads, parents and fields before mutation", async () => {
  const cases: { action: Action; issue?: Record<string, unknown>; pr?: Record<string, unknown>; project?: Record<string, unknown> }[] = [
    { action: fixture.actions[0] as Action, issue: { updated_at: "2026-10-14T13:00:00Z" } },
    { action: fixture.actions[0] as Action, issue: { state: "closed" } },
    { action: fixture.actions[0] as Action, issue: { pull_request: {} } },
    { action: { ...base, type: "add_label", label: "x" }, issue: { labels: [{ name: "x" }] } },
    { action: { ...base, type: "remove_label", label: "x" } },
    { action: { ...base, type: "remove_label", label: "." }, issue: { labels: [{ name: "." }, { name: "keep-me" }] } },
    { action: { ...base, type: "approve_pr", head }, pr: { head: { sha: "b".repeat(40) } } },
    { action: { ...base, type: "merge_pr", head, method: "merge" }, pr: { draft: true } },
    { action: { ...base, type: "add_sub_issue", parent: { ...base, number: 2 }, previousParent: null }, issue: { parent_issue_url: "https://api.github.com/repos/example/tasks/issues/3" } },
    { action: { ...base, type: "set_project_field", field: "Priority", from: "P0", value: "P1" } },
    { action: { ...base, type: "set_project_field", field: "Priority", from: "P2", value: "P1" }, project: { pageInfo: { hasNextPage: true } } },
  ];
  for (const { action, issue, pr, project } of cases) {
    const m = mock(); if (issue) m.issue(issue); if (pr) m.pr(pr); if (project) m.project(project);
    await assert.rejects(prepare(m.gh, c, action));
    assert.ok(m.calls.every((v) => v.method === "GET" || v.path === "/graphql" && !v.body.query.includes("mutation")));
  }
});

it("reserves before execution, rechecks targets, records results and refuses replay", async () => {
  const o = offer(); const m = mock(o); const progress: string[] = [];
  await execute(m.gh, c, o, (_, v) => progress.push(v));
  assert.deepEqual(progress, ["Done"]);
  const writes = m.calls.filter((v) => v.method !== "GET" && v.path !== "/graphql");
  assert.equal(writes[0]!.path, "/repos/example/tracker/issues/9/comments");
  assert.equal(writes[0]!.body.body.split("\n")[0], marker(o));
  assert.equal(m.calls.filter((v) => v.method === "GET" && v.path === "/repos/example/tasks/issues/1").length, 2);
  assert.match(writes.at(-1)!.body.body, /1\. done/);
  const before = writes.length;
  await assert.rejects(execute(m.gh, c, o, () => {}), /already/);
  assert.equal(m.calls.filter((v) => v.method !== "GET" && v.path !== "/graphql").length, before);
});

it("stops at first failure, retains the executed marker and never posts API text as intent", async () => {
  const o = offer([{ ...base, type: "add_label", label: "x" }, { ...base, number: 2, type: "add_label", label: "y" }]);
  const m = mock(o); m.fail("/repos/example/tasks/issues/1/labels");
  await assert.rejects(execute(m.gh, c, o, () => {}));
  assert.ok(!m.calls.some((v) => v.method === "POST" && v.path === "/repos/example/tasks/issues/2/labels"));
  const receipt = m.calls.at(-1)!;
  assert.equal(receipt.method, "PATCH"); assert.ok(receipt.body.body.startsWith(marker(o)));
  assert.match(receipt.body.body, /1\. failed or uncertain/); assert.ok(!receipt.body.body.includes("/promote"));
});

it("refuses another viewer, changed proposal, forged UI object and stale execution preflight", async () => {
  const o = offer();
  const m = mock(o); m.setViewer("visitor"); await assert.rejects(execute(m.gh, c, o, () => {}), /own token/);
  const changed = mock(o); changed.all[0] = { ...o.comment, updatedAt: "2026-10-14T13:00:00Z" }; await assert.rejects(execute(changed.gh, c, o, () => {}), /changed/);
  const forged = { ...o, proposal: { ...o.proposal, why: "forged" } }; await assert.rejects(execute(mock(o).gh, c, forged, () => {}), /match/);
  const stale = mock(o); stale.issue({ updated_at: "2026-10-14T13:00:00Z" }); await assert.rejects(execute(stale.gh, c, o, () => {}), /Stale/);
  for (const v of [m, changed, stale]) assert.ok(!v.calls.some((v) => v.path.endsWith("/comments") && v.method === "POST"));
});

it("does not mutate after a competing earlier receipt or changed target after reservation", async () => {
  for (const competing of [true, false]) {
    const o = offer(); const m = mock(o);
    m.intercept(() => {
      if (m.calls.at(-1)?.path === "/repos/example/tracker/issues/9/comments") {
        if (competing) m.all.push({ ...o.comment, id: "IC_other", databaseId: 19, author: { login: c.operator }, body: marker(o) });
        else m.issue({ updated_at: "2026-10-14T13:00:00Z" });
      }
    });
    await assert.rejects(execute(m.gh, c, o, () => {}));
    assert.ok(!m.calls.some((v) => v.method === "PATCH" && v.path === "/repos/example/tasks/issues/1"));
  }
});

it("keeps discovery opt-in, renders plain text and disables stale proposals", async () => {
  const o = offer(); o.proposal.title = "<img src=x onerror=evil()>"; o.comment.body = `\`\`\`agent-board-action\n${JSON.stringify(o.proposal)}\n\`\`\``;
  const m = mock(o); m.issue({ updated_at: "2026-10-14T13:00:00Z" });
  const panel = actionsPanel(m.gh, c); document.body.replaceChildren(panel);
  assert.equal(m.calls.length, 0); assert.equal((panel as HTMLDetailsElement).open, false);
  panel.querySelector<HTMLButtonElement>("button")!.click();
  for (let i = 0; i < 100 && !panel.querySelector(".operator-proposal"); i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(panel.textContent?.includes(o.proposal.title)); assert.equal(panel.querySelector("img"), null);
  assert.equal(panel.querySelectorAll<HTMLButtonElement>("button")[1]!.disabled, true);
  assert.ok(panel.querySelector("pre")?.textContent?.includes("updatedAt"));
  assert.equal(win.document.querySelector("script"), null);
});
