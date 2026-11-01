import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { ResponseCache } from "../src/github/cache.ts";
import { coresOf, jobsFinal, loadActive, outcomeOf, type RawJob } from "../src/github/ops.ts";
import { fields, fixture, scriptedFetch } from "./helpers.ts";

const NOW = Date.parse("2026-09-28T15:12:05Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const HEARTBEAT_PATH = "/repos/cgwalters-forge/tracker/issues/176/comments";
const USAGE_PATH = "/repos/cgwalters-forge/bot-ops/issues/1/comments";

describe("coresOf", () => {
  const cases: [string[] | undefined, number | undefined][] = [
    [["rhel10-x86_64-4c-16g"], 4],
    [["rhel10-x86_64-16c-64g"], 16],
    [["self-hosted", "rhel10-x86_64-64c-256g"], 64],
    [["ubuntu-latest"], undefined],
    [["x86_64-abc-16g"], undefined],
    [undefined, undefined],
  ];
  for (const [labels, want] of cases) it(JSON.stringify(labels), () => assert.equal(coresOf(labels), want));
});

describe("outcomeOf", () => {
  const cases: [string | null, string][] = [
    ["cancelled", "stopped"],
    ["success", "expired"],
    ["failure", "failed"],
    ["timed_out", "failed"],
    ["startup_failure", "failed"],
    ["skipped", "other"],
    [null, "other"],
  ];
  for (const [c, want] of cases) it(String(c), () => assert.equal(outcomeOf(c), want));
});

it("takes a cached jobs copy as final only if its jobs of this attempt completed", async () => {
  const done = (attempt?: number) => ({ status: "completed", completed_at: "2026-09-28T15:04:10Z", ...(attempt ? { run_attempt: attempt } : {}) });
  const cases: [string, RawJob[], number, boolean][] = [
    ["completed", [done()], 1, true],
    ["completed, same attempt", [done(2)], 2, true],
    ["an earlier attempt's", [done(1)], 2, false],
    ["still running", [{ status: "in_progress", completed_at: null }], 1, false],
    ["one of two running", [done(), { status: "in_progress" }], 1, false],
    ["no jobs", [], 1, false],
  ];
  for (const [name, jobList, attempt, final] of cases) assert.equal(jobsFinal(jobList, attempt), final, name);

  // A copy cached while the run was going is read again, whatever the clocks say.
  let n = 0;
  const { fetchImpl, calls } = scriptedFetch(() => ({ body: { jobs: n++ === 0 ? [{ status: "in_progress", completed_at: null }] : [done()] }, headers: { etag: `"${n}"` } }));
  const gh = new GitHub(async () => "t", fetchImpl, new ResponseCache());
  const isFinal = (d: { jobs?: RawJob[] }) => jobsFinal(d.jobs, 1);
  await gh.get("/jobs");
  await assert.rejects(gh.cacheOnly().getSettled("/jobs", isFinal), /not cached in its final state/);
  assert.equal(jobsFinal((await gh.getSettled("/jobs", isFinal)).data.jobs, 1), true);
  const before = calls.length;
  await gh.getSettled("/jobs", isFinal);
  assert.equal(calls.length, before, "a final copy is used without asking GitHub");
  // A final copy doesn't make a cache-only read look old.
  const cached = gh.cacheOnly();
  await cached.getSettled("/jobs", isFinal);
  assert.equal(cached.oldest, undefined);
});

it("keeps parallel cached source ages separate from each other and earlier reads", async () => {
  const { fetchImpl, calls } = scriptedFetch((_m, url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/projectsV2/1/fields")) return { body: fields() };
    if (path.endsWith("/projectsV2/1/items")) return { body: [] };
    if (path === HEARTBEAT_PATH) return { body: fixture<unknown[]>("heartbeat-comments.json") };
    if (path === USAGE_PATH) return { body: fixture<unknown[]>("usage-comments.json") };
    return undefined;
  });
  const cache = new ResponseCache({ now: () => NOW });
  const gh = new GitHub(async () => "t", fetchImpl, cache);
  await loadActive(gh, NOW);
  for (const url of new Set(calls.map((call) => call.url))) {
    const entry = await cache.get(url);
    if (!entry) continue;
    const path = new URL(url).pathname;
    const age = path === HEARTBEAT_PATH ? 5 * MIN : path === USAGE_PATH ? 30 * MIN : path.endsWith("/fields") ? 2 * HOUR : HOUR;
    cache.put(url, { ...entry, fetchedAt: NOW - age }, JSON.stringify(entry.data).length);
  }
  const cached = gh.cacheOnly();
  const older = "https://api.github.com/earlier-read";
  cache.put(older, { data: [], fetchedAt: NOW - 3 * HOUR }, 2);
  await cached.get(older);
  const before = calls.length;
  const active = await loadActive(cached, NOW);
  assert.equal(active.sources?.board?.fetchedAt, NOW - 2 * HOUR, "board uses its oldest page");
  assert.equal(active.sources?.heartbeat?.fetchedAt, NOW - 5 * MIN);
  assert.equal(active.sources?.usage?.fetchedAt, NOW - 30 * MIN);
  for (const name of ["board", "heartbeat", "usage"]) assert.equal(active.sources?.[name]?.state, "cached");
  assert.equal(cached.oldest, NOW - 3 * HOUR, "the aggregate age remains available to existing callers");
  assert.equal(calls.length, before, "scoped cached reads never touch the network");
});
