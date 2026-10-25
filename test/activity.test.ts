import assert from "node:assert/strict";
import { it } from "node:test";
import { activityEntries, type ActivityData, NEWS_POLL_MS } from "../src/github/activity.ts";
import { activityList } from "../src/github/activityview.ts";
import { GitHub } from "../src/github/api.ts";
import { parseItem } from "../src/github/board.ts";
import { snapshotOf } from "../src/github/boardfeed.ts";
import { parseNewsPull } from "../src/github/news.ts";
import { botEvents, loadEvents } from "../src/github/ops.ts";
import { SourceLayer } from "../src/github/sourcelayer.ts";
import { tickAges } from "../src/github/view.ts";
import { installDom, rawItems } from "./helpers.ts";

installDom();
const NOW = Date.parse("2026-10-25T12:00:00Z");
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const event = { id: "1", type: "IssuesEvent", created_at: at(4), repo: { name: "cgwalters-forge/review" }, payload: { action: "opened", issue: { number: 158, title: "Activity" } } };

function fixture(): ActivityData {
  const item = { ...parseItem(rawItems()[0]!), movedAt: at(2), title: "Board transition" };
  return {
    board: [item], seen: snapshotOf([{ ...item, status: "Other" }], NOW - 3600_000),
    news: { items: [parseNewsPull("cgwalters-forge/review", { number: 157, html_url: "https://github.com/cgwalters-forge/review/pull/157", title: "Merged change", merged_at: at(1) })!], warnings: [], changed: true },
    events: botEvents([event]),
    dispatch: { state: "ok", at: NOW, live: [], finished: [{ id: 10, title: "implement cgwalters-forge/review#158 (openai)", status: "completed", conclusion: "success", url: "https://github.com/cgwalters-forge/tracker/actions/runs/10", startedAt: at(30), updatedAt: at(3) }], warnings: [] },
  };
}

it("interleaves all four sources newest first and ticks relative times in place", () => {
  const data = fixture();
  assert.deepEqual(activityEntries(data).map(e => e.kind), ["merge", "board", "run", "event"]);
  const root = activityList(data, false, () => document.createDocumentFragment(), NOW);
  assert.equal(root.querySelectorAll(".activity-item").length, 4);
  const times = [...root.querySelectorAll<HTMLElement>(".age")];
  assert.deepEqual(times.map(t => t.textContent), ["1m ago", "2m", "3m ago", "4m ago"]);
  assert.ok(times.every(t => t.title));
  tickAges(root, NOW + 60_000);
  assert.deepEqual(times.map(t => t.textContent), ["2m ago", "3m", "4m ago", "5m ago"]);
});

it("keeps unknown board times last and applies urgent filtering only to board changes", () => {
  const data = fixture();
  data.board = data.board!.map(item => { const { movedAt, updatedAt, ...rest } = item; return { ...rest, priority: "P2" }; });
  data.seen = snapshotOf(data.board.map(item => ({ ...item, status: "Other" })), NOW - 3600_000);
  assert.equal(activityEntries(data).at(-1)?.at, undefined);
  assert.deepEqual(activityEntries(data, true).map(e => e.kind), ["merge", "run", "event"]);
});

it("honours X-Poll-Interval on 200 and 304, including shared concurrent reads", async () => {
  let calls = 0;
  const gh = new GitHub(async () => "fixture", async () => {
    calls++;
    if (calls === 1) return Response.json([event], { headers: { etag: '"events"', "X-Poll-Interval": "180" } });
    return new Response(null, { status: 304, headers: { "X-Poll-Interval": "300" } });
  });
  await Promise.all([loadEvents(gh, NOW), loadEvents(gh, NOW)]);
  assert.equal(calls, 1);
  await loadEvents(gh, NOW + 179_999);
  assert.equal(calls, 1);
  await loadEvents(gh, NOW + 180_000);
  assert.equal(calls, 2);
  await loadEvents(gh, NOW + 479_999);
  assert.equal(calls, 2);
  await loadEvents(gh, NOW + 480_000);
  assert.equal(calls, 3);
});

it("uses the five-minute merged PR cadence only while Activity is visible", async () => {
  let view = "agents", reads = 0;
  const layer = new SourceLayer([{ name: "news", path: "merged PRs", cadence: NEWS_POLL_MS, views: ["activity"], read: async () => { reads++; } }], () => view);
  const tick = async (now: number) => { layer.tick(false, now); await new Promise(resolve => setImmediate(resolve)); };
  await tick(NOW);
  assert.equal(reads, 0);
  view = "activity";
  await tick(NOW);
  await tick(NOW + 299_999);
  assert.equal(reads, 1);
  await tick(NOW + 300_000);
  assert.equal(reads, 2);
});
