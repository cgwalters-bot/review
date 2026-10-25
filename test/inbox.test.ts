import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import type { Offered, Plan } from "../src/github/actions.ts";
import { rerunDispatchRun } from "../src/github/backend.ts";
import type { Item } from "../src/github/board.ts";
import { type DocumentEntry, type Mark, parseDocument } from "../src/github/decisiondocument.ts";
import { attachOffers, type Card, type DispatchRun, documentCard, doCard, inboxCards, linksTo, loadDispatchRuns, needCard, offeredReruns, parseRunTitle, rerunCards, sendCard } from "../src/github/inbox.ts";
import type { Need } from "../src/github/needs.ts";
import type { DraftIssue } from "../src/github/reviewdrafts.ts";
import { scriptedFetch } from "./helpers.ts";

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

function run(id: number, item: string, hoursAgo: number, status: string, conclusion: string | null): DispatchRun {
  return { id, url: `https://github.com/cgwalters-forge/tracker/actions/runs/${id}`, title: `implement ${item} (claude)`, status, conclusion, createdAt: at(hoursAgo), ...parseRunTitle(`implement ${item} (claude)`) };
}

describe("Rerun cards", () => {
  const open = () => "open";
  const cases: [string, DispatchRun[], (item: string) => string | undefined, number[]][] = [
    ["a run that failed an hour ago", [run(1, "o/r#5", 1, "completed", "failure")], open, [1]],
    ["a cancelled run", [run(1, "o/r#5", 1, "completed", "cancelled")], open, [1]],
    ["a timed-out run", [run(1, "o/r#5", 1, "completed", "timed_out")], open, [1]],
    ["an item the board doesn't know", [run(1, "o/r#5", 1, "completed", "failure")], () => undefined, [1]],
    ["a run that succeeded", [run(1, "o/r#5", 1, "completed", "success")], open, []],
    ["a run rerun and live again", [run(1, "o/r#5", 1, "in_progress", null)], open, []],
    ["a failed run overtaken by a newer run", [run(1, "o/r#5", 3, "completed", "failure"), run(2, "o/r#5", 1, "in_progress", null)], open, []],
    ["a failed run overtaken by a newer success", [run(2, "o/r#5", 1, "completed", "success"), run(1, "o/r#5", 3, "completed", "failure")], open, []],
    ["a newer failure behind an older success", [run(1, "o/r#5", 3, "completed", "success"), run(2, "o/r#5", 1, "completed", "failure")], open, [2]],
    ["a failed run whose item closed", [run(1, "o/r#5", 1, "completed", "failure")], () => "closed", []],
    ["a failed run older than a day", [run(1, "o/r#5", 25, "completed", "failure")], open, []],
    ["one card per item", [run(1, "o/r#5", 1, "completed", "failure"), run(2, "o/r#6", 2, "completed", "failure")], open, [1, 2]],
    ["a run whose title names no item", [{ ...run(1, "o/r#5", 1, "completed", "failure"), title: "Dispatch", item: undefined } as unknown as DispatchRun], open, []],
  ];
  for (const [name, runs, state, want] of cases) {
    it(name, () => assert.deepEqual(rerunCards(runs, NOW, state).map((c) => c.kind === "rerun" && c.run.id), want));
  }

  it("parses the dispatch title, and nothing from another one", () => {
    assert.deepEqual(parseRunTitle("implement cgwalters-forge/Agentic-Job#1623 (claude)"), { kind: "implement", item: "cgwalters-forge/agentic-job#1623", pool: "claude" });
    assert.deepEqual(parseRunTitle("triage cgwalters-forge/tracker#677"), { kind: "triage", item: "cgwalters-forge/tracker#677" });
    for (const title of ["Dispatch", "implement o/r#0 (claude)", "implement o/r#5 and more", "implement ../..#5", "implement o/..#5", "implement o/.#5"]) assert.deepEqual(parseRunTitle(title), {}, title);
  });

  it("reads the last day's dispatch runs in one request", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => ({ body: { workflow_runs: [{ id: 9, html_url: "https://github.com/cgwalters-forge/tracker/actions/runs/9", display_title: "fix o/r#5 (openai)", status: "completed", conclusion: "failure", created_at: at(1) }] } }));
    const runs = await loadDispatchRuns(new GitHub(async () => "t", fetchImpl), NOW);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/repos\/cgwalters-forge\/tracker\/actions\/workflows\/dispatch\.yml\/runs\?per_page=100&created=%3E%3D2026-10-24$/);
    assert.deepEqual(runs, [{ id: 9, url: "https://github.com/cgwalters-forge/tracker/actions/runs/9", title: "fix o/r#5 (openai)", status: "completed", conclusion: "failure", createdAt: at(1), kind: "fix", item: "o/r#5", pool: "openai" }]);
  });
});

describe("offeredReruns", () => {
  const failed = run(1, "o/r#5", 1, "completed", "failure");
  const raw = (r: DispatchRun) => ({ id: r.id, html_url: r.url, display_title: r.title, status: r.status, conclusion: r.conclusion, created_at: r.createdAt });
  const github = (runs: DispatchRun[], state: string) => scriptedFetch((method, url) => {
    if (url.includes("/actions/workflows/dispatch.yml/runs")) return { body: { workflow_runs: runs.map(raw) } };
    if (url === "https://api.github.com/repos/o/r/issues/5") return { body: { state } };
    return undefined;
  });
  const cases: [string, DispatchRun[], string, string[]][] = [
    ["a run still offered, read now", [failed], "open", [failed.url]],
    ["a run a newer one overtook since the poll", [failed, run(2, "o/r#5", 0.1, "queued", null)], "open", []],
    ["a run whose item closed since the poll", [failed], "closed", []],
  ];
  for (const [name, runs, state, want] of cases) {
    it(name, async () => {
      const { fetchImpl } = github(runs, state);
      assert.deepEqual(await offeredReruns(new GitHub(async () => "t", fetchImpl), failed, NOW), want);
    });
  }
});

describe("rerunDispatchRun", () => {
  const RUN = "https://github.com/cgwalters-forge/tracker/actions/runs/9";
  const API = "https://api.github.com/repos/cgwalters-forge/tracker/actions/runs/9";
  const github = (raw: Record<string, unknown> = {}) => scriptedFetch((method, url) => {
    if (method === "GET" && url === API) return { body: { id: 9, html_url: RUN, status: "completed", conclusion: "failure", repository: { full_name: "cgwalters-forge/tracker" }, ...raw } };
    if (method === "GET" && url.startsWith(`${API}/jobs`)) return { body: { jobs: [{ name: "run", status: "completed", conclusion: "failure" }] } };
    if (method === "POST" && url === `${API}/rerun-failed-jobs`) return { status: 201 };
    return undefined;
  });

  it("reruns a failed run the inbox offers", async () => {
    const { fetchImpl, calls } = github();
    assert.equal(await rerunDispatchRun(new GitHub(async () => "t", fetchImpl), RUN, [RUN]), RUN);
    assert.deepEqual(calls.map((c) => c.method), ["GET", "GET", "POST"]);
  });

  const refusals: [string, string, string[], Record<string, unknown>, RegExp][] = [
    ["a run the inbox doesn't offer", RUN, [], {}, /isn't a failed run the inbox offers/],
    ["a run outside the tracker", "https://github.com/evil/tracker/actions/runs/9", ["https://github.com/evil/tracker/actions/runs/9"], {}, /not in cgwalters-forge\/tracker/],
    ["a run live again", RUN, [RUN], { status: "in_progress", conclusion: null }, /not completed/],
  ];
  for (const [name, url, allowed, raw, want] of refusals) {
    it(`refuses ${name}, rerunning nothing`, async () => {
      const { fetchImpl, calls } = github(raw);
      await assert.rejects(rerunDispatchRun(new GitHub(async () => "t", fetchImpl), url, allowed), want);
      assert.equal(calls.filter((c) => c.method === "POST").length, 0);
    });
  }
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
      runs: [run(1, "o/r#5", 1, "completed", "failure")],
      now: NOW,
    });
    assert.deepEqual(cards.map((c) => `${c.kind}${c.answered ? " (answered)" : ""}`), ["rerun", "document", "answer", "approve", "send", "document (answered)", "answer (answered)"]);
  });

  describe("orders by board Priority, then age", () => {
    const doc = (id: string, about: string, asked?: string) => `### ${id} Ask\nAbout: ${about}${asked ? `, asked ${asked}` : ""}\n- [ ] A) Yes\nReply:`;
    const priorities: Record<string, string> = { "example/work#1": "P2", "example/work#2": "P0", "cgwalters-forge/tracker#30": "P1", "o/r#5": "P0" };
    // name, the inputs, the card keys in order
    const cases: [string, Omit<Parameters<typeof inboxCards>[0], "now" | "priorityOf">, string[]][] = [
      ["P0 before P2, whatever the kind", { document: { entries: parseDocument([doc("D1", "example/work#1"), doc("D2", "example/work#2")].join("\n\n")), marks: new Map() } }, ["document:D2", "document:D1"]],
      ["a need's own Priority", { needs: [answerNeed({ key: "a", priority: "P2" }), answerNeed({ key: "b", priority: "P0" }, { nodeId: "I_2" })] }, ["b", "a"]],
      ["the older first at one Priority", { document: { entries: parseDocument([doc("D3", "example/work#3", "2026-10-20"), doc("D4", "example/work#4", "2026-10-10")].join("\n\n")), marks: new Map() } }, ["document:D4", "document:D3"]],
      ["one without a Priority after those with one", { document: { entries: parseDocument([doc("D5", "example/work#9"), doc("D6", "example/work#1")].join("\n\n")), marks: new Map() } }, ["document:D6", "document:D5"]],
      ["a proposal's own card by its issue's Priority", { offers: [proposal(31), proposal(30)], runs: [run(1, "o/r#5", 1, "completed", "failure")] }, ["rerun:o/r#5", "do:30", "do:31"]],
      ["a decision carrying a proposal keeps its own place", { offers: [proposal(12)], document: { entries: parseDocument([doc("D7", "cgwalters-forge/tracker#12"), doc("D8", "example/work#2")].join("\n\n")), marks: new Map() } }, ["document:D8", "document:D7"]],
    ];
    for (const [name, input, want] of cases) it(name, () => {
      const cards = inboxCards({ ...input, priorityOf: (item) => priorities[item], now: NOW });
      assert.deepEqual(cards.map((c) => c.key), want);
    });
  });
});
