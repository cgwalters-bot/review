// The pass's needs-you list through the real entry point: sign-in, the
// poll, the holds comment read with the viewer's token (200 and 304), and
// the inbox it draws, on a fake clock. Nothing reaches the network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { usagePath } from "../src/github/usage.ts";
import { fields, holdsComment, rawAsk, rawNeedsYou } from "./helpers.ts";

const T0 = Date.parse("2026-10-30T12:00:00Z");
const MINUTE = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const HOLDS = new URL(`https://api.github.com${usagePath}`).pathname;
const proposal = (comment: number) => rawAsk(1013, { key: `cgwalters-forge/tracker#1013/comment-${comment}`, source: "proposals", kind: "operator-action", ask: `Decision ${comment}`, action: { type: "operator_action", repository: "cgwalters-forge/tracker", number: 1013, comment } });
const proposalComment = (n: number) => ({ id: `IC_${n}`, databaseId: n, updatedAt: "2026-10-29T12:00:00Z", author: { login: "cgwalters-bot" }, editor: null, lastEditedAt: null,
  body: `\`\`\`agent-board-action\n${JSON.stringify({ schema: "agent-board/operator-action/v1", title: `Decision ${n}`, why: `Reason ${n}`, actions: [{ type: "add_label", repo: "cgwalters-forge/tracker", number: 1013, label: `choice-${n}` }] })}\n\`\`\`` });

/** What the holds comment read answers next: a status, the comments, and whether an unchanged one is a 304. */
interface Holds { status: number; comments: unknown[]; etag: string; gate?: Promise<void>; approvals?: Record<number, string[]>; fail?: number; labels?: string[]; reviewError?: number; writeGate?: Promise<void> }

let runs = 0;

/** The app signed in at #inbox, its clock at T0, the holds comment answering as `holds` says. */
async function boot(t: TestContext, holds: Holds) {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => {
    // Sign-out reloads the page; jsdom implements only hash navigation.
    if (!error.message.startsWith("Not implemented: navigation")) throw error;
  });
  const dom = new JSDOM(readFileSync(new URL("../static/index.html", import.meta.url), "utf8"), { url: "https://review.example/#inbox", pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.scrollTo = () => {};
  window.confirm = () => true;
  const reads = { holds: [] as (string | null)[], writes: [] as string[], reviews: [] as number[] };
  Object.assign(globalThis, {
    window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement,
    ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
      if (method !== "GET" && url.pathname !== "/graphql") reads.writes.push(`${method} ${url.pathname}`);
      if (url.pathname === HOLDS) {
        const sent = new Headers(init?.headers).get("If-None-Match");
        reads.holds.push(sent);
        await holds.gate;
        if (holds.status !== 200) return json({ message: "Server Error" }, holds.status);
        return sent === holds.etag ? json(null, 304, { ETag: holds.etag }) : json(holds.comments, 200, { ETag: holds.etag });
      }
      if (url.pathname === "/user") return json({ login: "cgwalters" });
      const pull = url.pathname.match(/\/pulls\/(\d+)(\/reviews)?$/);
      if (pull) {
        const n = Number(pull[1]);
        if (method === "POST") {
          await holds.writeGate;
          return json({ html_url: `https://github.com/up/proj/pull/${n}#pullrequestreview-1` }, holds.fail === n ? 502 : 200);
        }
        if (pull[2]) {
          reads.reviews.push(n);
          if (holds.reviewError) return json({ message: "reviews unavailable" }, holds.reviewError);
          return json((holds.approvals?.[n] ?? []).map((commit_id) => ({ user: { login: "cgwalters" }, state: "APPROVED", commit_id })));
        }
        return json({ state: "open", head: { sha: "a".repeat(40) } });
      }
      if (url.pathname.endsWith("/fields")) return json(fields());
      if (url.pathname === "/search/issues") return json({ items: [], total_count: 0 });
      if (url.pathname === "/repos/cgwalters-forge/operator/issues/1") return json({ body: "" });
      if (url.pathname.startsWith("/repos/cgwalters-forge/tracker/issues/") && /\/issues\/\d+$/.test(url.pathname)) {
        const n = url.pathname.split("/").at(-1);
        return json({ title: `Issue ${n}`, body: `Q: Ask ${n}?`, state: "open", html_url: `https://github.com/cgwalters-forge/tracker/issues/${n}`, labels: (holds.labels ?? ["needs-human"]).map((name) => ({ name })) });
      }
      if (url.pathname === "/graphql") {
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        if (query.includes("issueOrPullRequest")) return json({ data: { repository: { issueOrPullRequest: { comments: { nodes: [] } } } } });
        if (query.includes("comments(first")) return json({ data: { repository: { issue: { state: "OPEN", comments: { nodes: [1, 2].map(proposalComment), pageInfo: { hasNextPage: false } } } } } });
        return json({ data: {} });
      }
      return json([]);
    },
  });
  await import(`../src/github/main.ts?needsyou=${runs++}`);
  const doc = window.document;
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 300; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out waiting for ${what}: ${doc.querySelector("#view")?.textContent}`);
  };
  await until(() => !!doc.querySelector(".signin"), "sign-in");
  doc.querySelector<HTMLInputElement>(".signin input[type=password]")!.value = ["ghp", "x".repeat(24)].join("_");
  doc.querySelector(".signin")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  const app = {
    window, doc, reads, until,
    note: () => doc.querySelector(".published")?.textContent ?? "",
    keys: () => [...doc.querySelectorAll(".inbox-cards > .card")].map((c) => c.getAttribute("data-key")),
    count: () => doc.querySelector("#sec-needs summary .count, #sec-needs summary [class*=count]")?.textContent ?? "",
    empty: () => doc.querySelector<HTMLElement>("#sec-needs .empty")!.hidden === false,
    /** Let the clock run `ms` and bring the page back to the front, as a phone does. */
    wake: async (ms: number) => {
      t.mock.timers.setTime(Date.now() + ms);
      const before = reads.holds.length;
      window.dispatchEvent(new window.Event("focus"));
      await until(() => reads.holds.length > before, "the holds read after waking");
      await settle();
    },
    reload: async () => {
      const before = reads.holds.length;
      doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "r", bubbles: true }));
      await until(() => reads.holds.length > before, "the holds read after r");
      await settle();
    },
    close: async () => {
      doc.querySelector<HTMLButtonElement>("#signout")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      dom.window.close();
    },
  };
  await until(() => !!doc.querySelector(".published") && !app.note().startsWith("Reading"), "the published list");
  await settle();
  return app;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const listed = (at: number, items: unknown[], over: Record<string, unknown> = {}) => [holdsComment(iso(at), rawNeedsYou(items, iso(at), over))];

describe("Needs you from the pass's published list", () => {
  const approval = (n: number, digest = false) => rawAsk(n, { key: `up/proj#${n}${digest ? "/digest" : ""}`, item: `up/proj#${n}`, kind: digest ? "digest-approve" : "review-approve", source: digest ? "digest" : "reviews", action: { type: "approve_pull_request", repository: "up/proj", number: n, head: "a".repeat(40) } });

  for (const same of [true, false]) it(`after reload, ${same ? "skips a current" : "writes past an older"} viewer approval`, async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [approval(7)]), approvals: { 7: [(same ? "a" : "b").repeat(40)] } };
    const app = await boot(t, holds);
    try {
      await app.reload();
      assert.deepEqual(app.reads.reviews, [], "no approval reads on poll or reload");
      await app.until(() => !!app.doc.querySelector(".card-body button"), "approval button");
      app.doc.querySelector<HTMLButtonElement>(".card-body button")!.click();
      await app.until(() => !!app.doc.querySelector("[data-sent]"), "approval result");
      assert.deepEqual(app.reads.writes, same ? [] : ["POST /repos/up/proj/pulls/7/reviews"]);
      assert.match(app.doc.querySelector(".card")!.textContent!, same ? /already approved at HEAD/ : /Approved:/);
      assert.ok(app.doc.querySelector(".card-done button:disabled"));
      await app.reload();
      assert.ok(app.doc.querySelector(".card-done button:disabled"), "done receipt survives reload");
    } finally { await app.close(); }
  });

  it("reports skipped, written and failed digest items separately", async (t) => {
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [7, 8, 9].map((n) => approval(n, true))), approvals: { 7: ["a".repeat(40)], 8: ["b".repeat(40)] }, fail: 9 });
    try {
      app.doc.querySelector<HTMLButtonElement>(".maintain-sec button")!.click();
      await app.until(() => !!app.doc.querySelector(".maintain-results .failed"), "partial batch");
      const results = app.doc.querySelector(".maintain-results")!.textContent!;
      assert.match(results, /Skipped: up\/proj#7 already approved at HEAD/);
      assert.match(results, /Approved up\/proj#8/);
      assert.match(results, /Failed or uncertain: up\/proj#9/);
      assert.deepEqual(app.reads.writes, ["POST /repos/up/proj/pulls/8/reviews", "POST /repos/up/proj/pulls/9/reviews"]);
      assert.deepEqual([...app.doc.querySelectorAll<HTMLInputElement>(".maintain-sec input[type=checkbox]")].map((b) => [b.checked, b.disabled]), [[false, true], [false, true], [true, false]]);
    } finally { await app.close(); }
  });

  for (const overlapping of [true, false]) it(`shares ${overlapping ? "an in-flight" : "a completed but still unread"} approval across single and digest cards`, async (t) => {
    let release = () => {};
    const writeGate = new Promise<void>((resolve) => { release = resolve; });
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [approval(7), approval(7, true)]), ...(overlapping ? { writeGate } : {}) });
    try {
      await app.until(() => !!app.doc.querySelector(".c-approve button"), "single approval");
      app.doc.querySelector<HTMLButtonElement>(".c-approve button")!.click();
      await app.until(() => app.reads.writes.length === 1, "first approval write");
      if (!overlapping) await app.until(() => !!app.doc.querySelector(".c-approve [data-sent]"), "completed approval");
      app.doc.querySelector<HTMLButtonElement>(".c-digest button")!.click();
      await settle();
      assert.equal(app.reads.writes.length, 1, "the other card must not post while the first is in flight or lagging");
      release();
      await app.until(() => !!app.doc.querySelector(".maintain-results .skipped"), "deduplicated digest result");
      assert.match(app.doc.querySelector(".maintain-results")!.textContent!, /already approved at HEAD/);
      assert.deepEqual(app.reads.reviews, [7], "the shared receipt bridges the unread write");
    } finally { release(); await app.close(); }
  });

  for (const capped of [true, false]) it(`refuses approval when reviews are ${capped ? "capped" : "unreadable"}`, async (t) => {
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [approval(7)]), ...(capped ? { approvals: { 7: Array(100).fill("b".repeat(40)) } } : { reviewError: 502 }) });
    try {
      await app.until(() => !!app.doc.querySelector(".card-body button"), "approval button");
      app.doc.querySelector<HTMLButtonElement>(".card-body button")!.click();
      await app.until(() => /Not sent/.test(app.doc.querySelector(".card [role=status]")?.textContent ?? ""), "read refusal");
      assert.deepEqual(app.reads.writes, []);
      assert.match(app.doc.querySelector(".card [role=status]")!.textContent!, capped ? /Reviews exceed one page/ : /reviews unavailable/);
    } finally { await app.close(); }
  });

  for (const removed of [false, true]) it(`refuses review-needs-human release with ${removed ? "a removed" : "no"} label before commenting`, async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(7, { kind: "review-needs-human", action: { type: "pull_request", repository: "cgwalters-forge/tracker", number: 7 } })]), labels: removed ? ["needs-human"] : [] };
    const app = await boot(t, holds);
    try {
      await app.until(() => !!app.doc.querySelector(".card textarea"), "answer form");
      holds.labels = [];
      app.doc.querySelector<HTMLTextAreaElement>(".card textarea")!.value = "Proceed";
      app.doc.querySelector(".card form")!.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
      await app.until(() => /not answering|hold is no longer present/.test(app.doc.querySelector(".card [role=status]")?.textContent ?? ""), "release refusal");
      assert.deepEqual(app.reads.writes, []);
    } finally { await app.close(); }
  });

  it("shows a complete current list in the pass's order and count, and an empty one as caught up", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0 - 5 * MINUTE, [rawAsk(9, { priority: "P2" }), rawAsk(3, { priority: "P0" })]) };
    const app = await boot(t, holds);
    try {
      assert.deepEqual(app.keys(), ["cgwalters-forge/tracker#9", "cgwalters-forge/tracker#3"], "the pass ranks; the app doesn't");
      assert.equal(app.count(), "2");
      assert.match(app.note(), /^The pass's list: confirmed 5m ago/);
      assert.equal(app.empty(), false);
      holds.comments = listed(T0, []);
      holds.etag = '"b"';
      await app.wake(2 * MINUTE);
      assert.deepEqual([app.keys(), app.count(), app.empty()], [[], "0", true]);
    } finally { await app.close(); }
  });

  it("says what an incomplete list lacks, and never that nothing waits", async (t) => {
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [], { complete: false, sources: { epics: "complete", items: "partial", reviews: "unread", proposals: "complete", digest: "off" } }) });
    try {
      assert.match(app.note(), /Incomplete \(items partial, reviews unread\): more may wait on you\./);
      assert.deepEqual([app.count(), app.empty()], ["0", false]);
    } finally { await app.close(); }
  });

  it("does not call unknown source values complete", async (t) => {
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [], { sources: { items: "complete", reviews: "new-value" } }) });
    try {
      assert.match(app.note(), /Incomplete/);
      assert.equal(app.empty(), false);
    } finally { await app.close(); }
  });

  it("dates the list by the pass, not by GitHub's 304: an old list stays old however often it is confirmed", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0 - 3 * 60 * MINUTE, []) };
    const app = await boot(t, holds);
    try {
      assert.match(app.note(), /confirmed 3h ago.*checked on GitHub just now\. The pass has not confirmed it for over an hour/);
      assert.equal(app.empty(), false, "an empty list the pass stopped confirming is not caught up");
      await app.wake(2 * MINUTE);
      assert.equal(app.reads.holds.at(-1), '"a"', "a conditional read");
      assert.match(app.note(), /confirmed 3h ago.*checked on GitHub just now\. The pass has not confirmed it/);
      assert.equal(app.empty(), false);
    } finally { await app.close(); }
  });

  it("keeps the cards of a list it can't read again, marked unavailable, and recovers on the next read", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(1), rawAsk(2)]) };
    const app = await boot(t, holds);
    try {
      holds.status = 502;
      await app.wake(2 * MINUTE);
      assert.deepEqual(app.keys(), ["cgwalters-forge/tracker#1", "cgwalters-forge/tracker#2"]);
      assert.equal(app.doc.querySelectorAll(".card-unavailable").length, 2);
      assert.match(app.note(), /^Couldn't read the pass's snapshot: .*marked unavailable until it can be read again\./);
      assert.equal(app.empty(), false);
      holds.status = 200;
      holds.comments = listed(Date.now(), [rawAsk(2)]);
      holds.etag = '"b"';
      await app.wake(2 * MINUTE);
      assert.deepEqual([app.keys(), app.doc.querySelectorAll(".card-unavailable").length], [["cgwalters-forge/tracker#2"], 0]);
      assert.match(app.note(), /^The pass's list: confirmed/);
    } finally { await app.close(); }
  });

  it("shows an older pass's operator holds when the snapshot has no list, and says what isn't listed", async (t) => {
    const at = iso(T0);
    const human = { item: "cgwalters-forge/tracker#446", url: "https://github.com/cgwalters-forge/tracker/issues/446", epic: false, kind: "needs-human", reason: "labelled needs-human", operator: true, priority: "P0", question: "Ship it?" };
    const wip = { item: null, url: null, epic: false, kind: "wip", reason: "2 of 2 runs active", operator: false, priority: null, question: null };
    const old = { user: { login: "cgwalters-bot" }, body: `<!-- agent-board-holds v1 -->\n\n\`\`\`json\n${JSON.stringify({ schema: "agent-board/holds/v1", at, holds: [wip, human] })}\n\`\`\`\n` };
    const app = await boot(t, { status: 200, etag: '"a"', comments: [old] });
    try {
      assert.deepEqual(app.keys(), ["cgwalters-forge/tracker#446"]);
      assert.match(app.note(), /no needs-you list.*Shown: the snapshot's own operator holds; review waits, proposals and digest asks are not listed\./);
      assert.equal(app.empty(), false);
    } finally { await app.close(); }
  });

  it("keeps unavailable old cards alongside new snapshot holds after the list disappears", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(1)]) };
    const app = await boot(t, holds);
    try {
      holds.comments = [holdsComment(iso(T0), undefined, [{ item: "cgwalters-forge/tracker#9", url: "https://github.com/cgwalters-forge/tracker/issues/9", epic: false, kind: "needs-human", reason: "new hold", operator: true, priority: "P0", question: "New ask" }])];
      holds.etag = '"b"';
      await app.wake(2 * MINUTE);
      assert.deepEqual(app.keys(), ["cgwalters-forge/tracker#1", "cgwalters-forge/tracker#9"]);
      assert.equal(app.doc.querySelectorAll(".card-unavailable").length, 1);
      assert.match(app.doc.querySelector('[data-key="cgwalters-forge/tracker#9"]')!.textContent!, /New ask/);
      holds.status = 502;
      for (let poll = 0; poll < 2; poll++) {
        await app.wake(2 * MINUTE);
        assert.deepEqual(app.keys(), ["cgwalters-forge/tracker#1", "cgwalters-forge/tracker#9"]);
        assert.equal(app.doc.querySelectorAll(".card-unavailable").length, 2);
      }
    } finally { await app.close(); }
  });

  it("gives each proposal its own card, each read again from its comment", async (t) => {
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [proposal(1), proposal(2)]) });
    try {
      await app.until(() => app.doc.querySelectorAll(".card button").length >= 2, "both proposals' Run buttons");
      assert.deepEqual(app.keys(), ["cgwalters-forge/tracker#1013/comment-1", "cgwalters-forge/tracker#1013/comment-2"]);
      for (const n of [1, 2]) assert.match(app.doc.querySelector(`[data-key="cgwalters-forge/tracker#1013/comment-${n}"]`)!.textContent!, new RegExp(`Reason ${n}`));
      assert.deepEqual(app.reads.writes, [], "nothing written");
    } finally { await app.close(); }
  });

  it("says when not every summary was read, showing the ask the pass fell back to", async (t) => {
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(5, { ask: "labelled needs-human" })], { summaries: "partial" }) });
    try {
      assert.match(app.note(), /Not every summary was read: some asks show the board's question or the hold's reason\./);
      assert.match(app.doc.querySelector(".card .title")!.textContent!, /labelled needs-human/);
    } finally { await app.close(); }
  });

  it("keeps a card with unsent text after the pass drops it, counted as shown, and a late read doesn't take it", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(1), rawAsk(2)]) };
    const app = await boot(t, holds);
    try {
      await app.until(() => !!app.doc.querySelector('[data-key="cgwalters-forge/tracker#1"] textarea'), "the answer form");
      const text = app.doc.querySelector<HTMLTextAreaElement>('[data-key="cgwalters-forge/tracker#1"] textarea')!;
      text.value = "Half an answer";
      // The next read is slow, and lands while he types.
      let release = () => {};
      holds.gate = new Promise((resolve) => { release = resolve; });
      holds.comments = listed(Date.now(), [rawAsk(2)]);
      holds.etag = '"b"';
      t.mock.timers.setTime(Date.now() + 2 * MINUTE);
      app.window.dispatchEvent(new app.window.Event("focus"));
      await app.until(() => app.reads.holds.length === 2, "the slow read");
      assert.equal(app.count(), "2");
      release();
      await app.until(() => !!app.doc.querySelector(".card-stale-note"), "the gone note");
      assert.deepEqual(app.keys().sort(), ["cgwalters-forge/tracker#1", "cgwalters-forge/tracker#2"], "kept where it was, the rest placed around it");
      assert.equal(app.doc.querySelector('[data-key="cgwalters-forge/tracker#1"] textarea'), text);
      assert.equal(text.value, "Half an answer");
      assert.equal(app.count(), "2", "the heading counts the kept card");
      assert.equal(app.doc.querySelector(".inbox-more"), null);
      delete holds.gate;
      await app.reload();
      assert.deepEqual([app.keys(), app.count()], [["cgwalters-forge/tracker#2"], "1"]);
    } finally { await app.close(); }
  });

  it("draws nothing from a read that lands after sign-out", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(1)]) };
    const app = await boot(t, holds);
    let release = () => {};
    holds.gate = new Promise((resolve) => { release = resolve; });
    holds.comments = listed(T0, [rawAsk(1), rawAsk(7)]);
    holds.etag = '"b"';
    t.mock.timers.setTime(Date.now() + 2 * MINUTE);
    app.window.dispatchEvent(new app.window.Event("focus"));
    await app.until(() => app.reads.holds.length === 2, "the slow read");
    app.doc.querySelector<HTMLButtonElement>("#signout")!.click();
    release();
    await settle();
    assert.equal(app.doc.querySelector('[data-key="cgwalters-forge/tracker#7"]'), null);
    app.window.close();
  });
});
