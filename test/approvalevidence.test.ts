import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNeedsYou, type ApprovalEvidence } from "../src/github/holds.ts";
import { inboxCards, refusal } from "../src/github/inbox.ts";
import { fillInbox, type InboxHooks } from "../src/github/inboxview.ts";
import { fixture, installDom, rawAsk, rawNeedsYou } from "./helpers.ts";

const win = installDom();
// Verbatim producer projection, agent-board 6260e0a7da91c07404013a35d9313064dd19b9d6.
const shared = fixture<{ rows: { key: string; head: string }[]; approval_evidence: { schema: string; observed_at: string; omitted: number; items: Record<string, Omit<ApprovalEvidence, "observed_at">> } }>("approval-evidence-needs-you.json");
const at = shared.approval_evidence.observed_at;
const hooks: InboxHooks = { now: Date.parse(at), mayAct: true, render: () => document.createDocumentFragment(), answerEntry: async () => {} };
const rows = shared.rows.map((r) => rawAsk(Number(r.key.split("#")[1]), { key: r.key, item: r.key, source: "reviews", kind: "review-withheld", action: { type: "approve_pull_request", repository: "cgwalters-forge/tracker", number: Number(r.key.split("#")[1]), head: r.head } }));
function publication(over: Record<string, unknown> = {}, items = rows) {
  const parsed = parseNeedsYou(rawNeedsYou(items, at, { approval_evidence: structuredClone(shared.approval_evidence), ...over }));
  assert.ok(typeof parsed === "object");
  return parsed;
}
function draw(p = publication(), now = hooks.now) {
  hooks.writes = new Map();
  const list = document.createElement("div");
  document.body.append(list);
  const cards = inboxCards({ published: { asks: p.items, list: p, unavailable: false } });
  fillInbox(list, cards, { ...hooks, now });
  return { list, cards };
}

test("shared producer projection: compact head-bound diff/CI/review, honest partial and evicted unknowns", () => {
  const { list } = draw();
  const facts = [...list.querySelectorAll(".approval-evidence")].map((r) => r.textContent!);
  assert.match(facts[0]!, /Diff \+12\/−3 · CI green · Review approved at 2026-11-05T11:00:00Z · head aaaaaaa/);
  assert.match(facts[1]!, /Diff unknown · CI unknown \(partial\) · Review unknown/);
  assert.ok(facts.slice(2).every((r) => r.startsWith("Diff, CI and review unknown")));
  assert.equal(list.querySelectorAll(".card-head .pill").length >= 4, true);
  assert.equal(list.querySelectorAll(".approval-evidence a").length, 4, "diff receipts remain inspectable");
});

for (const bad of ["absent", "carried", "partial source", "wrong head", "malformed", "oversized", "foreign", "diagnostic", "unreadable", "future", "future review", "stale"]) test(`${bad} evidence never implies verified success`, () => {
  const evidence = structuredClone(shared.approval_evidence);
  const item = { ...rows[0]! };
  const over: Record<string, unknown> = { approval_evidence: evidence };
  let now = hooks.now;
  if (bad === "absent") over.approval_evidence = undefined;
  if (bad === "carried") item.carried = true;
  if (bad === "partial source") over.sources = { reviews: "partial" };
  if (bad === "wrong head") evidence.items[shared.rows[0]!.key]!.assessed_head = "f".repeat(40);
  if (bad === "malformed") (evidence.items[shared.rows[0]!.key]!.diff as { additions: number }).additions = -1;
  if (bad === "oversized") for (let i = 1; i <= 51; i++) evidence.items[`o/r#${i}`] = evidence.items[shared.rows[0]!.key]!;
  if (["foreign", "diagnostic", "unreadable"].includes(bad)) over.requests = bad === "unreadable" ? [] : [{ key: item.key, forge: bad === "foreign" ? "forge.example" : "github.com", quality: bad === "diagnostic" ? "unverified-carried" : "decision", actions: [] }];
  if (bad === "future") now--;
  if (bad === "future review") evidence.items[shared.rows[0]!.key]!.review!.at = "2099-01-01T00:00:00Z";
  if (bad === "stale") now += 71 * 60_000;
  const { list } = draw(publication(over, [item]), now);
  assert.doesNotMatch(list.querySelector(".approval-evidence")!.textContent!, /CI green|Review approved|Diff \+12/);
  assert.match(list.querySelector(".card-head")!.textContent!, /Review agent withheld/, "withheld is independent of optional evidence");
});

test("incomplete green CI stays unknown, never a success", () => {
  const evidence = structuredClone(shared.approval_evidence);
  evidence.items[shared.rows[0]!.key]!.ci.complete = false;
  const { list } = draw(publication({ approval_evidence: evidence }));
  assert.match(list.querySelector(".approval-evidence")!.textContent!, /CI unknown \(partial\)/);
});

test("partial CI retains a published failure without claiming completeness", () => {
  const evidence = structuredClone(shared.approval_evidence);
  evidence.items[shared.rows[0]!.key]!.ci = { state: "failing", complete: false };
  const { list } = draw(publication({ approval_evidence: evidence }));
  assert.match(list.querySelector(".approval-evidence")!.textContent!, /CI failing \(partial\)/);
});

for (const state of ["busy", "", "sent"]) test(`retained ${state || "uncertain"} receipt updates evidence without stale success`, () => {
  const { list, cards } = draw();
  const first = list.firstElementChild as HTMLElement;
  const receipt = document.createElement("p");
  receipt.setAttribute(state === "sent" ? "data-sent" : "data-keep", state);
  receipt.textContent = "Approval sent: https://github.com/o/r/pull/1#review";
  first.append(receipt);
  const p = publication({ approval_evidence: undefined });
  const changed = inboxCards({ published: { asks: p.items, list: p, unavailable: false } });
  fillInbox(list, changed, hooks);
  assert.equal(first, list.firstElementChild);
  assert.equal(receipt.parentElement, first);
  assert.doesNotMatch(first.querySelector(".approval-evidence")!.textContent!, /CI green|Review approved/);
  fillInbox(list, cards, hooks);
  assert.match(first.querySelector(".approval-evidence")!.textContent!, /CI green/);
  fillInbox(list, cards, { ...hooks, now: hooks.now + 71 * 60_000 });
  assert.doesNotMatch(first.querySelector(".approval-evidence")!.textContent!, /CI green/);
  const card = cards[0]!;
  assert.ok("ask" in card);
  const moved = { ...card, ask: { ...card.ask, action: { ...card.ask.action, head: "f".repeat(40) }, approvalEvidence: { ...card.ask.approvalEvidence!, assessed_head: "f".repeat(40) } } };
  fillInbox(list, [moved], hooks);
  assert.doesNotMatch(first.querySelector(".approval-evidence")!.textContent!, /CI green|fffffff/);
  if (state !== "sent") {
    fillInbox(list, [], hooks);
    assert.equal(receipt.parentElement, first);
    assert.equal(first.querySelector("a[href]"), null);
  }
});

for (const kind of ["foreign", "missing", "malformed", "unreadable", "safe", "legacy"]) test(`evicted identity propagates ${kind} descriptor without Answer authority`, () => {
  const row = rows[0]!;
  const descriptor = { key: row.key, forge: kind === "foreign" ? "forge.example" : "github.com", quality: "decision", actions: [] };
  const requests = kind === "legacy" ? undefined : kind === "missing" ? [] : kind === "unreadable" ? {} : [{ ...descriptor, ...(kind === "malformed" ? { actions: "bad" } : {}) }];
  const p = publication({ items: [], identities: [{ ...row, key: "cgwalters-forge/tracker#999", detail_key: row.key, waiting_since: at }], requests });
  const { list, cards } = draw(p);
  const c = cards[0]!;
  assert.ok("ask" in c && c.ask.detailMissing);
  assert.equal(c.kind, "open");
  assert.match(refusal(c.ask)!, /Detail not published/);
  assert.equal(list.querySelector("button, form, .card-full"), null);
  assert.equal(list.querySelector(".approval-evidence"), null);
  if (kind === "safe" || kind === "legacy") assert.match(list.querySelector("a[href]")!.getAttribute("href")!, /github.com/);
  else {
    assert.equal(list.querySelector("a[href]"), null);
    assert.equal(list.firstElementChild!.getAttribute("data-href"), "#");
  }
});
