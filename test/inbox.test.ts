import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import type { Offered, Plan } from "../src/github/actions.ts";
import { rerunDispatchRun } from "../src/github/backend.ts";
import type { Item } from "../src/github/board.ts";
import { type DocumentEntry, type Mark, parseDocument } from "../src/github/decisiondocument.ts";
import { type Card, type DispatchRun, documentCard, doCard, inboxCards, loadDispatchRuns, needCard, offeredReruns, parseRunTitle, rerunCards, sendCard } from "../src/github/inbox.ts";
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

describe("Do cards", () => {
  const offer: Offered = { issue: 12, comment: { id: "IC_1", databaseId: 5, body: "", updatedAt: at(2), author: { login: "planner" }, editor: null, lastEditedAt: null }, proposal: { schema: "agent-board/operator-action/v1", title: "Create the ruleset", why: "D15", actions: [] } };
  const plan: Plan = { states: ["o/r#1 · now \"open\" → \"closed\""], expected: ["open"], mutations: [undefined] };
  it("a proposal whose preconditions hold", () => assert.equal(outcome(doCard(offer, plan)), "present"));
  it("a proposal whose precondition no longer holds", () => assert.equal(outcome(doCard(offer, undefined)), "absent"));
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
  it("lists the waiting cards by kind, then those he did", () => {
    const entries = parseDocument("### D2 Ask\n- [ ] A) Yes\nReply:\n\n### D3 Done here\n- [x] A) Yes\nReply:\n");
    const cards = inboxCards({
      needs: [approveNeed(), answerNeed({ done: true }), answerNeed({ key: "item:I_2" })],
      document: { entries, marks: new Map() },
      drafts: [draft()],
      runs: [run(1, "o/r#5", 1, "completed", "failure")],
      now: NOW,
    });
    assert.deepEqual(cards.map((c) => `${c.kind}${c.answered ? " (answered)" : ""}`), ["document", "answer", "approve", "send", "rerun", "document (answered)", "answer (answered)"]);
  });
});
