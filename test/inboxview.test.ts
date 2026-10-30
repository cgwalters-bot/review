import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDocument } from "../src/github/decisiondocument.ts";
import { askCard, type Card, documentCard, publishedCards } from "../src/github/inbox.ts";
import { CARD_CHANGED_NOTE, CARD_GONE_NOTE, CARD_STALE_CLASS, CARD_UNAVAILABLE_CLASS, fillInbox, holdsDraft, INBOX_PAGE, type InboxHooks, passLine } from "../src/github/inboxview.ts";
import { ACTION_CONFIG, loadOffer } from "../src/github/actions.ts";
import { GitHub } from "../src/github/api.ts";
import { proposalCard } from "../src/github/actionsview.ts";
import type { Heartbeat } from "../src/github/heartbeat.ts";
import { type Ask, type Hold, parseNeedsYou } from "../src/github/holds.ts";
import { answerForm } from "../src/github/view.ts";
import { createRenderer } from "../src/markdown.ts";
import { installDom, rawAsk, rawNeedsYou } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);

const sent: string[] = [];
const hooks: InboxHooks = {
  now: Date.parse("2026-10-25T12:00:00Z"),
  render,
  mayAct: true,
  // As main.ts's: the target's question read, with the form that answers it.
  answerBody: async (a) => answerForm({ owner: "o", repo: "r", number: a.action.number }, { options: [{ letter: "A", text: "left", recommended: false }] }, false, async () => "https://github.com/o/r/issues/1#issuecomment-1", `card-${a.key}-`, 2),
  answerEntry: async (entry, letter, reply) => { sent.push(`${entry.id} ${letter} ${reply}`); },
};

/** The open entry `id` of a document, as a card, with `extra` added to its text. */
function entry(id: string, extra = ""): Card {
  return documentCard(parseDocument(`### ${id} Pick one\n${extra}- [ ] A) This\n- [ ] B) That\nReply:\n`)[0]!, undefined)!;
}

/** The published asks of `raw`, as parsed. */
function asks(...raw: Record<string, unknown>[]): Ask[] {
  const l = parseNeedsYou(rawNeedsYou(raw, "2026-10-25T11:30:00Z"));
  assert.ok(typeof l === "object", String(l));
  return l.items;
}

/** A hold the pass lists, answered in place. */
const question = (n = 1): Card => askCard(asks(rawAsk(n, { ask: "Which way?" }))[0]!);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const cardOf = (list: HTMLElement, key: string) => list.querySelector<HTMLElement>(`[data-key="${key}"]`);
const keys = (list: HTMLElement) => [...list.children].map((c) => c.getAttribute("data-key"));

/** Type into a card's form as he would, without sending. */
const drafts: [string, (card: HTMLElement) => void][] = [
  ["a picked option", (card) => { card.querySelector<HTMLInputElement>("input[type=radio]")!.checked = true; }],
  ["a reply", (card) => { card.querySelector<HTMLInputElement>("input[type=text]")!.value = "not yet"; }],
];

describe("fillInbox", () => {
  it("draws three proposals the pass lists on one issue as separate cards with title, why and Run", async () => {
    const config = ACTION_CONFIG;
    assert.ok(config);
    const comments = [1, 2, 3].map((n) => ({ id: `IC_${n}`, databaseId: n, updatedAt: "2026-10-29T12:00:00Z", author: { login: "cgwalters-bot" }, editor: null, lastEditedAt: null,
      body: `\`\`\`agent-board-action\n${JSON.stringify({ schema: "agent-board/operator-action/v1", title: `Decision ${n}`, why: `Reason ${n}`, actions: [{ type: "add_label", repo: "cgwalters-forge/tracker", number: 1013, label: `choice-${n}` }] })}\n\`\`\`` }));
    const gh = new GitHub(async () => "t", async (url) => {
      if (url.endsWith("/graphql")) return Response.json({ data: { repository: { issue: { state: "OPEN", comments: { nodes: comments, pageInfo: { hasNextPage: false } } } } } });
      if (url.endsWith("/issues/1013")) return Response.json({ title: "Epic decisions", state: "open", labels: [] });
      throw new Error(`Unexpected read: ${url}`);
    });
    const proposal = (n: number) => rawAsk(1013, { key: `cgwalters-forge/tracker#1013/comment-${n}`, source: "proposals", kind: "operator-action", ask: `Decision ${n}`, action: { type: "operator_action", repository: "cgwalters-forge/tracker", number: 1013, comment: n } });
    const list = document.createElement("div");
    // As main.ts's offerBody: each card reads its own proposal again.
    fillInbox(list, publishedCards(asks(proposal(1), proposal(2), proposal(3))), { ...hooks, offerBody: async (a) => proposalCard(gh, config, await loadOffer(gh, config, a.action), () => false, () => {}) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const n of [1, 2, 3]) {
      const card = cardOf(list, `cgwalters-forge/tracker#1013/comment-${n}`)!;
      assert.match(card.textContent!, new RegExp(`Reason ${n}`));
      const run = [...card.querySelectorAll("button")].filter((b) => b.textContent === "Run as yourself");
      assert.equal(run.length, 1);
      assert.equal(run[0]!.disabled, false);
    }
  });

  it("leaves an unchanged card as the node it is, and redraws a changed one with nothing typed", () => {
    const list = document.createElement("div");
    fillInbox(list, [entry("D1"), entry("D2")], hooks);
    const [d1, d2] = [cardOf(list, "document:D1"), cardOf(list, "document:D2")];
    fillInbox(list, [entry("D1"), entry("D2", "Context changed.\n")], hooks);
    assert.equal(cardOf(list, "document:D1"), d1);
    assert.notEqual(cardOf(list, "document:D2"), d2);
    assert.match(cardOf(list, "document:D2")!.textContent!, /Context changed/);
  });

  for (const [what, type] of drafts) {
    it(`never redraws a changed card holding ${what}; r does`, () => {
      const list = document.createElement("div");
      fillInbox(list, [entry("D1")], hooks);
      const card = cardOf(list, "document:D1")!;
      type(card);
      assert.ok(holdsDraft(card));
      fillInbox(list, [entry("D1", "Context changed.\n")], hooks);
      assert.equal(cardOf(list, "document:D1"), card);
      assert.ok(card.classList.contains(CARD_STALE_CLASS));
      assert.equal(card.querySelector("[role=status].card-stale-note")?.textContent, CARD_CHANGED_NOTE);
      assert.doesNotMatch(card.textContent!, /Context changed/);
      fillInbox(list, [entry("D1", "Context changed.\n")], hooks, true);
      assert.notEqual(cardOf(list, "document:D1"), card);
      assert.match(cardOf(list, "document:D1")!.textContent!, /Context changed/);
    });

    it(`keeps a card holding ${what} once its thing left, until it is cleared`, () => {
      const list = document.createElement("div");
      fillInbox(list, [entry("D1"), entry("D2")], hooks);
      const card = cardOf(list, "document:D1")!;
      type(card);
      fillInbox(list, [entry("D2")], hooks);
      assert.equal(cardOf(list, "document:D1"), card);
      assert.equal(card.querySelector(".card-stale-note")?.textContent, CARD_GONE_NOTE);
      for (const input of card.querySelectorAll<HTMLInputElement>("input")) {
        input.checked = false;
        input.value = "";
      }
      fillInbox(list, [entry("D2")], hooks);
      assert.equal(cardOf(list, "document:D1"), null);
    });
  }

  it("keeps a half-written answer to an ask the same way, and counts it while it is kept", async () => {
    const list = document.createElement("div");
    const q = question();
    assert.equal(fillInbox(list, [q, question(2)], hooks), 2);
    await settle();
    const card = cardOf(list, "cgwalters-forge/tracker#1")!;
    card.querySelector("textarea")!.value = "Left, because";
    assert.equal(fillInbox(list, [{ ...q, title: "Which way now?" }, question(2)], hooks), 2);
    assert.equal(cardOf(list, "cgwalters-forge/tracker#1"), card);
    assert.equal(card.querySelector("textarea")!.value, "Left, because");
    // The pass dropped it: still on the page under his text, so still counted.
    assert.equal(fillInbox(list, [question(2)], hooks), 2);
    assert.equal(card.querySelector(".card-stale-note")?.textContent, CARD_GONE_NOTE);
    assert.equal(fillInbox(list, [question(2)], hooks, true), 1, "r drops it");
  });

  it("marks a card from a list that can't be read now", () => {
    const list = document.createElement("div");
    fillInbox(list, publishedCards(asks(rawAsk(1)), true), hooks);
    const card = cardOf(list, "cgwalters-forge/tracker#1")!;
    assert.ok(card.classList.contains(CARD_UNAVAILABLE_CLASS));
    assert.match(card.textContent!, /Unavailable: from the last list read/);
  });

  it("offers the pass's head without a drawing-time read", async () => {
    const head = "a".repeat(40);
    const approval = askCard(asks(rawAsk(4, { key: "up/proj#4", item: "up/proj#4", kind: "review-approve", action: { type: "approve_pull_request", repository: "up/proj", number: 4, head } }))[0]!);
    const list = document.createElement("div");
    fillInbox(list, [approval], { ...hooks, approve: async () => "https://github.com/up/proj/pull/4#pullrequestreview-1" });
    await settle();
    assert.equal(list.querySelector("button")?.textContent, "Approve aaaaaaa");
  });

  it("doesn't redraw or move a card whose empty field has the focus", () => {
    const list = document.createElement("div");
    document.body.append(list);
    fillInbox(list, [entry("D1"), entry("D2")], hooks);
    const card = cardOf(list, "document:D2")!;
    const reply = card.querySelector<HTMLInputElement>("input[type=text]")!;
    reply.focus();
    fillInbox(list, [entry("D2", "Context changed.\n"), entry("D1", "Also changed.\n")], hooks);
    assert.equal(cardOf(list, "document:D2"), card);
    assert.equal(document.activeElement, reply);
    // D1 moved, around it.
    assert.deepEqual(keys(list), ["document:D2", "document:D1"]);
    assert.match(cardOf(list, "document:D1")!.textContent!, /Also changed/);
    list.remove();
  });

  it("places new cards around a kept draft without moving it", () => {
    const list = document.createElement("div");
    fillInbox(list, [entry("D2")], hooks);
    const card = cardOf(list, "document:D2")!;
    type(card);
    fillInbox(list, [entry("D1"), entry("D2"), entry("D3")], hooks);
    assert.deepEqual(keys(list), ["document:D1", "document:D2", "document:D3"]);
    assert.equal(cardOf(list, "document:D2"), card);
    function type(c: HTMLElement) { c.querySelector<HTMLInputElement>("input[type=text]")!.value = "x"; }
  });

  it("redraws a card once its form was sent", async () => {
    const list = document.createElement("div");
    fillInbox(list, [entry("D1")], hooks);
    const card = cardOf(list, "document:D1")!;
    card.querySelector<HTMLInputElement>("input[value=B]")!.checked = true;
    card.querySelector<HTMLInputElement>("input[type=text]")!.value = "later";
    card.querySelector("form")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, ["D1 B later"]);
    assert.ok(!holdsDraft(card));
    const answered = documentCard(parseDocument("### D1 Pick one\n- [ ] A) This\n- [x] B) That\nReply: later\n")[0]!, undefined)!;
    fillInbox(list, [answered], hooks);
    assert.notEqual(cardOf(list, "document:D1"), card);
    assert.ok(cardOf(list, "document:D1")!.classList.contains("card-done"));
    assert.equal(cardOf(list, "document:D1")!.querySelector("form"), null);
  });

  it("draws the first page of cards, reading only their proposals, and the rest on Show more", () => {
    const read: number[] = [];
    const offerBody = async (a: Ask) => {
      read.push(a.action.comment!);
      return document.createElement("section");
    };
    const raw = Array.from({ length: INBOX_PAGE + 2 }, (_, i) => rawAsk(9, { key: `cgwalters-forge/tracker#9/comment-${i + 1}`, kind: "operator-action", action: { type: "operator_action", repository: "cgwalters-forge/tracker", number: 9, comment: i + 1 } }));
    const box = document.createElement("div");
    const list = document.createElement("div");
    box.append(list);
    assert.equal(fillInbox(list, publishedCards(asks(...raw)), { ...hooks, offerBody }), INBOX_PAGE + 2);
    assert.deepEqual([keys(list).length, read], [INBOX_PAGE, Array.from({ length: INBOX_PAGE }, (_, i) => i + 1)]);
    const more = box.querySelector<HTMLButtonElement>(".inbox-more")!;
    assert.equal(more.textContent, `Show 2 more · ${INBOX_PAGE} of ${INBOX_PAGE + 2} shown`);
    more.click();
    assert.deepEqual([keys(list).length, read.length, box.querySelector(".inbox-more")], [INBOX_PAGE + 2, INBOX_PAGE + 2, null]);
  });
});

describe("passLine", () => {
  const pool: Hold = { item: null, url: null, epic: false, kind: "pool", reason: "claude over pace", operator: false, priority: null, question: null };
  const human = { ...pool, item: "o/r#1", url: "https://github.com/o/r/issues/1", kind: "needs-human", reason: "labelled needs-human", operator: true };
  const ago = (minutes: number) => new Date(hooks.now - minutes * 60_000).toISOString();
  const beat = (minutes: number): Heartbeat => ({ updatedAt: ago(minutes), session: "s", loopState: "polling", workers: [], skipped: 0 });
  // name, holds (written 2h ago: the pass rewrites them only on a change), heartbeat, the line or null, whether it warns
  const cases: [string, Hold[] | undefined, Heartbeat | null | undefined, string | null, boolean][] = [
    ["old holds with a fresh heartbeat are current", [pool, human], beat(5), "New runs wait: pool: claude over pace", false],
    ["a stale heartbeat", [pool], beat(60), "New runs wait: pool: claude over pace · the pass's heartbeat is stale", true],
    ["no heartbeat published", [pool], null, "New runs wait: pool: claude over pace · the pass's heartbeat is stale", true],
    ["nothing when no pool is held", [human], beat(60), null, false],
    ["nothing when the holds weren't read", undefined, beat(5), null, false],
  ];
  for (const [name, holds, hb, text, warn] of cases) it(name, () => {
    const el = passLine(holds && { at: ago(120), holds }, hb, hooks.now);
    assert.deepEqual([el?.textContent ?? null, el?.classList.contains("warn") ?? false], [text, warn]);
  });
});

describe("card layout at phone and desktop widths (no layout engine)", () => {
  for (const width of [390, 1280]) it(`puts a card's actions on one row at ${width}px`, async () => {
    Object.defineProperty(win, "innerWidth", { value: width, configurable: true });
    const list = document.createElement("div");
    const link = askCard(asks(rawAsk(3, { key: "up/proj#3/digest", item: "up/proj#3", kind: "digest-stale", action: { type: "close_pull_request", repository: "up/proj", number: 3 } }))[0]!);
    fillInbox(list, [question(), link], hooks);
    await settle();
    for (const card of list.children) {
      assert.ok(card.querySelectorAll(".actions").length <= 1, "at most one action row");
      assert.equal(card.querySelector(".item-chat"), null, "no dead Chat control");
      assert.ok(card.querySelector("button[type=submit], a.action"));
    }
  });
});
