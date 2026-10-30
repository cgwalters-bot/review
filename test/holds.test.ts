import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import type { RawComment } from "../src/github/heartbeat.ts";
import { findHolds, holdAsks, HOLDS_MARKER, loadHolds, parseHolds, parseNeedsYou } from "../src/github/holds.ts";
import { usagePath } from "../src/github/usage.ts";
import { fixture, holdsComment, rawAsk, rawNeedsYou, scriptedFetch } from "./helpers.ts";

const AT = "2026-10-26T00:00:00Z";
/** As agent-board's pass renders it (pass/holds.rs). */
const body = (json: unknown) => `${HOLDS_MARKER}\nHolds as of ${AT}. Written by \`agent-board pass\`; the review app reads the JSON below.\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
const wip = { item: null, url: null, epic: false, kind: "wip", reason: "2 of 2 runs active", operator: false, priority: null, question: null };
const human = { item: "cgwalters-forge/tracker#446", url: "https://github.com/cgwalters-forge/tracker/issues/446", epic: false, kind: "needs-human", reason: "labelled needs-human", operator: true, priority: "P0", question: "Ship it?" };
const snapshot = (holds: unknown[] = [wip, human], over: Record<string, unknown> = {}) => ({ schema: "agent-board/holds/v1", at: AT, holds, ...over });
const comment = (json: unknown, login = "cgwalters-bot"): RawComment => ({ user: { login }, body: body(json) });

describe("parseHolds", () => {
  it("reads a snapshot as the pass publishes it", () => assert.deepEqual(parseHolds(body(snapshot())), { at: AT, holds: [wip, human] }));
  // name, the snapshot: each is no holds at all, not the entries that parse.
  const refused: [string, unknown][] = [
    ["another schema", snapshot(undefined, { schema: "agent-board/pass-holds/v1" })],
    ["no time", snapshot(undefined, { at: "yesterday" })],
    ["holds not a list", snapshot(undefined, { holds: {} })],
    ["a key missing", snapshot([wip, { ...human, question: undefined }])],
    ["an item that is no reference", snapshot([{ ...human, item: "tracker#446" }])],
    ["a link to another item", snapshot([{ ...human, url: "https://github.com/cgwalters-forge/tracker/issues/447" }])],
    ["a link off github.com", snapshot([{ ...human, url: "javascript:alert(1)" }])],
    ["a link without an item", snapshot([{ ...wip, url: "https://github.com/cgwalters-forge/tracker/issues/446" }])],
    ["operator not a boolean", snapshot([{ ...human, operator: "yes" }])],
    ["a priority the board has not", snapshot([{ ...human, priority: "urgent" }])],
    ["a kind that is no word", snapshot([{ ...human, kind: "<b>" }])],
    ["an entry not an object", snapshot([wip, null])],
  ];
  for (const [name, json] of refused) it(`refuses ${name}`, () => assert.equal(parseHolds(body(json)), undefined));
  it("refuses a body without the marker first", () => assert.equal(parseHolds(`hi\n${body(snapshot())}`), undefined));
  const wipSummary = { wip: { limit: 4, in_flight: 2 }, pass: { mode: "preview", candidates: 3, started: 1, live_epics: null } };
  it("reads the pass's WIP and summary, nulls kept", () => assert.deepEqual(parseHolds(body(snapshot(undefined, wipSummary))), { at: AT, wip: { limit: 4, inFlight: 2 }, pass: { mode: "preview", candidates: 3, started: 1, liveEpics: null }, holds: [wip, human] }));
  // name, the snapshot's wip and pass: each left out, the holds kept.
  const malformed: [string, Record<string, unknown>][] = [
    ["a limit not a count", { wip: { limit: "4", in_flight: 2 } }],
    ["in flight missing", { wip: { limit: 4 } }],
    ["a negative start", { pass: { ...wipSummary.pass, started: -1 } }],
    ["a mode that is no word", { pass: { ...wipSummary.pass, mode: "<b>" } }],
    ["candidates missing", { pass: { mode: "preview", started: 1, live_epics: null } }],
  ];
  for (const [name, edit] of malformed) it(`leaves out ${name}, and keeps the holds`, () => {
    const parsed = parseHolds(body(snapshot(undefined, { ...wipSummary, ...edit })));
    assert.equal(parsed?.holds.length, 2);
    for (const key of Object.keys(edit) as ("wip" | "pass")[]) assert.equal(parsed?.[key], undefined);
  });
});

describe("the recorded comments", () => {
  // As agent-board's pass/holds.rs renders them: compact, one entry a line; the older without wip and pass.
  const [older, newer] = fixture<RawComment[]>("holds-comments.json");
  it("reads a comment from before wip and pass without them", () => {
    const holds = findHolds([older!]);
    assert.deepEqual([holds?.at, holds?.holds.length, holds?.wip, holds?.pass], ["2026-10-25T09:00:00Z", 3, undefined, undefined]);
  });
  it("reads the current one with them", () => {
    const holds = findHolds([older!, newer!]);
    assert.deepEqual([holds?.wip, holds?.pass], [{ limit: 4, inFlight: 4 }, { mode: "actions", candidates: 7, started: 1, liveEpics: 2 }]);
    assert.deepEqual(holds?.holds.map((h) => h.kind), ["wip", "epic-unplanned", "needs-human"]);
  });
});

describe("findHolds", () => {
  // name, the issue's comments oldest first, the reasons of the holds found (undefined for none)
  const cases: [string, RawComment[], string[] | undefined][] = [
    ["the bot's comment", [comment(snapshot())], ["2 of 2 runs active", "labelled needs-human"]],
    ["not someone else's copy", [comment(snapshot(), "mallory")], undefined],
    ["the newest of the bot's", [comment(snapshot([wip])), comment(snapshot([human])), comment(snapshot([]), "mallory")], ["labelled needs-human"]],
    ["nothing, not an older one, when the newest doesn't parse", [comment(snapshot()), comment(snapshot([{ ...human, epic: null }]))], undefined],
    ["not the usage comment", [{ user: { login: "cgwalters-bot" }, body: "<!-- bot-usage v1 -->\n" }], undefined],
  ];
  for (const [name, comments, want] of cases) it(name, () => assert.deepEqual(findHolds(comments)?.holds.map((h) => h.reason), want));
});

/** The example in agent-board's docs/pass.md, verbatim. */
const DOC_EXAMPLE = `{"schema":"agent-board/needs-you/v2","complete":true,"validated_at":"2026-10-30T09:30:00Z","changed_at":"2026-10-30T09:00:00Z","sources":{"epics":"complete","items":"complete","reviews":"complete","proposals":"complete","digest":"off"},"summaries":"complete","omitted":0,"count":2,"items":[
{"key":"cgwalters-forge/tracker#446","item":"cgwalters-forge/tracker#446","source":"items","kind":"needs-human","priority":"P0","waiting_since":"2026-10-29T18:24:18Z","ask":"Ship 1.0 today?","recommendation":"Yes, CI is green.","target":"https://github.com/cgwalters-forge/tracker/issues/446","head":null,"action":{"type":"issue","repository":"cgwalters-forge/tracker","number":446},"source_ref":{"type":"hold","repository":"cgwalters-forge/tracker","number":446}},
{"key":"cgwalters-forge/bot-ops#5/comment-21","item":"cgwalters-forge/bot-ops#5","source":"proposals","kind":"operator-action","priority":null,"waiting_since":"2026-10-20T00:00:00Z","ask":"Label tracker#3","recommendation":"Because.","target":"https://github.com/cgwalters-forge/bot-ops/issues/5#issuecomment-21","head":null,"action":{"type":"operator_action","repository":"cgwalters-forge/bot-ops","number":5,"comment":21},"source_ref":{"type":"comment","repository":"cgwalters-forge/bot-ops","number":5,"comment":21}}]}`;

describe("parseNeedsYou", () => {
  it("reads the list agent-board documents", () => {
    const l = parseNeedsYou(JSON.parse(DOC_EXAMPLE));
    assert.ok(typeof l === "object");
    assert.deepEqual([l.complete, l.validatedAt, l.changedAt, l.summaries, l.omitted, l.refused], [true, "2026-10-30T09:30:00Z", "2026-10-30T09:00:00Z", "complete", 0, 0]);
    assert.deepEqual(l.items[0], { key: "cgwalters-forge/tracker#446", item: "cgwalters-forge/tracker#446", source: "items", kind: "needs-human", priority: "P0", waitingSince: "2026-10-29T18:24:18Z", ask: "Ship 1.0 today?", recommendation: "Yes, CI is green.", action: { type: "issue", repository: "cgwalters-forge/tracker", number: 446 }, carried: false });
    assert.deepEqual(l.items[1]!.action, { type: "operator_action", repository: "cgwalters-forge/bot-ops", number: 5, comment: 21 });
  });

  it("reads it from the hold comment, and an older one without it as no list", () => {
    const at = "2026-10-30T09:30:00Z";
    assert.equal(typeof findHolds([holdsComment(at, rawNeedsYou([rawAsk(1)], at))])?.needsYou, "object");
    assert.equal(findHolds([holdsComment(at)])?.needsYou, undefined);
  });

  // name, the list: each says why it can't be used, rather than a list
  const unusable: [string, unknown, RegExp][] = [
    ["v1, which had only the holds", { ...JSON.parse(DOC_EXAMPLE), schema: "agent-board/needs-you/v1" }, /schema "agent-board\/needs-you\/v1" is not/],
    ["a later schema", { ...JSON.parse(DOC_EXAMPLE), schema: "agent-board/needs-you/v3" }, /is not agent-board\/needs-you\/v2/],
    ["no validated_at", { ...JSON.parse(DOC_EXAMPLE), validated_at: "now" }, /malformed/],
    ["no sources", { ...JSON.parse(DOC_EXAMPLE), sources: {} }, /malformed/],
    ["items not a list", { ...JSON.parse(DOC_EXAMPLE), items: {} }, /malformed/],
    ["not an object", [], /not an object/],
  ];
  for (const [name, raw, why] of unusable) it(`can't use ${name}`, () => assert.match(String(parseNeedsYou(raw)), why));

  // name, an edit to one ask: it is left out, the others kept, and the list is not complete
  const refused: [string, Record<string, unknown>][] = [
    ["an action type it doesn't know", { action: { type: "merge_everything", repository: "o/r", number: 1 } }],
    ["a repository that climbs", { action: { type: "issue", repository: "o/..", number: 1 } }],
    ["an approval without its head", { action: { type: "approve_pull_request", repository: "o/r", number: 1 } }],
    ["a short head", { action: { type: "approve_pull_request", repository: "o/r", number: 1, head: "abc1234" } }],
    ["a proposal without its comment", { action: { type: "operator_action", repository: "o/r", number: 1 } }],
    ["a key that is no key", { key: "<b>" }],
    ["no ask", { ask: "" }],
    ["a priority the board has not", { priority: "urgent" }],
  ];
  for (const [name, edit] of refused) it(`leaves out ${name}`, () => {
    const l = parseNeedsYou(rawNeedsYou([rawAsk(1), rawAsk(2, edit)], "2026-10-30T09:30:00Z"));
    assert.ok(typeof l === "object");
    assert.deepEqual([l.items.map((a) => a.key), l.refused, l.complete], [["cgwalters-forge/tracker#1"], 1, false]);
  });

  it("never keeps the published target: links are made from the action", () => {
    const l = parseNeedsYou(rawNeedsYou([rawAsk(1, { target: "javascript:alert(1)" })], "2026-10-30T09:30:00Z"));
    assert.ok(typeof l === "object" && l.items.length === 1 && !("target" in l.items[0]!));
  });

  it("cuts an ask to its first line and 500 characters", () => {
    const l = parseNeedsYou(rawNeedsYou([rawAsk(1, { ask: `${"x".repeat(600)}\nmore` })], "2026-10-30T09:30:00Z"));
    assert.ok(typeof l === "object");
    assert.equal(l.items[0]!.ask, "x".repeat(500));
  });
});

describe("holdAsks", () => {
  it("lists the operator's holds on items, in the snapshot's order, and nothing else", () => {
    const holds = parseHolds(body(snapshot([wip, { ...human, operator: false, item: "cgwalters-forge/tracker#1", url: "https://github.com/cgwalters-forge/tracker/issues/1" }, human])))!;
    assert.deepEqual(holdAsks(holds).map((a) => [a.key, a.ask, a.priority, a.action]), [["cgwalters-forge/tracker#446", "Ship it?", "P0", { type: "issue", repository: "cgwalters-forge/tracker", number: 446 }]]);
  });
});

describe("loadHolds", () => {
  it("reads the usage issue's comments once, and no item's comments", async () => {
    const { fetchImpl, calls } = scriptedFetch((_m, url) => (url.endsWith(usagePath) ? { body: [comment(snapshot())] } : undefined));
    assert.equal((await loadHolds(new GitHub(async () => "t", fetchImpl)))?.holds.length, 2);
    assert.equal(calls.length, 1);
  });

  for (const status of [403, 404, 500]) it(`throws on HTTP ${status}, for the inbox to say`, async () => {
    const { fetchImpl } = scriptedFetch((_m, url) => (url.endsWith(usagePath) ? { status, body: { message: "Not Found" } } : undefined));
    await assert.rejects(loadHolds(new GitHub(async () => "t", fetchImpl)));
  });
});
