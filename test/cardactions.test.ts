// Inbox card actions end to end against a scripted GitHub: the card's
// button or form, the write it makes as the viewer, and the refresh after
// it, wired as main.ts wires them. Nothing here reaches the network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Action, ActionConfig, Comment, Offered, Proposal } from "../src/github/actions.ts";
import { proposalCard } from "../src/github/actionsview.ts";
import { GitHub } from "../src/github/api.ts";
import { answerHold, approveAt, asOperator, openHead } from "../src/github/backend.ts";
import type { Hold } from "../src/github/holds.ts";
import { type Card, digestCard, inboxCards, needCard } from "../src/github/inbox.ts";
import { fillInbox, type InboxHooks } from "../src/github/inboxview.ts";
import { approveSelected, type Digest } from "../src/github/maintain.ts";
import { buildNeeds, type Need } from "../src/github/needs.ts";
import { createRenderer } from "../src/markdown.ts";
import { installDom, type Recorded, scriptedFetch, type Scripted } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
let confirmed = true;
window.confirm = () => confirmed;

const OPERATOR = "cgwalters";
const A = "a".repeat(40);
const B = "b".repeat(40);
const PR = { owner: "up", repo: "proj", number: 7 };

/** Let the card's reads and writes settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const writes = (calls: Recorded[]) => calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/graphql")).map((c) => `${c.method} ${new URL(c.url).pathname}`);

/** A scripted GitHub with the viewer `login`; `route` answers everything else. */
function forge(route: (method: string, path: string, body: unknown) => Scripted | undefined, login = OPERATOR) {
  const f = scriptedFetch((method, url) => {
    const path = new URL(url).pathname;
    if (path === "/user") return { body: { login } };
    return route(method, path, f.calls.at(-1)?.body);
  });
  return { gh: new GitHub(async () => "t", f.fetchImpl), calls: f.calls };
}

/** The hooks main.ts gives the inbox, each write as the operator, with `refreshed` standing for its redraw. */
function cardHooks(gh: GitHub, refreshed: string[]): InboxHooks {
  return {
    now: Date.parse("2026-10-30T12:00:00Z"),
    render,
    mayAct: true,
    sendNeed: async () => { throw new Error("unused"); },
    answerEntry: async () => {},
    headOf: (n) => openHead(gh, n.entry!.pr!.ref),
    approve: (n, head) => asOperator(gh, async () => {
      const url = await approveAt(gh, n.entry!.pr!.ref, head);
      refreshed.push("approve");
      return url;
    }),
    answerHold: (n, text) => asOperator(gh, async () => (await answerHold(gh, n.hold!.item!, text)).url),
    approveDigest: (items) => asOperator(gh, async () => {
      const rs = await approveSelected(gh, items);
      if (rs.every((r) => r.status === "approved")) refreshed.push("digest");
      return rs;
    }),
  };
}

function draw(cards: Card[], hooks: InboxHooks): HTMLElement {
  const list = document.createElement("div");
  fillInbox(list, cards, hooks);
  return list;
}

const reviewCard = (): Card => {
  const pr = { ref: PR, url: "https://github.com/up/proj/pull/7", title: "Fix", body: "", author: "someone", createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z", draft: false };
  const need: Need = { key: "pr:up/proj#7", action: "review", title: "Fix", where: "up/proj#7", href: "#pr/up/proj/7", inPlace: false, entry: { key: "pr:up/proj#7", kind: "pr", title: "Fix", where: "up/proj#7", href: "#pr/up/proj/7", pr } };
  return needCard(need)!;
};

describe("Approve card", () => {
  /** A PR at head A, moving to `moved` once the card has read it; reviews answer `review`. */
  function pull(opts: { moved?: string; review?: number } = {}) {
    let reads = 0;
    return (method: string, path: string): Scripted | undefined => {
      if (method === "GET" && path === "/repos/up/proj/pulls/7") return { body: { state: "open", html_url: "https://github.com/up/proj/pull/7", head: { sha: reads++ && opts.moved ? opts.moved : A } } };
      if (method === "POST" && path === "/repos/up/proj/pulls/7/reviews") return { status: opts.review ?? 200, body: { html_url: "https://github.com/up/proj/pull/7#pullrequestreview-1" } };
      return undefined;
    };
  }

  async function click(route: ReturnType<typeof pull>, login = OPERATOR) {
    const { gh, calls } = forge(route, login);
    const refreshed: string[] = [];
    const hooks = cardHooks(gh, refreshed);
    const card = reviewCard();
    const list = draw([card], hooks);
    await settle();
    const button = [...list.querySelectorAll("button")].find((b) => b.textContent === `Approve ${A.slice(0, 7)}`)!;
    assert.ok(button, "the card shows the head it read");
    button.click();
    await settle();
    return { list, calls, refreshed, button, status: list.querySelector(".card-body [role=status]")!.textContent!, repaint: (force = false) => fillInbox(list, [card], hooks, force) };
  }

  it("approves the head the card read, as the operator, then refreshes", async () => {
    const r = await click(pull());
    assert.deepEqual(writes(r.calls), ["POST /repos/up/proj/pulls/7/reviews"]);
    assert.deepEqual(r.calls.find((c) => c.method === "POST")!.body, { event: "APPROVE", commit_id: A, body: "" });
    assert.deepEqual(r.refreshed, ["approve"]);
    assert.match(r.status, /^Approved: /);
  });

  it("sends nothing when the head moved after the card read it", async () => {
    const r = await click(pull({ moved: B }));
    assert.deepEqual(writes(r.calls), []);
    assert.deepEqual(r.refreshed, []);
    assert.match(r.status, /head moved to bbbbbbbbbbbb/);
    assert.equal(r.button.disabled, false);
    // A poll keeps the report; r redraws, reading the head again, and offers that one.
    r.repaint();
    assert.match(r.list.textContent!, /head moved to bbbbbbbbbbbb/);
    r.repaint(true);
    await settle();
    assert.ok([...r.list.querySelectorAll("button")].some((b) => b.textContent === `Approve ${B.slice(0, 7)}`));
  });

  it("sends nothing under another viewer's token", async () => {
    const r = await click(pull(), "someone-else");
    assert.deepEqual(writes(r.calls), []);
    assert.match(r.status, /someone-else's, not cgwalters's/);
  });

  it("reports a failed write as uncertain and never retries it", async () => {
    const r = await click(pull({ review: 502 }));
    assert.deepEqual(writes(r.calls), ["POST /repos/up/proj/pulls/7/reviews"]);
    assert.deepEqual(r.refreshed, []);
    assert.match(r.status, /^Not sent, or uncertain: .*Check on GitHub before trying again\.$/);
    // A poll's redraw doesn't wipe the uncertainty for a fresh button.
    r.repaint();
    assert.match(r.list.textContent!, /Not sent, or uncertain/);
  });

  it("sends nothing when he cancels the confirmation", async () => {
    confirmed = false;
    try {
      const r = await click(pull());
      assert.deepEqual(writes(r.calls), []);
    } finally { confirmed = true; }
  });

  it("refuses a review ask about another head rather than approve one the bot didn't ask about", async () => {
    const { gh, calls } = forge(pull());
    await assert.rejects(approveAt(gh, PR, A, { ref: { owner: "cgwalters-forge", repo: "tracker", number: 3 }, head: B }), /asks about bbbbbbbbbbbb/);
    assert.deepEqual(calls, []);
  });
});

describe("hold card", () => {
  const hold: Hold = { item: "cgwalters-forge/tracker#50", url: "https://github.com/cgwalters-forge/tracker/issues/50", epic: false, kind: "needs-human", reason: "needs a decision", operator: true, priority: "P1", question: "Which way?" };
  const card = () => needCard(buildNeeds({ entries: [], holds: { at: "2026-10-30T00:00:00Z", holds: [hold] } })[0]!)!;

  async function answer(state: string, login = OPERATOR, url = "https://github.com/cgwalters-forge/tracker/issues/50") {
    const { gh, calls } = forge((method, path) => {
      if (method === "GET" && path === "/repos/cgwalters-forge/tracker/issues/50") return { body: { state, html_url: url } };
      if (method === "POST" && path === "/repos/cgwalters-forge/tracker/issues/50/comments") return { body: { html_url: "https://github.com/cgwalters-forge/tracker/issues/50#issuecomment-1" } };
      return undefined;
    }, login);
    const list = draw([card()], cardHooks(gh, []));
    const form = list.querySelector("form")!;
    form.querySelector("textarea")!.value = "Go left.";
    form.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await settle();
    return { list, calls, form, status: form.querySelector("[role=status]")!.textContent! };
  }

  it("posts his text on the held item and says the hold is not released", async () => {
    const r = await answer("open");
    assert.deepEqual(writes(r.calls), ["POST /repos/cgwalters-forge/tracker/issues/50/comments"]);
    assert.deepEqual(r.calls.find((c) => c.method === "POST")!.body, { body: "Go left.\n" });
    assert.match(r.status, /^Sent: /);
    assert.match(r.form.textContent!, /Only a comment: the hold stays until the pass releases it\./);
    // A comment is no release: the card is not marked done.
    assert.equal(r.list.querySelector(".card-done"), null);
  });

  it("refuses a closed or transferred item, and another viewer, before writing", async () => {
    assert.deepEqual(writes((await answer("closed")).calls), []);
    const moved = await answer("open", OPERATOR, "https://github.com/elsewhere/tracker/issues/50");
    assert.deepEqual(writes(moved.calls), []);
    assert.match(moved.status, /is now https:\/\/github.com\/elsewhere/);
    const other = await answer("open", "someone-else");
    assert.deepEqual(writes(other.calls), []);
    assert.match(other.status, /^Not sent: .*not cgwalters's/);
    // The unsent text stays for him to send again.
    assert.equal(other.form.querySelector("textarea")!.value, "Go left.");
  });
});

describe("digest card", () => {
  const item = (number: number, head: string) => ({ pr: { owner: "up", repo: "proj", number }, head, reason: `PR ${number}` });
  const digest = (): Digest => ({ date: "2026-10-30", approve: [item(7, A), item(8, A), item(9, A)], closer: [], waiting: [], stale: [] });

  async function approve(route: (method: string, path: string) => Scripted | undefined, login = OPERATOR) {
    const { gh, calls } = forge(route, login);
    const refreshed: string[] = [];
    const hooks = cardHooks(gh, refreshed);
    const found = { url: "https://github.com/example/ops/issues/4", digest: digest() };
    const list = draw([digestCard(found)!], hooks);
    [...list.querySelectorAll("button")].find((b) => b.textContent === "Approve selected")!.click();
    const results = () => [...list.querySelectorAll(".maintain-results li")].map((li) => li.textContent);
    // A redraw while the batch is in flight leaves the card alone, even on r.
    fillInbox(list, [digestCard(found)!], hooks, true);
    await settle();
    const r = { calls, refreshed, results: results(), boxes: [...list.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].map((b) => b.disabled) };
    // So does one after it while it reports a skip or failure, though its approvals changed the card;
    // a clean batch's card is redrawn, done.
    fillInbox(list, [digestCard(found)!], hooks);
    if (r.results.every((t) => t!.startsWith("Approved"))) assert.ok(list.querySelector(".card-done"));
    else assert.deepEqual(results(), r.results);
    return r;
  }

  it("approves each PR at its assessed head, reports a partial failure per PR, and leaves the redraw to the next poll", async () => {
    const r = await approve((method, path) => {
      const n = /\/pulls\/(\d+)/.exec(path)?.[1];
      if (method === "GET") return { body: { state: "open", head: { sha: n === "8" ? B : A } } };
      if (method === "POST") return n === "9" ? { status: 500, body: {} } : { body: {} };
      return undefined;
    });
    assert.deepEqual(writes(r.calls), ["POST /repos/up/proj/pulls/7/reviews", "POST /repos/up/proj/pulls/9/reviews"]);
    assert.equal(r.results[0], "Approved up/proj#7.");
    assert.match(r.results[1]!, /^Skipped: up\/proj#8's head moved/);
    assert.match(r.results[2]!, /^Failed or uncertain: up\/proj#9/);
    assert.deepEqual(r.boxes, [true, false, false]);
    assert.deepEqual(r.refreshed, []);
  });

  it("refreshes once every PR is approved", async () => {
    const r = await approve((method) => (method === "GET" ? { body: { state: "open", head: { sha: A } } } : { body: {} }));
    assert.equal(writes(r.calls).length, 3);
    assert.deepEqual(r.refreshed, ["digest"]);
  });

  it("approves nothing under another viewer's token", async () => {
    const r = await approve(() => ({ body: {} }), "someone-else");
    assert.deepEqual(writes(r.calls), []);
    assert.match(r.results[0]!, /^Not sent: .*someone-else's/);
  });
});

describe("proposal on a card (close, merge)", () => {
  const config: ActionConfig = { operator: OPERATOR, planner: "cgwalters-bot", tracker: "example/tracker", repositories: ["example/tasks", "example/tracker"], project: "", org: "" };

  function offer(actions: Action[]): Offered {
    const proposal = { schema: "agent-board/operator-action/v1", title: "Tidy up", why: "Superseded.", actions } as Proposal;
    const comment: Comment = { id: "IC_p", databaseId: 10, body: `\`\`\`agent-board-action\n${JSON.stringify(proposal)}\n\`\`\``, updatedAt: "2026-10-30T00:00:00Z", author: { login: "cgwalters-bot" }, editor: null, lastEditedAt: null };
    return { issue: 9, comment, proposal };
  }

  /** The tracker's comments with receipts as they are posted, an issue, and a PR whose head is `head` and whose merge answers `merge`. */
  async function run(o: Offered, opts: { head?: string; merge?: number; login?: string } = {}) {
    const comments: Comment[] = [o.comment];
    let issueState = "open";
    const { gh, calls } = forge((method, path, body) => {
      const b = body as Record<string, any> | undefined;
      if (path === "/graphql") return { body: { data: { repository: { issue: { state: "OPEN", comments: { nodes: comments, pageInfo: { hasNextPage: false } } } } } } };
      if (path === "/repos/example/tracker/issues/9/comments" && method === "POST") {
        comments.push({ id: "IC_r", databaseId: 99, body: b!.body, updatedAt: "2026-10-30T01:00:00Z", author: { login: OPERATOR }, editor: null, lastEditedAt: null });
        return { body: { id: 99 } };
      }
      if (path === "/repos/example/tracker/issues/comments/99") return { body: {} };
      if (path === "/repos/example/tasks/issues/1") {
        if (method === "PATCH") issueState = b!.state;
        return { body: { id: 1, node_id: "I_1", title: "Old task", state: issueState, labels: [] } };
      }
      if (path === "/repos/example/tasks/issues/1/comments") return { body: {} };
      if (path === "/repos/example/tasks/pulls/2") return { body: { title: "Ready", state: "open", merged: false, draft: false, head: { sha: opts.head ?? A } } };
      if (path === "/repos/example/tasks/pulls/2/merge") return { status: opts.merge ?? 200, body: { merged: true, message: "Merge queue required" } };
      return undefined;
    }, opts.login);
    const refreshed: string[] = [];
    let busy = false;
    const hooks: InboxHooks = { ...cardHooks(gh, refreshed), offerBody: (x) => proposalCard(gh, config, x, () => busy, (v) => { busy = v; if (!v) refreshed.push("proposal"); }) };
    const list = draw(inboxCards({ offers: [o] }), hooks);
    await settle();
    const button = [...list.querySelectorAll("button")].find((x) => x.textContent === "Run as yourself")!;
    const before = calls.length;
    button.click();
    await settle();
    return { calls, refreshed, button, list, ran: calls.slice(before), text: list.textContent! };
  }

  it("closes an issue from its card, records the receipt, then refreshes", async () => {
    const r = await run(offer([{ type: "close_issue", repo: "example/tasks", number: 1, reason: "Superseded" }]));
    assert.deepEqual(writes(r.ran), ["POST /repos/example/tracker/issues/9/comments", "POST /repos/example/tasks/issues/1/comments", "PATCH /repos/example/tasks/issues/1", "PATCH /repos/example/tracker/issues/comments/99"]);
    assert.match(r.text, /Executed; result recorded/);
    assert.deepEqual(r.refreshed, ["proposal"]);
  });

  it("merges at the shown head with GitHub's SHA guard", async () => {
    const r = await run(offer([{ type: "merge_pull_request", repo: "example/tasks", number: 2, head_sha: A, method: "squash" }]));
    assert.deepEqual(r.ran.find((c) => c.method === "PUT")!.body, { sha: A, merge_method: "squash" });
    assert.match(r.text, /Executed; result recorded/);
  });

  it("reports a merge GitHub refuses (a required queue, missing permission) as failed or uncertain, once", async () => {
    for (const status of [405, 403]) {
      const r = await run(offer([{ type: "merge_pull_request", repo: "example/tasks", number: 2, head_sha: A, method: "merge" }]), { merge: status });
      assert.equal(r.ran.filter((c) => c.method === "PUT").length, 1);
      assert.match(r.text, /Failed or uncertain; stopped/);
      assert.match(r.text, /do not retry an uncertain action/);
      assert.match(String(r.ran.at(-1)!.body && (r.ran.at(-1)!.body as { body: string }).body), /1\. failed or uncertain/);
    }
  });

  it("refuses a moved head before anything is reserved", async () => {
    const r = await run(offer([{ type: "merge_pull_request", repo: "example/tasks", number: 2, head_sha: A, method: "merge" }]), { head: B });
    assert.equal(r.button.disabled, true);
    assert.match(r.text, /Refused: .*Stale example\/tasks#2/);
    assert.deepEqual(writes(r.ran), []);
  });

  it("refuses another viewer's token before anything is reserved", async () => {
    const r = await run(offer([{ type: "close_issue", repo: "example/tasks", number: 1, reason: "Superseded" }]), { login: "someone-else" });
    assert.deepEqual(writes(r.ran), []);
    assert.match(r.text, /Execution requires cgwalters's own token/);
  });
});
