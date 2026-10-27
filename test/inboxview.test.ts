import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDocument } from "../src/github/decisiondocument.ts";
import { type Card, documentCard, needCard } from "../src/github/inbox.ts";
import { CARD_CHANGED_NOTE, CARD_GONE_NOTE, CARD_STALE_CLASS, fillInbox, holdsDraft, INBOX_PAGE, type InboxHooks, passLine } from "../src/github/inboxview.ts";
import type { Offered } from "../src/github/actions.ts";
import type { Item } from "../src/github/board.ts";
import type { Heartbeat } from "../src/github/heartbeat.ts";
import type { Hold } from "../src/github/holds.ts";
import { createRenderer } from "../src/markdown.ts";
import { installDom } from "./helpers.ts";
import { ITEM_CHAT_EVENT, type ChatItem } from "../src/github/chatitem.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);

const sent: string[] = [];
const hooks: InboxHooks = {
  now: Date.parse("2026-10-25T12:00:00Z"),
  render,
  mayAct: true,
  sendNeed: async () => "https://github.com/o/r/issues/1#issuecomment-1",
  answerEntry: async (entry, letter, reply) => { sent.push(`${entry.id} ${letter} ${reply}`); },
};

/** The open entry `id` of a document, as a card, with `extra` added to its text. */
function entry(id: string, extra = ""): Card {
  return documentCard(parseDocument(`### ${id} Pick one\n${extra}- [ ] A) This\n- [ ] B) That\nReply:\n`)[0]!, undefined)!;
}

function question(): Card {
  const item: Item = { id: 1, nodeId: "I_1", kind: "issue", title: "Which way?", url: "https://github.com/o/r/issues/1", ref: { owner: "o", repo: "r", number: 1 }, state: "open", body: "Q: which way?\nOptions:\nA) left\nB) right\n", why: "", branch: [], gist: [], labels: ["question"], assignees: ["cgwalters"] };
  return needCard({ key: "item:I_1", action: "answer", title: item.title, where: "o/r#1", href: "#item/I_1", inPlace: true, entry: { key: "item:I_1", kind: "item", title: item.title, where: "o/r#1", href: "#item/I_1", item } })!;
}

const cardOf = (list: HTMLElement, key: string) => list.querySelector<HTMLElement>(`[data-key="${key}"]`);
const keys = (list: HTMLElement) => [...list.children].map((c) => c.getAttribute("data-key"));

/** Type into a card's form as he would, without sending. */
const drafts: [string, (card: HTMLElement) => void][] = [
  ["a picked option", (card) => { card.querySelector<HTMLInputElement>("input[type=radio]")!.checked = true; }],
  ["a reply", (card) => { card.querySelector<HTMLInputElement>("input[type=text]")!.value = "not yet"; }],
];

describe("fillInbox", () => {
  it("adds Chat to cards without consuming their unsent forms", () => {
    const list = document.createElement("div");
    fillInbox(list, [question(), documentCard(parseDocument("### D1 Pick one\nAbout: o/r#2\n- [ ] A) This\nReply:\n")[0]!, undefined)!], hooks);
    assert.equal(list.querySelectorAll("button.item-chat").length, 2);
    const card = cardOf(list, "item:I_1")!;
    card.querySelector("textarea")!.value = "Unsent answer";
    card.querySelector<HTMLButtonElement>(".item-chat")!.click();
    assert.equal(card.querySelector("textarea")!.value, "Unsent answer");
    assert.equal(card.querySelector<HTMLButtonElement>(".item-chat")!.type, "button");
  });

  it("keeps the board item's pool in Answer and Approve chat requests", () => {
    for (const kind of ["answer", "approve"] as const) {
      const c = question();
      assert.ok(c.kind === "answer");
      c.need.entry!.item!.engine = "openai";
      const list = document.createElement("div");
      fillInbox(list, [{ ...c, kind }], hooks);
      let item: ChatItem | undefined;
      list.addEventListener(ITEM_CHAT_EVENT, (e) => { item = (e as CustomEvent<ChatItem>).detail; });
      list.querySelector<HTMLButtonElement>(".item-chat")!.click();
      assert.equal(item?.pool, "openai");
      assert.equal(item?.ref, "o/r#1");
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

  it("keeps a half-written answer to an ask the same way", () => {
    const list = document.createElement("div");
    const q = question();
    fillInbox(list, [q], hooks);
    const card = cardOf(list, "item:I_1")!;
    card.querySelector("textarea")!.value = "Left, because";
    fillInbox(list, [{ ...q, title: "Which way now?" }], hooks);
    assert.equal(cardOf(list, "item:I_1"), card);
    assert.equal(card.querySelector("textarea")!.value, "Left, because");
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
    const offerBody = async (o: Offered) => {
      read.push(o.issue);
      return document.createElement("section");
    };
    const offer = (issue: number): Offered => ({ issue, comment: { id: `IC_${issue}`, databaseId: issue, body: "", updatedAt: "2026-10-25T10:00:00Z", author: { login: "planner" }, editor: null, lastEditedAt: null }, proposal: { schema: "agent-board/operator-action/v1", title: `P${issue}`, why: "", actions: [] } });
    const cards = Array.from({ length: INBOX_PAGE + 2 }, (_, i) => ({ ...entry(`D${i + 1}`), offers: [offer(i + 1)] }));
    const box = document.createElement("div");
    const list = document.createElement("div");
    box.append(list);
    fillInbox(list, cards, { ...hooks, offerBody });
    assert.deepEqual([keys(list).length, read], [INBOX_PAGE, Array.from({ length: INBOX_PAGE }, (_, i) => i + 1)]);
    const more = box.querySelector<HTMLButtonElement>(".inbox-more")!;
    assert.equal(more.textContent, `Show 2 more · ${INBOX_PAGE} of ${INBOX_PAGE + 2} shown`);
    assert.equal(cardOf(list, "document:D1")!.querySelectorAll(".card-body").length, 1, "the decision carries its proposal");
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
  for (const width of [390, 1280]) it(`puts a card's actions on one row at ${width}px`, () => {
    Object.defineProperty(win, "innerWidth", { value: width, configurable: true });
    const list = document.createElement("div");
    const link = question();
    assert.ok(link.kind === "answer");
    fillInbox(list, [question(), { ...link, key: "item:I_2", need: { ...link.need, inPlace: false } }], hooks);
    for (const card of list.children) {
      const chat = card.querySelector(".item-chat")!;
      assert.equal(card.querySelectorAll(".actions").length, 1, "one row");
      assert.equal(chat.parentElement, card.querySelector(".actions"), "Chat on the row with the action");
      assert.ok(chat.parentElement!.querySelector("button[type=submit], a.action"));
    }
  });
});
