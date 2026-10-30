// The daily cost reports agent-board publishes to tracker's data branch:
// parsing as published, missing and unreadable days, and review accounting.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { type CostData, type CostEntry, costDates, costSeries, loadCost, MODEL_SERIES, parseCostDay, reviewShare, seriesCell, topRuns } from "../src/github/cost.ts";
import { USAGE_CONFIG } from "../src/github/usage.ts";
import { fixture, installDom, scriptedFetch } from "./helpers.ts";

installDom();

// agent-board's fixtures/cost/report-2026-10-28.json, the recorded day its tests read.
const report = () => fixture<Record<string, unknown> & { runs: Record<string, unknown>[] }>("cost-day.json");
const DATE = "2026-10-28";
const NOW = Date.parse("2026-10-29T12:00:00Z");
const source = { repo: "example/tracker", ref: "data" };

describe("parseCostDay", () => {
  it("reads a day as agent-board publishes it", () => {
    const day = parseCostDay(report(), DATE)!;
    assert.deepEqual(day.totals, { runs: 3, tokens: 1005800, usd: 0.96, unpricedRuns: 1 });
    assert.deepEqual(day.byKind.review, { runs: 1, tokens: 413800, usd: null, unpricedRuns: 1 });
    assert.deepEqual(Object.keys(day.byModel), ["anthropic/claude-x", "praxis/gpt-6.1-sol"]);
    assert.deepEqual(
      day.runs.map((r) => [r.id, r.kind, r.usd]),
      [[40811000001, "implement", 0.87], [40811000002, "triage", 0.09], [40812885249, "review", null]],
    );
    assert.equal(day.runs[2]!.url, "https://github.com/cgwalters-forge/agent-board/actions/runs/40812885249");
  });

  it("takes nothing for another schema or day, or malformed totals", () => {
    for (const edit of [{ schema: "agent-board/cost-day/v2" }, { date: "2026-10-27" }, { totals: { runs: 1 } }, { totals: { ...report().totals as object, usd: "1" } }]) {
      assert.equal(parseCostDay({ ...report(), ...edit }, DATE), undefined, JSON.stringify(edit));
    }
    assert.equal(parseCostDay(null, DATE), undefined);
  });

  it("drops a malformed run or group, not the day", () => {
    const run = report().runs[0]!;
    for (const edit of [{ url: "https://evil.example/actions/runs/40811000001" }, { url: "https://github.com/a/b/actions/runs/1" }, { url: "javascript:alert(1)" }, { kind: "<b>" }, { repo: "../x" }, { usd: -1 }, { usd: "0.5" }, { tokens: { input: 1 } }, { id: 1.5 }]) {
      const day = parseCostDay({ ...report(), runs: [{ ...run, ...edit }] }, DATE);
      assert.deepEqual(day?.runs, [], JSON.stringify(edit));
    }
    const day = parseCostDay({ ...report(), by_kind: { review: { runs: 1 }, bogus: report().totals, implement: report().totals } }, DATE);
    assert.deepEqual(Object.keys(day!.byKind), ["implement"]);
  });
});

/** The charted days with the fixture as the last, and `more` published by date. */
function entries(more: Record<string, Record<string, unknown>> = {}): CostEntry[] {
  return costDates(NOW).map((date) => {
    const raw = date === DATE ? report() : more[date];
    const day = raw && parseCostDay({ ...raw, date }, date);
    return day ? { date, day } : { date };
  });
}

describe("the charted days", () => {
  it("are the 14 days before today, oldest first", () => {
    const dates = costDates(NOW);
    assert.equal(dates.length, 14);
    assert.deepEqual([dates[0], dates.at(-1)], ["2026-10-15", DATE]);
  });

  it("give the review share of priced spend, counting unpriced reviews apart", () => {
    // The fixture's review is unpriced: no share, not 0%.
    assert.deepEqual(reviewShare(entries()), { days: 1, unpricedRuns: 1, unpricedTokens: 413800 });
    const priced = { ...report(), totals: { ...report().totals as object, usd: 4 }, by_kind: { review: { runs: 1, tokens: (report().totals as { tokens: unknown }).tokens, usd: 3, unpriced_runs: 0 } }, runs: [] };
    const week = Object.fromEntries(["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"].map((d) => [d, priced]));
    // 6 days of $3 of $4, and the fixture's $0.96 with no priced review: 18 of 24.96.
    assert.deepEqual(reviewShare(entries(week)), { days: 7, share: 18 / 24.96, unpricedRuns: 1, unpricedTokens: 413800 });
  });

  it("say so when nothing is published or priced", () => {
    const none = costDates(NOW).map((date) => ({ date }));
    assert.deepEqual(reviewShare(none), { days: 0, unpricedRuns: 0, unpricedTokens: 0 });
    const unpriced = { ...report(), totals: { ...report().totals as object, usd: null } };
    assert.deepEqual(reviewShare(entries({ "2026-10-27": unpriced }).slice(0, -1)), { days: 1, unpricedRuns: 1, unpricedTokens: 413800 });
  });

  it("stack by kind in a fixed order, or by model, costliest first", () => {
    assert.deepEqual(costSeries(entries(), "kind").map((s) => s.label), ["review", "implement", "triage", "fix", "planning", "supervisor", "other"]);
    assert.deepEqual(costSeries(entries(), "model").map((s) => s.label), ["anthropic/claude-x", "praxis/gpt-6.1-sol"]);
    const many = { ...report(), by_model: Object.fromEntries(Array.from({ length: MODEL_SERIES + 2 }, (_, i) => [`m${i}`, report().totals])) };
    assert.equal(costSeries(entries({ "2026-10-27": many }), "model").at(-1)?.label, "4 other models");
  });

  it("show an unpriced group as tokens, never $0", () => {
    const day = parseCostDay(report(), DATE)!;
    const [review, implement] = costSeries([], "kind");
    assert.equal(seriesCell(day, "kind", review!)?.usd, null);
    assert.equal(seriesCell(day, "kind", review!)?.tokens, 413800);
    assert.equal(seriesCell(day, "kind", implement!)?.usd, 0.87);
    assert.deepEqual(seriesCell(day, "kind", costSeries([], "kind")[3]!), { runs: 0, tokens: 0, usd: null, unpricedRuns: 0 });
  });

  it("list the day's runs priced first, then unpriced by tokens", () => {
    assert.deepEqual(topRuns(parseCostDay(report(), DATE)!).map((r) => r.id), [40811000001, 40811000002, 40812885249]);
  });
});

describe("loadCost", () => {
  const sha = (c: string) => c.repeat(40);
  const blob = (v: unknown) => ({ encoding: "base64", content: Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64") });
  const run = async (listing: { status?: number; body?: unknown }, blobs: Record<string, unknown> = {}) => {
    const { fetchImpl, calls } = scriptedFetch((_m, url) => {
      const path = new URL(url).pathname;
      if (path === "/repos/example/tracker/contents/cost") return listing;
      const b = /\/git\/blobs\/(\w+)$/.exec(path);
      return b && b[1]! in blobs ? { body: blob(blobs[b[1]!]) } : undefined;
    });
    const data = await loadCost(new GitHub(async () => "t", fetchImpl), NOW, source);
    return { data, paths: calls.map((c) => new URL(c.url).pathname + new URL(c.url).search) };
  };

  it("reads the charted days' files from the listing, and marks the rest missing or unreadable", async () => {
    const { data, paths } = await run(
      {
        body: [
          { name: `${DATE}.json`, sha: sha("a"), size: 4562 },
          { name: "2026-10-27.json", sha: sha("b"), size: 20 },
          { name: "2026-10-26.json", sha: sha("c"), size: 3 * 1024 * 1024 },
          { name: "2026-10-25.json", sha: sha("d"), size: 20 },
          { name: "2026-09-01.json", sha: sha("e"), size: 20 },
        ],
      },
      { [sha("a")]: report(), [sha("b")]: "not json", [sha("d")]: { ...report(), date: "2026-10-24" } },
    );
    assert.equal(paths[0], "/repos/example/tracker/contents/cost?ref=data");
    assert.deepEqual(paths.slice(1).sort(), [sha("a"), sha("b"), sha("d")].map((s) => `/repos/example/tracker/git/blobs/${s}`), "only the charted days' files that fit are read");
    assert.equal(data?.state, "ok");
    const days = (data as Extract<CostData, { state: "ok" }>).days;
    assert.equal(days.length, 14);
    assert.equal(days.at(-1)?.day?.totals.usd, 0.96);
    assert.deepEqual(days.slice(-4, -1), [{ date: "2026-10-25", unreadable: true }, { date: "2026-10-26", unreadable: true }, { date: "2026-10-27", unreadable: true }]);
    assert.deepEqual(days[0], { date: "2026-10-15" }, "a day not published is missing");
  });

  it("finds none where the branch or directory isn't there, and fails on other errors", async () => {
    assert.deepEqual((await run({ status: 404, body: { message: "No commit found for the ref data" } })).data, { state: "none" });
    await assert.rejects(run({ status: 500, body: { message: "x" } }));
  });

  it("marks a day whose file fails to read unreadable, keeping the others", async () => {
    // The scripted fetch throws for an unrouted blob, as a network error would.
    const { data } = await run({ body: [{ name: `${DATE}.json`, sha: sha("a"), size: 4562 }, { name: "2026-10-27.json", sha: sha("b"), size: 20 }] }, { [sha("a")]: report() });
    const days = (data as Extract<CostData, { state: "ok" }>).days;
    assert.deepEqual(days.at(-2), { date: "2026-10-27", unreadable: true });
    assert.equal(days.at(-1)?.day?.date, DATE);
  });

  it("reads nothing when off, or for a source that isn't a plain repository and branch", async () => {
    assert.deepEqual(USAGE_CONFIG.cost, { repo: "cgwalters-forge/tracker", ref: "data" });
    const { fetchImpl, calls } = scriptedFetch(() => undefined);
    const gh = new GitHub(async () => "t", fetchImpl);
    for (const s of [null, { repo: "../..", ref: "data" }, { repo: "example/tracker", ref: "../main" }]) assert.equal(await loadCost(gh, NOW, s), undefined);
    assert.equal(calls.length, 0);
  });
});
