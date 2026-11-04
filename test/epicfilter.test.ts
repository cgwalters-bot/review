import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { epicChips, epicChoice, epicSelection, saveEpicChoice } from "../src/github/epicfilter.ts";
import { parseNeedsYou } from "../src/github/holds.ts";
import { publishedCards } from "../src/github/inbox.ts";
import { fillInbox, type InboxHooks } from "../src/github/inboxview.ts";
import { parseRoute } from "../src/github/keys.ts";
import { createRenderer } from "../src/markdown.ts";
import { fixture, installDom, rawAsk, rawNeedsYou } from "./helpers.ts";

const win = installDom();
const extension = fixture<{ epics: unknown[]; items: Record<string, unknown>[] }>("needs-you-661.json");
const raw = { ...rawNeedsYou(extension.items.map((item: Record<string, unknown>, i: number) => rawAsk(i + 1, item)), "2026-11-04T12:00:00Z"), epics: extension.epics };
const parsed = parseNeedsYou(raw);
assert.ok(typeof parsed === "object");
const cards = publishedCards(parsed.items);
const hooks: InboxHooks = { now: Date.parse(parsed.validatedAt), mayAct: true, render: createRenderer(win as unknown as Parameters<typeof createRenderer>[0]), answerEntry: async () => {} };

test("661 fixture: active default, focus first, cross-repo ancestry and honest chip counts", () => {
  const model = epicSelection(cards, parsed.epics, "active");
  assert.equal(model.selected.length, 3);
  assert.equal(model.hidden, 3);
  assert.equal(model.active[0]?.item, "cgwalters-forge/tracker#976");
  assert.deepEqual(model.ordered.slice(0, 3).map((c) => c.key), [cards[1]!.key, cards[0]!.key, cards[2]!.key]);
  assert.equal(model.count("other"), 2);
  assert.equal(model.count("none"), 1);
  assert.equal(model.count("all"), 6);
  let chosen = "";
  const chips = epicChips(model, "active", true, (f) => { chosen = f; });
  assert.match(chips.textContent!, /2 epics in progress.*epics.focus/);
  assert.match(chips.textContent!, /Focus: Operator inbox · 2/);
  assert.match(chips.textContent!, /Other epics \/ unknown · 2/);
  assert.match(chips.textContent!, /No epic · 1/);
  chips.querySelectorAll<HTMLButtonElement>("button")[5]!.click();
  assert.equal(chosen, "all");
});

test("unknown metadata does not default-hide legacy asks; malformed activity fails open", () => {
  for (const epics of [undefined, {}, [...extension.epics, extension.epics[0]], [{ item: "bad" }]]) {
    const p = parseNeedsYou({ ...raw, epics });
    assert.ok(typeof p === "object");
    assert.equal(p.epics, undefined);
    assert.equal(epicSelection(cards, p.epics, "active").selected.length, 6);
  }
  assert.equal(epicSelection(cards, [], "active").selected.length, 0);
});

test("bare epic links and viewer-specific choices survive blocked storage", () => {
  assert.deepEqual(parseRoute("#epic-976"), { route: "home", view: "inbox" });
  assert.equal(epicChoice("one", "#epic-976"), "epic:cgwalters-forge/tracker#976");
  const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storageWindow = new JSDOM("", { url: "https://example.test" }).window;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storageWindow.localStorage });
  saveEpicChoice("one", "none");
  saveEpicChoice("two", "all");
  assert.equal(epicChoice("ONE", ""), "none");
  assert.equal(epicChoice("two", ""), "all");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  assert.doesNotThrow(() => saveEpicChoice("one", "all"));
  assert.equal(epicChoice("one", ""), "active");
  if (old) Object.defineProperty(globalThis, "localStorage", old);
  else Reflect.deleteProperty(globalThis, "localStorage");
  storageWindow.close();
});

test("compact approval row submits the published head; answer body is collapsed", async () => {
  const list = document.createElement("div");
  const calls: string[] = [];
  win.confirm = () => true;
  fillInbox(list, cards, { ...hooks, approve: async (_a, head) => { calls.push(head); return "https://github.com/example/repo/pull/1#review"; }, answerBody: async () => document.createElement("form") });
  const row = list.querySelector<HTMLElement>("article.c-approve")!;
  assert.match(row.textContent!, /Controller: publish approval-only requests/);
  assert.match(row.textContent!, /\+42 −8.*CI: success.*Review agent: approved/);
  row.querySelector<HTMLButtonElement>("button")!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["a".repeat(40)]);
  assert.match(row.textContent!, /checks and merge policy still decide/);
  assert.equal(list.querySelector<HTMLDetailsElement>(".card-full")!.open, false);
});

test("filter changes preserve unsent forms without counting or retiring filtered-out cards", () => {
  const host = document.createElement("div");
  const list = document.createElement("div");
  host.append(list);
  document.body.append(host);
  fillInbox(list, cards, hooks);
  const first = list.firstElementChild as HTMLElement;
  const input = document.createElement("input");
  input.type = "text";
  input.value = "unsent";
  const form = document.createElement("form");
  form.append(input);
  first.append(form);
  const only = new Set([cards[1]!.key]);
  assert.equal(fillInbox(list, cards, hooks, false, only), 1);
  assert.equal(first.hidden, true);
  assert.equal(input.value, "unsent");
  assert.equal(first.querySelector(".card-stale-note"), null);
  fillInbox(list, cards, hooks);
  assert.equal(first.hidden, false);
  assert.equal(input.value, "unsent");
  host.remove();
});
