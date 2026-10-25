import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDocument } from "../src/github/decisiondocument.ts";
import { type Card, documentCard, needCard } from "../src/github/inbox.ts";
import { CARD_CHANGED_NOTE, CARD_GONE_NOTE, CARD_STALE_CLASS, fillInbox, holdsDraft, type InboxHooks } from "../src/github/inboxview.ts";
import type { Item } from "../src/github/board.ts";
import { createRenderer } from "../src/markdown.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);

const sent: string[] = [];
const hooks: InboxHooks = {
  now: Date.parse("2026-10-25T12:00:00Z"),
  render,
  mayAct: true,
  sendNeed: async () => "https://github.com/o/r/issues/1#issuecomment-1",
  answerEntry: async (entry, letter, reply) => { sent.push(`${entry.id} ${letter} ${reply}`); },
  rerun: async (r) => r.url,
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
});
