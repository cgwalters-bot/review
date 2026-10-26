import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import type { RawComment } from "../src/github/heartbeat.ts";
import { findHolds, HOLDS_MARKER, loadHolds, parseHolds } from "../src/github/holds.ts";
import { usagePath } from "../src/github/usage.ts";
import { scriptedFetch } from "./helpers.ts";

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

describe("loadHolds", () => {
  const load = (status: number) => {
    const { fetchImpl } = scriptedFetch((_m, url) => (url.endsWith(usagePath) ? { status, body: status === 200 ? [comment(snapshot())] : { message: "Not Found" } } : undefined));
    return loadHolds(new GitHub(async () => "t", fetchImpl));
  };
  it("reads the usage issue", async () => assert.equal((await load(200))?.holds.length, 2));
  for (const status of [403, 404, 500]) it(`gets no holds on HTTP ${status}`, async () => assert.equal(await load(status), undefined));
});
