import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import type { RawComment } from "../src/github/heartbeat.ts";
import { findUsage, loadUsage, parseUsage, tokenTotal, USAGE_MARKER, usagePath } from "../src/github/usage.ts";
import { fixture, scriptedFetch } from "./helpers.ts";

// The fixture's second comment is what bin/bot-heartbeat publish
// --dry-run wrote to the private repository for a sample heartbeat; the
// first is someone else's copy of it, with other numbers.
const comments = () => fixture<RawComment[]>("usage-comments.json");
const body = (json: unknown) => `${USAGE_MARKER}\ntext\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
const tokens = { input: 1, output: 2, cache_read: 3, cache_write: 4 };
const win = { kind: "five_hour", since: "2026-09-28T10:05:00Z", used_percent: 42.5, resets_at: "2026-09-28T15:05:00Z", requests: 7, tokens };
const valid = () => ({ schema: "bot-usage/v1", updated_at: "2026-09-28T15:05:00Z", session: "s-1", windows: [win], workers: [{ name: "w", tokens }] });

describe("findUsage", () => {
  it("reads the bot's comment as bot-heartbeat writes it, not a copy by someone else", () => {
    assert.deepEqual(findUsage(comments()), {
      updatedAt: "2026-09-28T15:05:00Z",
      observedAt: "2026-09-28T15:04:00Z",
      windows: [
        { kind: "five_hour", since: "2026-09-28T12:00:00Z", usedPercent: 42.5, resetsAt: "2026-09-28T17:00:00Z", requests: 4, tokens: { input: 100, output: 219000, cacheRead: 43800000, cacheWrite: 1440000 } },
        { kind: "seven_day", since: "2026-09-24T09:00:00Z", usedPercent: 63, resetsAt: "2026-10-01T09:00:00Z", requests: 5, tokens: { input: 200, output: 619000, cacheRead: 133800000, cacheWrite: 4440000 } },
      ],
      coordinatorTokens: { input: 40, output: 30000, cacheRead: 9000000, cacheWrite: 200000 },
      workers: [
        { name: "ops-v2", tokens: { input: 20, output: 60000, cacheRead: 4000000, cacheWrite: 150000 } },
        { name: "bootc-2482", tokens: { input: 10, output: 9000, cacheRead: 800000, cacheWrite: 90000 } },
      ],
      commentUrl: "https://github.com/cgwalters-forge/bot-ops/issues/1#issuecomment-2",
    });
  });
  it("finds nothing among others' comments", () => assert.equal(findUsage(comments().slice(0, 1)), undefined));
});

describe("parseUsage", () => {
  it("accepts pool-only publications and drops malformed pools independently", () => {
    const raw = fixture<{ pools: Record<string, Record<string, unknown>> }>("usage-pools.json");
    assert.equal(parseUsage(body(raw))?.pools?.openai?.usedPercent, 80);
    for (const edit of [{ used_percent: -1 }, { allowed_percent: "30" }, { resets_at: "soon" }, { observed_at: null }, { hold: "true" }]) {
      const parsed = parseUsage(body({ ...raw, pools: { ...raw.pools, openai: { ...raw.pools.openai, ...edit } } }));
      assert.equal(parsed?.pools?.openai, undefined);
      assert.equal(parsed?.pools?.claude?.usedPercent, 42);
    }
  });

  it("reads Mistral's counters when well formed, and shows nothing otherwise", () => {
    const raw = fixture<{ mistral?: unknown }>("usage-pools.json");
    assert.deepEqual(parseUsage(body(raw))?.mistral, { requests: 2500, tokens: 1234567 });
    for (const bad of [undefined, null, "x", {}, { requests: 2 }, { requests: -1, tokens: 5 }, { requests: 2, tokens: "5" }]) {
      assert.equal(parseUsage(body({ ...raw, mistral: bad }))?.mistral, undefined, JSON.stringify(bad));
    }
  });

  it("reads Mistral's allowance: its own spend first, else an estimate from tokens and prices", () => {
    const raw = fixture<{ mistral: Record<string, unknown> }>("usage-pools.json");
    const limit = { limit_usd: 300, resets_at: "2026-11-01T12:00:00Z" };
    const models = [
      { model: "mistral-large-latest", input_tokens: 1_000_000, output_tokens: 100_000 },
      { model: "codestral-latest", input_tokens: 500_000, output_tokens: 0 },
    ];
    const prices = { "mistral-large-latest": { input: 2, output: 6 }, "codestral-latest": { input: 0.3, output: 0.9 } };
    const allowance = (a: unknown) => parseUsage(body({ ...raw, mistral: { ...raw.mistral, allowance: a } }))?.mistral;
    assert.deepEqual(allowance({ ...limit, spent_usd: 0.92, models, prices })?.allowance, { limitUsd: 300, resetsAt: limit.resets_at, spentUsd: 0.92, estimated: false, unpriced: [], lowerBound: false });
    const est = allowance({ ...limit, models, prices })?.allowance;
    assert.equal(est?.estimated, true);
    assert.ok(Math.abs(est!.spentUsd - 2.75) < 1e-9, String(est?.spentUsd));
    assert.deepEqual(est?.unpriced, []);
    assert.equal(est?.lowerBound, false);
    assert.deepEqual(allowance({ ...limit, models: [], prices })?.allowance?.spentUsd, 0, "a month with no tokens yet is $0, not no meter");
    // A malformed entry beside priced ones is left out, and says so.
    const bent = allowance({ ...limit, models: [...models, { model: "mistral/large", input_tokens: 5e7, output_tokens: 0 }], prices })?.allowance;
    assert.deepEqual([bent?.unpriced, bent?.lowerBound], [[], true]);
    // A model without a price leaves a lower bound; one named like an Object property finds no price there.
    const partial = allowance({ ...limit, models: [...models, { model: "constructor", input_tokens: 5, output_tokens: 5 }], prices })?.allowance;
    assert.deepEqual([partial?.unpriced, partial?.lowerBound], [["constructor"], true]);
    assert.ok(Math.abs(partial!.spentUsd - 2.75) < 1e-9);
    // No allowance, or one that can't give a spend, keeps the counters alone.
    for (const bad of [undefined, {}, { ...limit, limit_usd: 0, spent_usd: 1 }, { ...limit, resets_at: "soon", spent_usd: 1 }, { ...limit, spent_usd: -1 }, { ...limit, spent_usd: "1" }, { ...limit, models }, { ...limit, models, prices: {} }, { ...limit, models: [{ model: "<b>", input_tokens: 1, output_tokens: 1 }], prices }]) {
      assert.deepEqual(allowance(bad), { requests: 2500, tokens: 1234567 }, JSON.stringify(bad));
    }
    const capped = allowance({ ...limit, models: Array.from({ length: 40 }, (_, i) => ({ ...models[0], model: `m${i}` })), prices: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`m${i}`, prices["mistral-large-latest"]])) })?.allowance;
    assert.deepEqual([capped?.spentUsd.toFixed(2), capped?.lowerBound], [(32 * 2.6).toFixed(2), true], "at most 32 models count, and the rest make it a lower bound");
  });

  // (edit, windows kept, whether the first has a percent, workers kept)
  type Json = ReturnType<typeof valid>;
  const cases: [string, (j: Json) => unknown, number | undefined, boolean?, number?][] = [
    ["valid", (j) => j, 1, true, 1],
    ["another schema (the heartbeat's)", (j) => ({ ...j, schema: "bot-heartbeat/v1" }), undefined],
    ["no updated_at", (j) => ({ ...j, updated_at: "now" }), undefined],
    ["no percent: tokens only", (j) => ({ ...j, windows: [{ ...win, used_percent: undefined, resets_at: undefined }] }), 1, false],
    ["a percent without its reset is dropped", (j) => ({ ...j, windows: [{ ...win, resets_at: "soon" }] }), 1, false],
    ["an absurd percent is dropped", (j) => ({ ...j, windows: [{ ...win, used_percent: 5000 }] }), 1, false],
    ["a newer kind, shown as is", (j) => ({ ...j, windows: [{ ...win, kind: "seven_day_opus" }] }), 1, true],
    ["markup in a kind", (j) => ({ ...j, windows: [{ ...win, kind: "<b>x</b>" }] }), undefined],
    ["negative tokens", (j) => ({ ...j, windows: [{ ...win, tokens: { ...tokens, output: -1 } }] }), undefined],
    ["tokens as text", (j) => ({ ...j, windows: [{ ...win, tokens: { ...tokens, input: "1" } }] }), undefined],
    ["windows not a list", (j) => ({ ...j, windows: {} }), undefined],
    ["too many windows", (j) => ({ ...j, windows: Array.from({ length: 9 }, () => win) }), 4, true],
    ["markup in a worker's name", (j) => ({ ...j, workers: [{ name: "<img src=x>", tokens }] }), 1, true, 0],
    ["a worker's absurd tokens", (j) => ({ ...j, workers: [{ name: "w", tokens: { ...tokens, output: Number.MAX_VALUE } }] }), 1, true, 0],
    ["no workers", (j) => ({ ...j, workers: undefined }), 1, true, 0],
  ];
  for (const [what, edit, windows, pct, workers] of cases) {
    it(what, () => {
      const u = parseUsage(body(edit(valid())));
      assert.equal(u?.windows.length, windows);
      if (pct !== undefined) assert.equal(u?.windows[0]?.usedPercent !== undefined, pct);
      if (workers !== undefined) assert.equal(u?.workers.length, workers);
    });
  }
  it("needs its marker", () => assert.equal(parseUsage(body(valid()).replace(USAGE_MARKER, "")), undefined));
  it("totals tokens", () => assert.equal(tokenTotal({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 10));
});

describe("loadUsage", () => {
  const load = async (status: number, list: unknown = comments()) => {
    const { fetchImpl, calls } = scriptedFetch((_m, url) => (url.endsWith(usagePath) ? { status, body: status === 200 ? list : { message: "x" } } : undefined));
    const data = await loadUsage(new GitHub(async () => "t", fetchImpl)).catch((e: Error) => e);
    return { data, path: new URL(calls[0]?.url ?? "").pathname };
  };
  it("reads the private repository's issue", async () => {
    const { data, path } = await load(200);
    assert.equal(path, "/repos/cgwalters-forge/bot-ops/issues/1/comments");
    assert.equal(!(data instanceof Error) && data.state, "ok");
  });
  it("says when none is published", async () => assert.deepEqual((await load(200, [])).data, { state: "none" }));
  for (const status of [403, 404]) it(`a ${status} is unreadable, not an error`, async () => assert.deepEqual((await load(status)).data, { state: "unreadable" }));
  it("any other failure is an error", async () => assert.ok((await load(500)).data instanceof Error));
});
