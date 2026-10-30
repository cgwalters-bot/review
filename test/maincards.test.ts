// The real main.ts hooks, not a parallel implementation of their writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { GitHub } from "../src/github/api.ts";
import { parseNeedsYou } from "../src/github/holds.ts";
import { type Card, publishedCards } from "../src/github/inbox.ts";
import { fillInbox } from "../src/github/inboxview.ts";
import { newestDraft, type ReviewDraftConfig } from "../src/github/reviewdrafts.ts";
import { fields, rawAsk, rawNeedsYou, scriptedFetch, type Scripted } from "./helpers.ts";

const dom = new JSDOM(readFileSync(new URL("../static/index.html", import.meta.url), "utf8"), { url: "https://review.example/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement,
  ResizeObserver: class { observe() {} disconnect() {} }, fetch: async () => { throw new Error("network forbidden"); } });
dom.window.confirm = () => true;
const { inboxHooks } = await import("../src/github/main.ts");
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const target = "cgwalters-forge/tracker#50";
const url = "https://github.com/cgwalters-forge/tracker/issues/50";
const path = "/repos/cgwalters-forge/tracker/issues/50";
const head = "a".repeat(40);
const shown = () => ({ title: "Which way?", body: "Q: Which way?", state: "open", html_url: url, labels: [{ name: "needs-human" }, { name: "needs-design" }, { name: "other" }] });
/** The pass's asks of `raw`, as cards. */
function cards(...raw: Record<string, unknown>[]): Card[] {
  const l = parseNeedsYou(rawNeedsYou(raw, "2026-10-30T00:00:00Z"));
  assert.ok(typeof l === "object", String(l));
  return publishedCards(l.items);
}
/** The pass's hold on tracker#50, as its card. */
const answerCard = (kind = "needs-human"): Card => cards(rawAsk(50, { kind, ask: "Which way?" }))[0]!;
const questionIssue = () => ({ ...shown(), labels: [{ name: "question" }, ...shown().labels], user: { login: "cgwalters-bot" }, assignees: [{ login: "cgwalters" }] });
function setup(route: (method: string, path: string) => Scripted | undefined, login = "cgwalters", drafts?: ReviewDraftConfig) {
  const f = scriptedFetch((method, url) => new URL(url).pathname === "/user" ? { body: { login } } : route(method, new URL(url).pathname) ?? (new URL(url).pathname === "/graphql" ? { body: { data: { repository: { issueOrPullRequest: { comments: { nodes: [] } } } } } } : undefined));
  const state = { gh: new GitHub(async () => "test", f.fetchImpl) } as Parameters<typeof inboxHooks>[0];
  let list = document.createElement("div");
  document.body.append(list);
  const paint = (card: Card, force = false, remount = false) => {
    if (remount) { list.remove(); list = document.createElement("div"); document.body.append(list); }
    fillInbox(list, [card], inboxHooks(state, drafts), force);
  };
  return { ...f, paint, get list() { return list; }, writes: () => f.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/graphql")) };
}
async function answer(opts: { login?: string; after?: boolean; fail?: "comment" | "release"; kind?: string } = {}) {
  let posted = false;
  const r = setup((method, p) => {
    if (method === "GET" && p === path) return { body: { ...shown(), ...(opts.after && posted ? { body: "Q: A different ask" } : {}) } };
    if (method === "POST" && p === `${path}/comments`) { posted = true; return { status: opts.fail === "comment" ? 502 : 200, body: { html_url: `${url}#issuecomment-1` } }; }
    if (method === "DELETE") return { status: opts.fail === "release" ? 403 : 204 };
    return undefined;
  }, opts.login);
  const card = answerCard(opts.kind);
  r.paint(card);
  await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Go left.";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await settle();
  return { r, card, form };
}

test("main answer posts, then removes exactly needs-human; sent receipt survives refresh, metadata redraw and remount", async () => {
  const { r, card, form } = await answer();
  assert.deepEqual(r.writes().map((c) => `${c.method} ${new URL(c.url).pathname}`), [`POST ${path}/comments`, `DELETE ${path}/labels/needs-human`]);
  assert.match(form.textContent!, /issuecomment-1/);
  r.paint({ ...card, priority: "P0" }, true, true);
  await settle();
  assert.equal(r.list.querySelector("form"), form);
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(r.writes().length, 2);
});

test("main refuses wrong viewer and retains the unsent draft across ordinary redraw", async () => {
  const { r, card, form } = await answer({ login: "someone-else" });
  assert.equal(r.writes().length, 0);
  assert.match(form.textContent!, /not cgwalters's/);
  r.paint({ ...card, priority: "P0" });
  assert.equal(r.list.querySelector("form"), form);
  assert.equal(form.querySelector("textarea")!.value, "Go left.");
});

test("main refuses a moved ask before commenting, and a changed ask after commenting before release", async () => {
  let reads = 0;
  const r = setup((_method, p) => p === path ? { body: { ...shown(), body: reads++ ? "Q: Changed" : shown().body } } : undefined);
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Answer";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.equal(r.writes().length, 0);
  assert.match(form.textContent!, /ask changed/);
  const after = await answer({ after: true });
  assert.equal(after.r.writes().length, 1);
  assert.match(after.form.textContent!, /issuecomment-1; release failed: .*ask changed/);
});

test("main keeps a release-failure receipt visible beside a failed remount read", async () => {
  let down = false;
  const r = setup((method, p) => {
    if (down) return { status: 502 };
    if (method === "GET" && p === path) return { body: shown() };
    if (method === "POST" && p === `${path}/comments`) return { body: { html_url: `${url}#issuecomment-1` } };
    if (method === "DELETE") return { status: 403 };
    return undefined;
  });
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Go left.";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.match(form.textContent!, /issuecomment-1; release failed/);
  down = true;
  r.paint({ ...answerCard(), priority: "P0" }, true, true); await settle();
  assert.equal(r.list.querySelector("form"), form);
  assert.equal(form.querySelector("button")!.disabled, true);
  assert.match(r.list.querySelector(".warn")!.textContent!, /502/);
  assert.equal(r.writes().length, 2);
});

test("main refuses a replaced bot-comment ask even when the issue body did not change", async () => {
  let reads = 0;
  const r = setup((_method, p) => {
    if (p === path) return { body: shown() };
    if (p === "/graphql") return { body: { data: { repository: { issueOrPullRequest: { comments: { nodes: [{ body: reads++ ? "Decision needed: A new question" : "Decision needed: Which way?", author: { login: "cgwalters-bot" } }] } } } } } };
    return undefined;
  });
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Answer";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.equal(r.writes().length, 0);
  assert.match(form.textContent!, /ask changed/);
});

test("main checks bot-comment freshness on a question the pass lists", async () => {
  let reads = 0;
  const r = setup((_method, p) => {
    if (p === path) return { body: questionIssue() };
    if (p === "/graphql") return { body: { data: { repository: { issueOrPullRequest: { comments: { nodes: [{ body: reads++ ? "Decision needed: Changed" : "Decision needed: Which way?", author: { login: "cgwalters-bot" } }] } } } } } };
    return undefined;
  });
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Go left.";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.equal(r.writes().length, 0);
  assert.match(form.textContent!, /ask changed/);
});

test("main offers no form for a target that closed or moved since the pass listed it", async () => {
  for (const changed of [{ state: "closed" }, { html_url: "https://github.com/elsewhere/tracker/issues/50" }]) {
    const r = setup((_method, p) => p === path ? { body: { ...questionIssue(), ...changed } } : undefined);
    r.paint(answerCard()); await settle();
    assert.equal(r.list.querySelector("form"), null);
    assert.match(r.list.textContent!, /not answering/);
    assert.equal(r.writes().length, 0);
  }
});

test("main receipts use the target and read ask across redraws of a changed card, but allow a new bot ask", async () => {
  let ask = "Decision needed: Which way?";
  const r = setup((method, p) => {
    if (p === path) return { body: questionIssue() };
    if (p === "/graphql") return { body: { data: { repository: { issueOrPullRequest: { comments: { nodes: [{ body: ask, author: { login: "cgwalters-bot" } }] } } } } } };
    if (method === "POST") return { status: 502 };
    return undefined;
  });
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Go left.";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  r.paint({ ...answerCard(), title: "Refreshed question card" }, true, true); await settle();
  assert.match(r.list.textContent!, /Refreshed question card/);
  assert.equal(r.list.querySelector("form"), form);
  assert.equal(form.querySelector("button")!.disabled, true);
  assert.equal(r.writes().length, 1);
  ask = "Decision needed: A genuinely new ask";
  r.paint({ ...answerCard(), title: "New ask" }, true, true); await settle();
  assert.notEqual(r.list.querySelector("form"), form);
  assert.equal(r.list.querySelector<HTMLButtonElement>("form button")!.disabled, false);
  assert.match(r.list.textContent!, /A genuinely new ask/);
});

test("main resolves only an ask-created board question; never closes arbitrary held work or unlabels Blocks targets", async () => {
  const question = { ...shown(), body: "Blocks: https://github.com/up/proj/issues/7\n\nQ: Which way?", labels: [{ name: "question" }, ...shown().labels], user: { login: "cgwalters-bot" }, assignees: [{ login: "cgwalters" }] };
  const r = setup((method, p) => {
    if (p === path) return { body: question };
    if (p.endsWith("/fields")) return { body: fields() };
    if (p.endsWith("/items")) return { body: [{ id: 50, node_id: "PVTI_50", content_type: "Issue", content: question, fields: [] }] };
    if (method === "POST" && p === `${path}/comments`) return { body: { html_url: `${url}#issuecomment-1` } };
    if (method === "DELETE") return { status: 204 };
    return undefined;
  });
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Go left.";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.deepEqual(r.writes().map((c) => `${c.method} ${new URL(c.url).pathname}`), [`POST ${path}/comments`, `PATCH ${path}`, `DELETE ${path}/labels/needs-human`]);
  assert.deepEqual(r.writes()[1]!.body, { state: "closed", state_reason: "completed" });
});

for (const fail of ["comment", "release"] as const) test(`main keeps ${fail} failure across forced refresh and never offers another comment`, async () => {
  const { r, card, form } = await answer({ fail });
  const count = r.writes().length;
  assert.match(form.textContent!, fail === "release" ? /Answer posted: .*issuecomment-1; release failed/ : /Comment failed or uncertain/);
  r.paint({ ...card, priority: "P0" }, true, true); await settle();
  assert.equal(r.list.querySelector("form"), form);
  assert.equal(form.querySelector("button")!.disabled, true);
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.equal(r.writes().length, count);
});

for (const kind of ["needs-operator", "epic-unplanned"]) test(`main never releases ${kind} with a comment`, async () => {
  const { r, form } = await answer({ kind });
  assert.equal(r.writes().length, 1);
  assert.match(form.textContent!, /Only a comment/);
});

test("main digest partial results survive forced redraw without offering approved PRs again", async () => {
  const r = setup((method, p) => method === "GET" ? { body: p.endsWith("/reviews") ? [] : { state: "open", head: { sha: p.endsWith("/8") ? "b".repeat(40) : head } } } : { body: {} });
  const card = cards(...[7, 8].map((n) => rawAsk(n, { key: `up/proj#${n}/digest`, item: `up/proj#${n}`, source: "digest", kind: "digest-approve", recommendation: "Ready", action: { type: "approve_pull_request", repository: "up/proj", number: n, head } })))[0]!;
  r.paint(card);
  r.list.querySelector("button")!.click(); await settle();
  const report = r.list.querySelector(".maintain-results");
  assert.match(report!.textContent!, /Approved up\/proj#7.*Skipped/s);
  r.paint({ ...card, priority: "P0" }, true, true);
  assert.equal(r.list.querySelector(".maintain-results"), report);
  assert.equal(r.list.querySelector<HTMLInputElement>("input")!.disabled, true);
  assert.equal(r.writes().length, 1);
});

test("main Send checks the viewer before ticking, and preserves its refusal on redraw", async () => {
  const c: ReviewDraftConfig = { tracker: "example/tracker", label: "review-draft", authors: ["bot"], sendBox: "Send", workflow: "draft.yml", ref: "main" };
  const issue = { number: 5, title: "Draft", html_url: "https://github.com/example/tracker/issues/5", comments: 0, user: { login: "bot" },
    body: `\`\`\`review-draft\npr = "up/proj#7"\nhead = "${head}"\nevent = "APPROVE"\n\`\`\`\n\n## Review\n\nLooks good.\n\n- [ ] Send\n` };
  const r = setup(() => ({ body: { title: "PR", html_url: "https://github.com/up/proj/pull/7", state: "open", head: { sha: head } } }), "someone-else", c);
  const card: Card = { kind: "send", key: "draft:5", title: "Draft", where: "example/tracker#5", url: issue.html_url, draft: { issue, box: "unticked", found: newestDraft(issue, [], c)! } };
  r.paint(card); await settle();
  r.list.querySelector("button")!.click(); await settle();
  assert.equal(r.writes().length, 0);
  assert.match(r.list.textContent!, /not cgwalters's/);
  const send = r.list.querySelector(".review-draft");
  r.paint({ ...card, priority: "P0" }, true, true); await settle();
  assert.equal(r.list.querySelector(".review-draft"), send);
});
