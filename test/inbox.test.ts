import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Offered, Plan } from "../src/github/actions.ts";
import type { Item } from "../src/github/board.ts";
import { type DocumentEntry, type Mark, parseDocument } from "../src/github/decisiondocument.ts";
import { attachOffers, type Card, documentCard, doCard, inboxCards, linksTo, needCard, sendCard } from "../src/github/inbox.ts";
import type { Need } from "../src/github/needs.ts";
import type { DraftIssue } from "../src/github/reviewdrafts.ts";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const HOUR = 3_600_000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

/** What a predicate made of a case: absent (the thing left), or the card waiting on him or answered. */
type Outcome = "absent" | "present" | "answered";
const outcome = (c: Card | undefined): Outcome => (c === undefined ? "absent" : c.answered ? "answered" : "present");

function item(over: Partial<Item> = {}): Item {
  return { id: 1, nodeId: "I_1", kind: "issue", title: "Which way?", url: "https://github.com/cgwalters-forge/tracker/issues/7", ref: { owner: "cgwalters-forge", repo: "tracker", number: 7 }, state: "open", body: "", why: "", branch: [], gist: [], labels: ["question"], assignees: ["cgwalters"], ...over };
}

function answerNeed(over: Partial<Need> = {}, itemOver: Partial<Item> = {}): Need {
  const i = item(itemOver);
  return { key: "item:I_1", action: "answer", title: i.title, where: "cgwalters-forge/tracker#7", href: "#item/I_1", inPlace: true, entry: { key: "item:I_1", kind: "item", title: i.title, where: "cgwalters-forge/tracker#7", href: "#item/I_1", item: i }, ...over };
}

function approveNeed(reviewedCurrentHead = false, itemState?: string): Need {
  const pr = { ref: { owner: "upstream", repo: "widget", number: 3 }, url: "https://github.com/upstream/widget/pull/3", title: "Fix", body: "", author: "cgwalters-bot", createdAt: at(30), updatedAt: at(2), draft: false };
  return {
    key: "pr:upstream/widget#3", action: "review", title: "Fix", where: "upstream/widget#3", href: "#pr/upstream/widget/3", inPlace: false,
    entry: { key: "pr:upstream/widget#3", kind: "pr", pr, title: "Fix", where: "upstream/widget#3", href: "#pr/upstream/widget/3", wait: { reasons: ["review-requested"], onBot: false, reviewedCurrentHead }, ...(itemState ? { item: item({ kind: "pr", state: itemState }) } : {}) },
  };
}

describe("Answer and Approve cards", () => {
  const cases: [string, Need, Outcome, string?][] = [
    ["an open ask", answerNeed(), "present", "answer"],
    ["an ask he answered", answerNeed({ done: true }), "answered", "answer"],
    ["an ask whose issue closed", answerNeed({}, { state: "closed" }), "absent"],
    ["an escalation assigned to him", answerNeed({ action: "write", inPlace: false }, { labels: ["escalate"] }), "present", "answer"],
    ["a review request at an unreviewed head", approveNeed(), "present", "approve"],
    ["a review request whose head he reviewed", approveNeed(true), "absent"],
    ["a review request on a merged PR", approveNeed(false, "merged"), "absent"],
    ["a review request on a closed PR", approveNeed(false, "closed"), "absent"],
  ];
  for (const [name, need, want, kind] of cases) {
    it(name, () => {
      const card = needCard(need);
      assert.equal(outcome(card), want);
      if (kind) assert.equal(card?.kind, kind);
    });
  }
});

function draft(over: Partial<DraftIssue> = {}, state?: string): DraftIssue & { issue: { state?: string } } {
  return { issue: { number: 40, title: "Review draft: upstream/widget#3: Fix", html_url: "https://github.com/cgwalters-forge/tracker/issues/40", body: "", comments: 1, user: { login: "cgwalters-bot" }, ...(state ? { state } : {}) }, box: "unticked", ...over };
}

describe("Send cards", () => {
  const cases: [string, ReturnType<typeof draft>, Outcome][] = [
    ["an open draft issue", draft(), "present"],
    ["a draft he sent, the workflow not yet run", draft({ box: "ticked" }), "answered"],
    ["a draft issue the workflow closed", draft({}, "closed"), "absent"],
    // Not readable as a draft (no draft yet, too many comments): still his to look at.
    ["a draft issue with no draft yet", draft({ refused: "100 or more comments" }), "present"],
  ];
  for (const [name, d, want] of cases) it(name, () => assert.equal(outcome(sendCard(d)), want));
});

const proposal = (issue: number, id = issue): Offered => ({ issue, comment: { id: `IC_${id}`, databaseId: id, body: "", updatedAt: at(2), author: { login: "planner" }, editor: null, lastEditedAt: null }, proposal: { schema: "agent-board/operator-action/v1", title: `Proposal ${id}`, why: "D15", actions: [] } });

describe("Do cards", () => {
  it("a proposal no decision carries, on its tracker issue", () => assert.deepEqual([outcome(doCard(proposal(12))), doCard(proposal(12)).where], ["present", "cgwalters-forge/tracker#12"]));
});

describe("attachOffers", () => {
  const doc = parseDocument([
    "### D15 Create the org ruleset for the workflow checker\nAbout: cgwalters-forge/tracker#12\n- [ ] A) Create it\nReply:",
    "### D16 Pick a name\nSee https://github.com/cgwalters-forge/tracker/issues/13 for the proposal.\n- [ ] A) This\nReply:",
    "### D17 Unrelated\nAbout: example/work#12\nMentions cgwalters-forge/tracker#140 and other/tracker#14.\n- [ ] A) Yes\nReply:",
  ].join("\n\n"));
  const cards = (): Card[] => [
    ...doc.map((e) => documentCard(e, undefined)!),
    needCard(answerNeed({ key: "item:I_7" }, { body: "Run the proposal on cgwalters-forge/tracker#15 first; see also cgwalters-forge/tracker#16." }))!,
    needCard(answerNeed({ key: "item:I_8", where: "cgwalters-forge/tracker#16" }, { nodeId: "I_8", url: "https://github.com/cgwalters-forge/tracker/issues/16", ref: { owner: "cgwalters-forge", repo: "tracker", number: 16 } }))!,
    needCard(approveNeed())!,
  ];
  // proposal issues; which card carries each (by key), or "do" for a card of its own
  const cases: [string, number[], string[]][] = [
    ["a decision About the proposal's issue carries it (D15)", [12], ["document:D15"]],
    ["a decision linking to the issue by URL", [13], ["document:D16"]],
    ["an ask whose question links to it", [15], ["item:I_7"]],
    ["an ask on the proposal's own issue", [7], ["item:I_7"]],
    ["the issue a card is about wins over an earlier card's link to it", [16], ["item:I_8"]],
    ["#14 is not #140, and another repository's #14 is not the tracker's", [14], ["do"]],
    ["a proposal with no decision is a card of its own", [99], ["do"]],
    ["a decision carries every proposal on its issue", [12, 12], ["document:D15", "document:D15"]],
  ];
  for (const [name, issues, want] of cases) it(name, () => {
    const out = attachOffers(cards(), issues.map((n, i) => proposal(n, 100 + i)));
    const carrier = (id: number) => out.find((c) => c.offers?.some((o) => o.comment.databaseId === id))?.key ?? (out.some((c) => c.kind === "do" && c.offer.comment.databaseId === id) ? "do" : "none");
    assert.deepEqual(issues.map((_, i) => carrier(100 + i)), want);
    assert.equal(out.filter((c) => c.kind !== "do").length, cards().length, "no decision is dropped or doubled");
  });

  it("finds a link only as a whole reference", () => {
    const cases: [string, boolean][] = [
      ["cgwalters-forge/tracker#12", true],
      ["(cgwalters-forge/tracker#12)", true],
      ["https://github.com/cgwalters-forge/tracker/issues/12#issuecomment-1", true],
      ["cgwalters-forge/tracker#123", false],
      ["evil-cgwalters-forge/tracker#12", false],
      ["https://github.com/cgwalters-forge/tracker/issues/120", false],
      ["#12", false],
    ];
    for (const [text, want] of cases) assert.equal(linksTo(text, "cgwalters-forge/tracker", 12), want, text);
  });
});

describe("document entry cards", () => {
  const body = "### D15 Create the ruleset\nAbout: example/work#15, asked 2026-10-15\n- [ ] A) Create it\nReply:\n\n### D16 Pick one\nAbout: example/work#16\n- [x] A) This\n- [ ] B) That\nReply: done\n\n### D17 Land it (P0, blocks example/work#17)\n- [ ] A) Yes\nReply:\n\n## Done\n### D1 Old\n- [x] A) Kept\n";
  const entries = parseDocument(body);
  const entry = (id: string): DocumentEntry => entries.find((e) => e.id === id)!;
  const closed: Mark = { item: "example/work#15", state: "closed", url: "https://github.com/example/work/issues/15" };
  const merged: Mark = { item: "example/work#17", state: "merged", url: "https://github.com/example/work/pull/17" };
  const commented: Mark = { item: "example/work#15", state: "answered", comments: 2, url: "https://github.com/example/work/issues/15" };
  const cases: [string, DocumentEntry, Mark | undefined, Outcome, RegExp?][] = [
    ["an open entry", entry("D15"), undefined, "present"],
    ["an entry he answered", entry("D16"), undefined, "answered", /waiting on the bot/],
    ["an entry whose About item closed", entry("D15"), closed, "absent"],
    ["an entry whose heading's blocked item merged", entry("D17"), merged, "absent"],
    ["an entry whose item changed since the ask", entry("D15"), commented, "present", /Changed since asked: 2 comments on example\/work#15/],
    ["a mark read for another item", entry("D16"), closed, "answered"],
    ["an entry under Done", entry("D1"), undefined, "absent"],
  ];
  for (const [name, e, mark, want, note] of cases) {
    it(name, () => {
      const card = documentCard(e, mark);
      assert.equal(outcome(card), want);
      if (note) assert.match(card?.note ?? "", note);
    });
  }
});

describe("inboxCards", () => {
  it("lists a dated card before undated ones, these by kind, then those he did", () => {
    const entries = parseDocument("### D2 Ask\n- [ ] A) Yes\nReply:\n\n### D3 Done here\n- [x] A) Yes\nReply:\n");
    const cards = inboxCards({
      needs: [approveNeed(), answerNeed({ done: true }), answerNeed({ key: "item:I_2" })],
      document: { entries, marks: new Map() },
      drafts: [draft()],
    });
    assert.deepEqual(cards.map((c) => `${c.kind}${c.answered ? " (answered)" : ""}`), ["document", "answer", "approve", "send", "document (answered)", "answer (answered)"]);
  });

  describe("orders by board Priority, then age", () => {
    const doc = (id: string, about: string, asked?: string) => `### ${id} Ask\nAbout: ${about}${asked ? `, asked ${asked}` : ""}\n- [ ] A) Yes\nReply:`;
    const priorities: Record<string, string> = { "example/work#1": "P2", "example/work#2": "P0", "cgwalters-forge/tracker#30": "P1" };
    // name, the inputs, the card keys in order
    const cases: [string, Omit<Parameters<typeof inboxCards>[0], "priorityOf">, string[]][] = [
      ["P0 before P2, whatever the kind", { document: { entries: parseDocument([doc("D1", "example/work#1"), doc("D2", "example/work#2")].join("\n\n")), marks: new Map() } }, ["document:D2", "document:D1"]],
      ["a need's own Priority", { needs: [answerNeed({ key: "a", priority: "P2" }), answerNeed({ key: "b", priority: "P0" }, { nodeId: "I_2" })] }, ["b", "a"]],
      ["the older first at one Priority", { document: { entries: parseDocument([doc("D3", "example/work#3", "2026-10-20"), doc("D4", "example/work#4", "2026-10-10")].join("\n\n")), marks: new Map() } }, ["document:D4", "document:D3"]],
      ["one without a Priority after those with one", { document: { entries: parseDocument([doc("D5", "example/work#9"), doc("D6", "example/work#1")].join("\n\n")), marks: new Map() } }, ["document:D6", "document:D5"]],
      ["a proposal's own card by its issue's Priority", { offers: [proposal(31), proposal(30)] }, ["do:30", "do:31"]],
      ["a P0 question three days old before a P1 review three weeks old", { needs: [{ ...approveNeed(), priority: "P1", since: at(21 * 24) }, answerNeed({ priority: "P0", since: at(3 * 24) })] }, ["item:I_1", "pr:upstream/widget#3"]],
      ["a decision carrying a proposal keeps its own place", { offers: [proposal(12)], document: { entries: parseDocument([doc("D7", "cgwalters-forge/tracker#12"), doc("D8", "example/work#2")].join("\n\n")), marks: new Map() } }, ["document:D8", "document:D7"]],
    ];
    for (const [name, input, want] of cases) it(name, () => {
      const cards = inboxCards({ ...input, priorityOf: (item) => priorities[item] });
      assert.deepEqual(cards.map((c) => c.key), want);
    });
  });
});
