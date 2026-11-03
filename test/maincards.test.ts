// The real main.ts hooks, not a parallel implementation of their writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { GitHub } from "../src/github/api.ts";
import { type Ask, parseNeedsYou } from "../src/github/holds.ts";
import { type Card, publishedCards, refusal } from "../src/github/inbox.ts";
import { fillInbox } from "../src/github/inboxview.ts";
import { newestDraft, type ReviewDraftConfig } from "../src/github/reviewdrafts.ts";
import { fields, fixture, rawAsk, rawNeedsYou, scriptedFetch, type Scripted } from "./helpers.ts";

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
/** The pass's asks of `raw`. */
function asks(...raw: Record<string, unknown>[]): Ask[] {
  const l = parseNeedsYou(rawNeedsYou(raw, "2026-10-30T00:00:00Z"));
  assert.ok(typeof l === "object", String(l));
  return l.items;
}
/** The pass's asks of `raw`, as cards. */
const cards = (...raw: Record<string, unknown>[]): Card[] => publishedCards(asks(...raw));
/** The pass's hold on tracker#50, as its card. */
const answerCard = (kind = "needs-human"): Card => cards(rawAsk(50, { kind, ask: "Which way?" }))[0]!;
const questionIssue = () => ({ ...shown(), labels: [{ name: "question" }, ...shown().labels], user: { login: "cgwalters-bot" }, assignees: [{ login: "cgwalters" }] });
function setup(route: (method: string, path: string) => Scripted | undefined, login = "cgwalters", drafts?: ReviewDraftConfig) {
  const f = scriptedFetch((method, url) => new URL(url).pathname === "/user" ? { body: { login } } : route(method, new URL(url).pathname) ?? (new URL(url).pathname === "/graphql" ? { body: { data: { repository: { issueOrPullRequest: { comments: { nodes: [] } } } } } } : undefined));
  const state = { gh: new GitHub(async () => "test", f.fetchImpl) } as Parameters<typeof inboxHooks>[0];
  state.items = [];
  let list = document.createElement("div");
  document.body.append(list);
  const paint = (card: Card, force = false, remount = false, listed: Ask[] = "ask" in card ? [card.ask] : []) => {
    state.published = { asks: listed, unavailable: false };
    if (remount) { list.remove(); list = document.createElement("div"); document.body.append(list); }
    fillInbox(list, [card], inboxHooks(state, drafts), force);
  };
  return { ...f, state, paint, get list() { return list; }, writes: () => f.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/graphql")) };
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
  assert.ok(r.list.querySelector(".card")!.classList.contains("card-done"));
  assert.match(r.list.textContent!, /Released: needs-human on cgwalters-forge\/tracker#50, the needs-human hold\. Other holds stay\. Waiting on the agent\./);
  r.paint({ ...card, priority: "P0" }, true, true);
  await settle();
  assert.equal(r.list.querySelector("form"), form);
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(r.writes().length, 2);
});

test("main refuses a retained representative answer after a malformed group is published", async () => {
  const r = setup((_method, p) => p === path ? { body: shown() } : undefined);
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Not sent";
  const l = parseNeedsYou(rawNeedsYou([rawAsk(50, { group: { reason: "drafts", numbers: [50, 0] } })], "2026-10-30T00:00:00Z"));
  assert.ok(typeof l === "object");
  r.state.published = { asks: l.items, list: l, unavailable: false };
  fillInbox(r.list, publishedCards(l.items), inboxHooks(r.state));
  assert.equal(form.querySelector("button")!.disabled, true);
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.equal(r.writes().length, 0);
  assert.equal(form.querySelector("textarea")!.value, "Not sent");
});

test("main digest approval skips a member the pass has since grouped", async () => {
  const r = setup(() => undefined);
  const digest = (group?: unknown) => rawAsk(7, { kind: "digest-approve", action: { type: "approve_pull_request", repository: "o/r", number: 7, head }, ...(group ? { group } : {}) });
  r.state.published = { asks: asks(digest({ reason: "drafts", numbers: [7, 8] })), unavailable: false };
  const rs = await inboxHooks(r.state).approveDigest!([{ pr: { owner: "o", repo: "r", number: 7 }, head, reason: "ok" }]);
  assert.deepEqual(rs.map((x) => x.status), ["skipped"]);
  assert.match(rs[0]!.note!, /grouped/);
  assert.equal(r.writes().length, 0);
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
  assert.match(r.list.textContent!, new RegExp(`Commented only: the ${kind} hold on cgwalters-forge/tracker#50 stays`));
  assert.doesNotMatch(r.list.textContent!, /Released/);
});

test("main digest partial results survive forced redraw without offering approved PRs again", async () => {
  const r = setup((method, p) => method === "GET" ? { body: p.endsWith("/reviews") ? [] : { state: "open", head: { sha: p.endsWith("/8") ? "b".repeat(40) : head } } } : { body: {} });
  const listed = asks(...[7, 8].map((n) => rawAsk(n, { key: `up/proj#${n}/digest`, item: `up/proj#${n}`, source: "digest", kind: "digest-approve", recommendation: "Ready", action: { type: "approve_pull_request", repository: "up/proj", number: n, head } })));
  const card = publishedCards(listed)[0]!;
  r.paint(card, false, false, listed);
  r.list.querySelector("button")!.click(); await settle();
  const report = r.list.querySelector(".maintain-results");
  assert.match(report!.textContent!, /Approved up\/proj#7.*Skipped/s);
  r.paint({ ...card, priority: "P0" }, true, true, listed);
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

// A redacted list in the shape agent-board's needs-you requests publish
// (agent-board#642, pass/holds/requests.rs): its action kinds and reasons
// verbatim, its repositories, numbers, heads and questions replaced.
const published = (): Card[] => {
  const l = parseNeedsYou(fixture("needs-you-requests.json"));
  assert.ok(typeof l === "object" && l.complete && !l.refused, String(l));
  return publishedCards(l.items);
};
const byKey = (key: string): Card => published().find((c) => c.key === key)!;

test("main draws each published request with only the step the pass and this forge allow", async () => {
  const cases: { key: string; kind: string; button?: string; refused?: RegExp; offered?: string; members?: number; note?: RegExp }[] = [
    { key: "cgwalters-forge/tracker#1101", kind: "answer", offered: "Not offered here: promote, merge or enqueue, close" },
    { key: "cgwalters-forge/widget#41", kind: "promote", members: 2, offered: "Not offered here: merge or enqueue, reply, close", note: /2 PRs: drafts waiting for promotion/ },
    { key: "cgwalters-forge/widget#43", kind: "approve", button: "Approve ccccccc", offered: "Not offered here: promote, merge or enqueue, reply, close" },
    { key: "up/proj#7", kind: "approve", refused: /Not offered here: Use a forge review bound to target\.head/, offered: "Not offered here: merge or enqueue, approve at the head", note: /marks this request unverified-carried/ },
    { key: "cgwalters-forge/widget#44", kind: "open", members: 2, offered: "Not offered here: reply", note: /missing-concrete-decision/ },
    { key: "mid/proj#3", kind: "answer", refused: /on https:\/\/forgejo\.example:3000\/git, and this page writes only to github\.com/ },
  ];
  for (const c of cases) {
    const r = setup(() => undefined);
    const card = byKey(c.key);
    assert.equal(card.kind, c.kind, c.key);
    r.paint(card); await settle();
    const el = r.list.querySelector(".card")!;
    assert.equal(el.querySelector(".card-body.actions button")?.textContent, c.button, c.key);
    if (c.refused) {
      assert.match(el.querySelector(".card-body .warn")!.textContent!, c.refused, c.key);
      assert.equal(el.querySelector("form, .card-body button"), null, c.key);
    }
    assert.equal(el.querySelector(".not-offered summary")?.textContent, c.offered, c.key);
    assert.equal(el.querySelectorAll("details.member").length, c.members ?? 0, c.key);
    if (c.note) assert.match(el.querySelector(".card-note")!.textContent!, c.note, c.key);
    // A group is never answered through its representative.
    if (c.members) assert.equal(el.querySelector("form"), null, c.key);
    assert.equal(r.writes().length, 0, c.key);
  }
});

test("main's chat answers only where the card would, and any descriptor ruling a step out rules it out", () => {
  const state = { gh: new GitHub(async () => "t", async () => { throw new Error("network forbidden"); }) } as Parameters<typeof inboxHooks>[0];
  const hooks = inboxHooks(state);
  assert.equal(typeof hooks.chatItem!(byKey("cgwalters-forge/tracker#1101"))?.answer, "function");
  assert.equal(hooks.chatItem!(byKey("mid/proj#3"))?.answer, undefined);
  const approve = byKey("cgwalters-forge/widget#43") as Card & { kind: "approve" };
  const [live] = approve.ask.requests!;
  const carried = { ...live!, actions: [{ kind: "review-at-head", supported: false, reason: "carried" }] };
  for (const requests of [[live!, carried], [carried, live!]]) assert.equal(refusal({ ...approve.ask, requests }, "review-at-head"), "carried");
});

const BOT_META = "Fix.\n\n<!-- bot-meta -->\n- Upstream: `up/widget`, base `main`\n<!-- /bot-meta -->";

test("main reads promotion members on demand but withholds the unbound command", async () => {
  const B = "b".repeat(40);
  const pulls: Record<number, { body: string; sha: string; moved?: string; post?: number }> = {
    41: { body: BOT_META, sha: head },
    42: { body: BOT_META, sha: head, moved: B },
  };
  const read = new Map<number, number>();
  const r = setup((method, p) => {
    const m = /^\/repos\/cgwalters-forge\/widget\/(?:pulls|issues)\/(\d+)(\/comments)?$/.exec(p);
    const pr = m && pulls[Number(m[1])];
    if (!pr) return undefined;
    if (method === "POST" && m![2]) return { status: pr.post ?? 201, body: { html_url: `https://github.com/cgwalters-forge/widget/pull/${m![1]}#issuecomment-9` } };
    const n = (read.get(Number(m![1])) ?? 0) + 1;
    read.set(Number(m![1]), n);
    return { body: { html_url: `https://github.com/cgwalters-forge/widget/pull/${m![1]}`, title: `Draft ${m![1]}`, state: "open", draft: true, body: pr.body, user: { login: "cgwalters-bot" }, head: { sha: n > 1 && pr.moved ? pr.moved : pr.sha } } };
  });
  r.paint(byKey("cgwalters-forge/widget#41")); await settle();
  assert.equal(read.size, 0, "nothing is read until a member is opened");
  const [first, second] = r.list.querySelectorAll<HTMLDetailsElement>("details.member");
  for (const d of [first!, second!]) { d.open = true; d.dispatchEvent(new dom.window.Event("toggle")); }
  await settle();
  assert.match(first!.textContent!, /Draft 41 · open draft · aaaaaaa · by cgwalters-bot · Review/);
  for (const d of [first!, second!]) {
    assert.equal(d.querySelector("button"), null);
    assert.match(d.textContent!, /\/promote command cannot be bound to the displayed head/);
  }
  assert.deepEqual(r.writes(), []);
  // An old member report must not freeze the group's live readers on r.
  const report = document.createElement("p");
  report.dataset.keep = "";
  report.dataset.sent = "";
  first!.append(report);
  r.paint(byKey("cgwalters-forge/widget#41"), true);
  const again = r.list.querySelectorAll<HTMLDetailsElement>("details.member")[1]!;
  again.open = true; again.dispatchEvent(new dom.window.Event("toggle")); await settle();
  assert.notEqual(again, second);
  assert.match(again.textContent!, /Draft 42 · open draft · bbbbbbb/);
  assert.deepEqual(r.writes(), []);
});

test("main explains member-specific promotion problems", async () => {
  for (const [body, user, why] of [["No meta.", "cgwalters-bot", /names no upstream/], [BOT_META, "someone", /not a cgwalters-bot PR in cgwalters-forge/]] as const) {
    const r = setup((method, p) => p === "/repos/cgwalters-forge/widget/pulls/41" ? { body: { html_url: "https://github.com/cgwalters-forge/widget/pull/41", title: "T", state: "open", draft: true, body, user: { login: user }, head: { sha: head } } } : undefined);
    r.paint(byKey("cgwalters-forge/widget#41"));
    const d = r.list.querySelector<HTMLDetailsElement>("details.member")!;
    d.open = true; d.dispatchEvent(new dom.window.Event("toggle")); await settle();
    assert.match(d.textContent!, why);
    assert.equal(d.querySelector("button"), null);
  }
});

test("foreign-forge cards offer neither GitHub inspection nor a GitHub chat target", async () => {
  const r = setup(() => { throw new Error("must not read GitHub"); });
  r.paint(byKey("mid/proj#3")); await settle();
  assert.equal(r.list.querySelector("a, button, form"), null);
  assert.equal(r.list.querySelector(".card")!.getAttribute("data-href"), "#");
  assert.equal(r.calls.length, 0);
});

test("digest aggregation leaves foreign and unsupported requests read-only", async () => {
  const items = [7, 8, 9].map((n) => rawAsk(n, { key: `up/proj#${n}/digest`, item: `up/proj#${n}`, source: "digest", kind: "digest-approve", action: { type: "approve_pull_request", repository: "up/proj", number: n, head } }));
  const requests = items.map((a, i) => ({ key: a.key, forge: i === 1 ? "https://forgejo.example/git" : "github.com", quality: "decision", actions: [{ kind: "review-at-head", supported: i !== 2, reason: "approval unsupported" }] }));
  const l = parseNeedsYou(rawNeedsYou(items, "2026-10-30T00:00:00Z", { requests }));
  assert.ok(typeof l === "object");
  const all = publishedCards(l.items);
  assert.deepEqual(all.map((c) => c.key), ["digest", "up/proj#8/digest", "up/proj#9/digest"]);
  const r = setup((method, p) => method === "GET" ? { body: p.endsWith("/reviews") ? [] : { state: "open", head: { sha: head } } } : { body: {} });
  for (const card of all.slice(1)) {
    r.paint(card, true, true); await settle();
    assert.equal(r.list.querySelector(".card-body button, input, form"), null);
    assert.match(r.list.textContent!, /Not offered here:/);
  }
  r.paint(all[0]!, true, true, l.items);
  r.list.querySelector("button")!.click(); await settle();
  assert.deepEqual(r.writes().map((c) => new URL(c.url).pathname), ["/repos/up/proj/pulls/7/reviews"]);
});

test("malformed and capped descriptors never restore legacy writes or navigation", async () => {
  for (const forge of ["github.com", "https://forgejo.example/git"]) {
    const request = { key: target.toLowerCase(), forge, quality: "decision", actions: [{ kind: "reply", supported: false, reason: "unsupported" }] };
    for (const requests of [
      [{ ...request, actions: [{ kind: "reply", supported: false, reason: "" }] }],
      [{ ...request, quality: "future-quality" }],
      [...Array.from({ length: 500 }, () => ({ ...request, key: "other/repo#1" })), request],
      null,
      [{}],
      [],
      [{ ...request, key: "other/repo#1" }],
    ]) {
      const l = parseNeedsYou(rawNeedsYou([rawAsk(50)], "2026-10-30T00:00:00Z", { requests }));
      assert.ok(typeof l === "object" && !l.complete);
      assert.equal(l.items[0]!.requestsUnreadable, true);
      const r = setup(() => { throw new Error("must not read GitHub"); });
      r.paint(publishedCards(l.items)[0]!); await settle();
      assert.match(r.list.textContent!, /descriptors could not be read safely/);
      assert.equal(r.list.querySelector("button, form, a"), null);
      assert.equal(r.calls.length, 0);
    }
  }
});

test("cached approval refusals cannot outlive updated forge or capability restrictions", async () => {
  for (const policy of [
    { forge: "https://forgejo.example/git", actions: [{ kind: "review-at-head", supported: true, reason: "ready" }] },
    { forge: "github.com", actions: [{ kind: "review-at-head", supported: false, reason: "unsupported" }] },
    { forge: "github.com", actions: [] },
    { forge: "github.com", actions: [{ kind: "future-action", supported: true, reason: "ready" }] },
    { forge: "github.com", actions: [{ kind: "review-at-head", supported: true, reason: "" }] },
  ]) {
    const r = setup((_method, p) => p.endsWith("/reviews") ? { body: [] } : p.includes("/pulls/") ? { body: { state: "open", head: { sha: "b".repeat(40) } } } : undefined);
    const raw = rawAsk(7, { key: "up/proj#7", item: "up/proj#7", kind: "review-approve", action: { type: "approve_pull_request", repository: "up/proj", number: 7, head } });
    const initial = cards(raw)[0]!;
    r.paint(initial);
    const old = r.list.querySelector<HTMLButtonElement>(".card-body button")!;
    old.click(); await settle();
    assert.equal(old.disabled, false);
    assert.match(r.list.textContent!, /head moved/);
    const l = parseNeedsYou(rawNeedsYou([raw], "2026-10-30T00:00:00Z", { requests: [{ key: raw.key, quality: "decision", ...policy }] }));
    assert.ok(typeof l === "object");
    const restricted = publishedCards(l.items)[0]!;
    r.paint(restricted);
    assert.equal(old.disabled, true, "a retained receipt loses its obsolete controls");
    assert.equal(r.list.querySelector("a[href]"), null);
    old.click(); await settle();
    assert.equal(r.writes().length, 0);
    r.paint(restricted, true);
    assert.equal(r.list.querySelector(".card-body button, form"), null);
    assert.match(r.list.textContent!, /Not offered here:/);
    assert.equal(r.writes().length, 0);
  }
});

test("a retained answer keeps its text but cannot submit after its forge changes", async () => {
  const r = setup((_method, p) => p === path ? { body: shown() } : undefined);
  const card = answerCard() as Card & { kind: "answer" };
  r.paint(card); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Keep this unsent answer.";
  r.paint({ ...card, ask: { ...card.ask, requestsUnreadable: true } });
  assert.equal(r.list.querySelector("form"), form);
  assert.equal(form.querySelector("textarea")!.value, "Keep this unsent answer.");
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true, bubbles: true })); await settle();
  assert.equal(r.writes().length, 0);
  assert.equal(r.list.querySelector("a[href]"), null);
});

test("new restrictions also retire an old digest's picked members", async () => {
  const r = setup((method, p) => method === "GET" ? { body: p.endsWith("/reviews") ? [] : { state: "open", head: { sha: "b".repeat(40) } } } : { body: {} });
  const raw = [7, 8].map((n) => rawAsk(n, { key: `up/proj#${n}/digest`, item: `up/proj#${n}`, kind: "digest-approve", action: { type: "approve_pull_request", repository: "up/proj", number: n, head } }));
  r.paint(cards(...raw)[0]!);
  const old = r.list.querySelector<HTMLButtonElement>("button")!;
  old.click(); await settle();
  const l = parseNeedsYou(rawNeedsYou(raw, "2026-10-30T00:00:00Z", { requests: raw.map((a, i) => ({ key: a.key, forge: i ? "https://forgejo.example/git" : "github.com", quality: "decision", actions: [{ kind: "review-at-head", supported: true, reason: "ready" }] })) }));
  assert.ok(typeof l === "object");
  const current = publishedCards(l.items)[0]!;
  r.paint(current);
  assert.equal(old.disabled, true);
  old.click(); await settle();
  assert.equal(r.writes().length, 0);
  r.paint(current, true);
  assert.equal(r.list.querySelectorAll("input").length, 1);
});

test("ordinary groups reread members on r after either success or a failed read", async () => {
  for (const fail of [false, true]) {
    let reads = 0;
    const r = setup((_method, p) => {
      if (p !== "/repos/cgwalters-forge/widget/pulls/44") return undefined;
      reads++;
      return fail && reads === 1 ? { status: 502 } : { body: { html_url: "https://github.com/cgwalters-forge/widget/pull/44", title: "Member", state: "open", body: BOT_META, user: { login: "cgwalters-bot" }, head: { sha: reads === 1 ? head : "b".repeat(40) } } };
    });
    const card = byKey("cgwalters-forge/widget#44");
    r.paint(card);
    const first = r.list.querySelector<HTMLDetailsElement>("details.member")!;
    first.open = true; first.dispatchEvent(new dom.window.Event("toggle")); await settle();
    r.paint(card, true);
    const second = r.list.querySelector<HTMLDetailsElement>("details.member")!;
    assert.notEqual(first, second);
    second.open = true; second.dispatchEvent(new dom.window.Event("toggle")); await settle();
    assert.equal(reads, 2);
    assert.match(second.textContent!, /bbbbbbb/);
  }
});

test("a digest that disappears when all members are restricted retains no approval authority", async () => {
  for (const restricted of [
    { forge: "https://forgejo.example/git", supported: true, reason: "ready" },
    { forge: "github.com", supported: false, reason: "unsupported" },
    { forge: "github.com", supported: true, reason: "" },
  ]) {
    const r = setup((method, p) => method === "GET" ? { body: p.endsWith("/reviews") ? [] : { state: "open", head: { sha: "b".repeat(40) } } } : { body: {} });
    const raw = rawAsk(7, { key: "up/proj#7/digest", item: "up/proj#7", kind: "digest-approve", action: { type: "approve_pull_request", repository: "up/proj", number: 7, head } });
    r.paint(cards(raw)[0]!);
    const old = r.list.querySelector<HTMLButtonElement>("button")!;
    old.click(); await settle();
    assert.equal(old.disabled, false);
    const l = parseNeedsYou(rawNeedsYou([raw], "2026-10-30T00:00:00Z", { requests: [{ key: raw.key, forge: restricted.forge, quality: "decision", actions: [{ kind: "review-at-head", supported: restricted.supported, reason: restricted.reason }] }] }));
    assert.ok(typeof l === "object");
    const current = publishedCards(l.items);
    assert.equal(current.some((c) => c.kind === "digest"), false);
    r.paint(current[0]!);
    assert.ok(r.list.contains(old), "the old report remains visible");
    assert.equal(old.disabled, true);
    assert.equal(old.closest(".card")!.querySelector("a[href]"), null);
    old.click(); await settle();
    assert.equal(r.writes().length, 0);
  }
});
