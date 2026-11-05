import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNeedsYou } from "../src/github/holds.ts";
import { inboxCards } from "../src/github/inbox.ts";
import { cardEl, cardSignature, fillInbox } from "../src/github/inboxview.ts";
import { fixture, installDom, rawAsk, rawNeedsYou } from "./helpers.ts";

installDom();
// Byte-for-byte producer fixture from agent-board#687 at 21c337c; not a live capture.
const contract = fixture<{ rows: { key: string; head: string }[]; approval_evidence: { schema: string; observed_at: string; omitted: number; items: Record<string, unknown> } }>("approval-evidence-needs-you.json");
const hooks = { now: Date.now(), mayAct: false, render: () => document.createDocumentFragment(), answerEntry: async () => {} };

function replay(e: unknown = contract.approval_evidence, extra = {}) {
  const list = parseNeedsYou({ ...rawNeedsYou(contract.rows.map((r, i) => rawAsk(i + 1, {
    key: r.key, item: r.key, kind: "review-approve", action: { type: "approve_pull_request", repository: "cgwalters-forge/tracker", number: Number(r.key.split("#")[1]), head: r.head }, ...extra,
  })), "2026-11-05T12:00:00Z"), approval_evidence: e });
  if (typeof list !== "object") throw new Error(list);
  return { list, cards: inboxCards({ published: { asks: list.items, list, unavailable: false } }) };
}
const rendered = (e: unknown, extra = {}) => cardEl(replay(e, extra).cards[0]!, hooks).textContent!;
const unknown = /Diff unknown · CI unknown · Review agent unknown/;
const entry = contract.approval_evidence.items[contract.rows[0]!.key] as Record<string, unknown>;
const withEntry = (patch: Record<string, unknown>) => ({ ...contract.approval_evidence, items: { [contract.rows[0]!.key]: { ...entry, ...patch } } });

test("shared producer serialization: current, partial, moved and evicted evidence", () => {
  const { list, cards } = replay();
  assert.equal(list.items.length, 4, "evidence eviction does not drop identities");
  assert.match(cardEl(cards[0]!, hooks).textContent!, /At a{12} · Diff \+12\/−3 · CI green · Review agent approved at .* · observed/);
  assert.match(cardEl(cards[1]!, hooks).textContent!, /Diff unknown · CI unknown\/partial · Review agent unknown/);
  for (const card of cards.slice(2)) assert.match(cardEl(card, hooks).textContent!, unknown);
  const current = cards[0]!;
  const partial = replay(withEntry({ diff: { additions: -1, deletions: 0 }, ci: { state: "green", complete: false }, review: null })).cards[0]!;
  assert.match(cardEl(partial, hooks).textContent!, /Diff unknown · CI unknown\/partial · Review agent unknown/);
  assert.notEqual(cardSignature(current), cardSignature(partial), "a changed assessment redraws the row");
});

test("optional evidence fails closed without changing the list or write authority", () => {
  for (const e of [null, {}, { ...contract.approval_evidence, schema: "future" }, { ...contract.approval_evidence, observed_at: "invalid" }, { ...contract.approval_evidence, omitted: -1 }, withEntry({ assessed_head: "b".repeat(40) })]) {
    assert.match(rendered(e), unknown);
    assert.deepEqual(replay(e).list.items[0]!.action, replay().list.items[0]!.action);
  }
  assert.match(rendered(contract.approval_evidence, { carried: true }), unknown);
  assert.equal(replay(contract.approval_evidence, { group: { reason: "same", numbers: [1261, 1262] } }).list.items[0]!.approvalEvidence, undefined);
  assert.match(rendered(withEntry({ review: { verdict: "approved", at: "invalid" } })), /Review agent unknown/);
  assert.match(rendered(withEntry({ review: { verdict: "changes_requested", at: "2026-11-05T11:00:00Z" }, ci: { state: "failing", complete: true } })), /CI failing · Review agent changes_requested/);
  // Bounds are derived from the producer's 50-entry cap, not a current capture.
  const items = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`o/r#${i + 1}`, entry]));
  items[contract.rows[0]!.key] = entry;
  assert.match(rendered({ ...contract.approval_evidence, items }), unknown);
  delete items["o/r#50"];
  assert.match(rendered({ ...contract.approval_evidence, items }), /CI green/);
});

for (const state of ["pending", "uncertain", "sent"]) test(`current evidence replaces old facts beside a retained ${state} approval receipt`, () => {
  const list = document.createElement("div");
  const retainedHooks = { ...hooks, writes: new Map<string, HTMLElement>() };
  fillInbox(list, [replay().cards[0]!], retainedHooks);
  const original = list.firstElementChild!;
  const receipt = document.createElement("p");
  if (state === "sent") receipt.dataset.sent = "true";
  else receipt.dataset.keep = state === "pending" ? "busy" : "";
  receipt.textContent = `Approval ${state}`;
  original.append(receipt);
  for (const force of [false, true]) {
    for (const evidence of [withEntry({ ci: { state: "failing", complete: true }, review: null }), null, contract.approval_evidence]) {
      fillInbox(list, [replay(evidence).cards[0]!], retainedHooks, force);
      assert.equal(list.firstElementChild, original, "keep the live receipt, not a copy");
      assert.equal(receipt.parentElement, original);
      assert.equal(original.querySelectorAll(".approval-evidence").length, 1);
      assert.match(original.querySelector(".approval-evidence")!.textContent!, evidence === null ? unknown : evidence === contract.approval_evidence ? /CI green/ : /CI failing · Review agent unknown/);
    }
  }
});

test("a pending approval receipt keeps no evidence after its card leaves the publication", () => {
  const list = document.createElement("div");
  fillInbox(list, [replay().cards[0]!], { ...hooks, writes: new Map<string, HTMLElement>() });
  const original = list.firstElementChild!;
  original.append(Object.assign(document.createElement("p"), { textContent: "Approval pending" }));
  original.lastElementChild!.setAttribute("data-keep", "busy");
  assert.match(original.textContent!, /CI green/);
  fillInbox(list, [], hooks);
  assert.equal(list.firstElementChild, original, "keep the live receipt");
  assert.match(original.querySelector(".approval-evidence")!.textContent!, /At a{12} · Diff unknown · CI unknown · Review agent unknown \(not published or not current\)/);
  assert.equal(original.querySelector(".approval-evidence a"), null);
});
