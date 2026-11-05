import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import type { Active } from "../src/github/agents.ts";
import type { RawComment } from "../src/github/heartbeat.ts";
import { HOLDS_MARKER, loadPublications } from "../src/github/holds.ts";
import { findPasses, MAX_BODY, nothingReady, type Passes, PASSES_MARKER, parsePasses, redactAddresses } from "../src/github/passes.ts";
import { countdown, type PassesRead, passesView, readPasses } from "../src/github/passesview.ts";
import { usagePath } from "../src/github/usage.ts";
import { fixture, installDom, scriptedFetch } from "./helpers.ts";

installDom();

type Raw = Record<string, any>;
/** The producer's contract fixture (docs/passes.md); each test changes its own copy. */
const raw = (): Raw => fixture<Raw>("passes.json");
const body = (json: unknown) => `${PASSES_MARKER}\nRecent passes. Written by \`agent-board pass\`; the review app reads the JSON below.\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
const comment = (json: unknown, login = "cgwalters-bot"): RawComment => ({ user: { login }, body: body(json) });
const parsed = (json: unknown = raw()): Passes => {
  const p = parsePasses(body(json));
  assert.equal(typeof p, "object", String(p));
  return p as Passes;
};
const NOW = Date.parse("2026-11-05T12:00:00Z");
const view = (read: PassesRead, now = NOW) => passesView(read, now);
const text = (el: Element) => el.textContent ?? "";

describe("parsePasses", () => {
  it("reads every record of the contract fixture, newest first", () => {
    const p = parsed();
    assert.equal(p.passes.length, 5);
    assert.equal(p.unreadable, 0);
    assert.deepEqual(p.passes.map((x) => x.result), ["success", "success", "partial", "failure", "success"]);
    assert.deepEqual(p.passes[1]!.starts.map((s) => s.state), ["confirmed", "confirmed", "uncertain"]);
    assert.deepEqual(p.passes[0]!.noStart.map((r) => r.reason), ["no-ready-work", "replan-wait", "held"]);
    assert.equal(typeof p.pools, "object");
    assert.equal(typeof p.inFlight, "object");
  });

  it("is undefined without the marker, and says why for one that can't be used", () => {
    assert.equal(parsePasses(undefined), undefined);
    assert.equal(parsePasses(`hi\n${body(raw())}`), undefined);
    assert.match(String(parsePasses(body({ ...raw(), schema: "agent-board/passes/v2" }))), /unknown schema agent-board\/passes\/v2/);
    assert.match(String(parsePasses(body({ ...raw(), published_at: "today" }))), /malformed header/);
    assert.match(String(parsePasses(body({ ...raw(), passes: Array(11).fill(raw().passes[0]) }))), /more than 10 passes/);
    assert.match(String(parsePasses(`${PASSES_MARKER}\n${"x".repeat(MAX_BODY)}`)), /over 60000 characters/);
    assert.match(String(parsePasses(`${PASSES_MARKER}\nno fence`)), /no JSON object/);
  });

  // name, a change to the first pass record: each makes that record unreadable, not the others.
  const unreadable: [string, (p: Raw) => void][] = [
    ["a failed section without its error", (p) => { p.sections[0] = { name: "epics", outcome: "failed", error: null }; }],
    ["an ok section with an error", (p) => { p.sections[0].error = "HTTP 503"; }],
    ["a multi-line error", (p) => { p.sections[0] = { name: "epics", outcome: "failed", error: "HTTP 503\nbody follows" }; }],
    ["an error past 200 characters", (p) => { p.sections[0] = { name: "epics", outcome: "failed", error: "x".repeat(201) }; }],
    ["a re-plan wait without its time", (p) => { p.no_start[1].until = null; }],
    ["an item that is a URL", (p) => { p.no_start[1].item = "javascript:alert(1)#1"; }],
    ["a run repository that climbs", (p) => { p.run.repository = "../x"; }],
    ["a run id past safe integers", (p) => { p.run.id = Number.MAX_SAFE_INTEGER + 1; }],
    ["a preview start in an applying pass", (p) => { p.starts = [{ state: "preview", item: "a/b#1", kind: "implement", pool: null, run: null }]; }],
    ["a finish before its start", (p) => { p.finished_at = "2026-11-05T11:00:00Z"; }],
    ["more starts than 20", (p) => { p.starts = Array(21).fill({ state: "confirmed", item: "a/b#1", kind: "implement", pool: null, run: null }); }],
    ["a negative count", (p) => { p.candidates.unread = -1; }],
    ["an unknown result", (p) => { p.result = "green"; }],
  ];
  for (const [name, change] of unreadable) it(`leaves out and counts ${name}`, () => {
    const json = raw();
    change(json.passes[0]);
    const p = parsed(json);
    assert.equal(p.unreadable, 1);
    assert.equal(p.passes.length, 4);
  });

  it("reads an unknown start state as uncertain and a preview run as unreadable", () => {
    const json = raw();
    json.passes[1].starts[0].state = "accepted-maybe";
    json.passes[4].starts[0].run = { repository: "a/b", id: 1 };
    const p = parsed(json);
    assert.equal(p.passes[1]!.starts[0]!.state, "uncertain");
    assert.equal(p.unreadable, 1);
  });

  it("keeps the passes when pools or work in flight are malformed, and those unknown", () => {
    const json = raw();
    json.pools.items[0].used_percent = "12";
    json.in_flight.prs = Array(51).fill(json.in_flight.prs[0]);
    const p = parsed(json);
    assert.equal(p.passes.length, 5);
    assert.match(String(p.pools), /malformed/);
    assert.match(String(p.inFlight), /malformed/);
    const el = view({ data: p });
    assert.match(text(el), /Pool pace unreadable \(malformed or past its bounds\): unknown/);
    assert.match(text(el), /Work in flight unreadable/);
  });

  it("reads absent pools and work in flight as not published, never empty", () => {
    const json = raw();
    delete json.pools;
    json.in_flight = null;
    const el = view({ data: parsed(json) });
    assert.match(text(el), /Pool pace not published: unknown/);
    assert.match(text(el), /Work in flight not published: unknown/);
    assert.doesNotMatch(text(el), /None running/);
  });
});

describe("findPasses and loadPublications", () => {
  it("takes the bot's newest comment, never another author's", () => {
    const older = raw();
    const newer = { ...raw(), published_at: "2026-11-05T11:59:00Z" };
    const forged = { ...raw(), published_at: "2026-11-05T12:00:00Z" };
    const p = findPasses([comment(older), comment(newer), comment(forged, "someone")]);
    assert.equal((p as Passes).publishedAt, "2026-11-05T11:59:00Z");
    assert.equal(findPasses([comment(raw(), "someone")]), undefined);
  });

  it("reads holds and passes from one request of the holds issue", async () => {
    const holds = { user: { login: "cgwalters-bot" }, body: `${HOLDS_MARKER}\n\n\`\`\`json\n${JSON.stringify({ schema: "agent-board/holds/v1", at: "2026-11-05T11:00:00Z", holds: [] })}\n\`\`\`\n` };
    const { fetchImpl, calls } = scriptedFetch((_m, url) => (url.endsWith(usagePath) ? { body: [holds, comment(raw())] } : undefined));
    const read = await loadPublications(new GitHub(async () => "t", fetchImpl));
    assert.equal(read.holds?.at, "2026-11-05T11:00:00Z");
    assert.equal((read.passes as Passes).passes.length, 5);
    assert.equal(calls.length, 1);
  });

  it("keeps the holds when the passes comment is malformed, and a full page without one is unknown", async () => {
    const holds = { user: { login: "cgwalters-bot" }, body: `${HOLDS_MARKER}\n\n\`\`\`json\n${JSON.stringify({ schema: "agent-board/holds/v1", at: "2026-11-05T11:00:00Z", holds: [] })}\n\`\`\`\n` };
    const bad = { user: { login: "cgwalters-bot" }, body: `${PASSES_MARKER}\n\n\`\`\`json\n{"schema":\n\`\`\`\n` };
    const load = async (comments: RawComment[]) => loadPublications(new GitHub(async () => "t", scriptedFetch((_m, url) => (url.endsWith(usagePath) ? { body: comments } : undefined)).fetchImpl));
    const read = await load([holds, bad]);
    assert.equal(read.holds?.at, "2026-11-05T11:00:00Z");
    assert.equal(read.passes, "no JSON object");
    assert.equal((await load([holds])).passes, undefined);
    const full = Array.from({ length: 99 }, (): RawComment => ({ user: { login: "someone" }, body: "hi" }));
    assert.match(String((await load([holds, ...full])).passes), /not among the issue's first 100 comments, so unknown/);
  });

  it("redacts an address in an unknown schema's name", () => {
    assert.equal(parsePasses(body({ ...raw(), schema: "http://100.64.1.2:9000/x" })), "unknown schema [address]");
  });
});

describe("redactAddresses", () => {
  const cases: [string, string][] = [
    ["connect https://inference.example:8443/v1/chat failed", "connect [address] failed"],
    ["broker at 100.64.1.2:9000 refused", "broker at [address] refused"],
    ["dial tcp 10.0.0.7: refused", "dial tcp [address]: refused"],
    ["lookup gpu-box.tail1234.ts.net: no such host", "lookup [address]: no such host"],
    ["dial [fd7a:115c:a1e0::1]:443 timed out", "dial [address] timed out"],
    ["localhost:11434 closed", "[address] closed"],
    ["HTTP 503 at 2026-11-05T12:30:00Z (12:30:00)", "HTTP 503 at 2026-11-05T12:30:00Z (12:30:00)"],
    ["API rate limit exceeded", "API rate limit exceeded"],
    ["board_forge::pass::Error: closed", "board_forge::pass::Error: closed"],
    ["inference.example.com timed out", "[address] timed out"],
    ["connect to broker.internal refused", "connect to [address] refused"],
    ["lookup 100.64.1.2.nip.io failed", "lookup [address] failed"],
    ["fd7a::1 refused", "[address] refused"],
    ["dial tcp [::1]:11434", "dial tcp [address]"],
  ];
  for (const [input, want] of cases) it(`redacts ${JSON.stringify(input)}`, () => assert.equal(redactAddresses(input), want));

  it("applies to published errors before they show", () => {
    const json = raw();
    json.passes[2].sections[0].error = "POST http://100.100.1.1:8080/v1 refused by broker.tail9.ts.net";
    const el = view({ data: parsed(json) });
    assert.match(text(el), /pull-requests: POST \[address\] refused by \[address\]/);
    assert.doesNotMatch(text(el), /100\.100|tail9|8080/);
  });
});

describe("passesView", () => {
  it("shows the passes, their errors, starts and why nothing started", () => {
    const el = view({ data: parsed() });
    const t = text(el);
    for (const s of [
      "Published 1m ago",
      "no ready work (14 candidates read)",
      "waiting out the re-plan delay until",
      "(in 2h 30m)",
      "held (needs-human)",
      "Started 2, 1 uncertain",
      "uncertain: check the runs",
      "capped by wip",
      "pull-requests: API rate limit exceeded for installation",
      "schedule: cut short",
      "no ready work reported, but the pass did not read everything: unknown",
      "setup: HTTP 503 from the board",
      "Started nothing, and the pass published no reason: unknown.",
      "Would start at least 1",
      "Left out to fit: 2 starts.",
      "run not known",
    ]) assert.ok(t.includes(s), s);
    assert.deepEqual([...el.querySelectorAll(".pass-result")].map(text), ["success", "success", "partial", "failure", "success"]);
    assert.equal(el.querySelector("button, input, textarea, form, script, img"), null);
  });

  it("links only from typed references", () => {
    const hrefs = [...view({ data: parsed() }).querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const want of [
      "https://github.com/cgwalters-forge/tracker/actions/runs/42070000004/attempts/2",
      "https://github.com/cgwalters-forge/review/issues/245",
      "https://github.com/cgwalters-forge/tracker/actions/runs/42064057295",
      "https://github.com/cgwalters-forge/agent-board/pull/680",
      "https://github.com/cgwalters-forge/review/pull/244",
    ]) assert.ok(hrefs.includes(want), want);
    assert.ok(hrefs.every((h) => h?.startsWith("https://github.com/cgwalters-forge/")), hrefs.join(" "));
  });

  it("shows pool pace and resets, and flags only a pool well under pace with nothing ready", () => {
    const el = view({ data: parsed() });
    const pools = [...el.querySelectorAll(".pass-pool")].map(text);
    assert.match(pools[0]!, /openai 12\.5% used of 55% allowed · reset .*\(in 21h\) · ready 0 · read 2m ago well under pace with nothing ready/);
    assert.doesNotMatch(pools[1]!, /under pace/);
    assert.match(pools[1]!, /held/);
    assert.match(pools[2]!, /mistral unknown used of unknown allowed · reset unknown · ready unknown · held unknown/);
  });

  it("flags nothing ready only from complete evidence", () => {
    assert.equal(nothingReady(parsed(), NOW), true);
    const variants: ((j: Raw) => void)[] = [
      (j) => { j.passes[0].candidates.unread = 1; },
      (j) => { j.passes[0].candidates = null; },
      (j) => { j.pools.complete = false; },
      (j) => { j.pools.omitted = 1; },
      (j) => { j.passes[0].sections[1] = { name: "epics", outcome: "failed", error: "HTTP 502" }; },
      (j) => { j.passes[0].result = "failure"; },
      (j) => { j.passes[0].sections = []; },
      (j) => { j.passes[0].omitted.sections = 1; },
      // The newest record unreadable: an older record's evidence is not the newest pass's.
      (j) => { j.passes[0].mode = "newer-mode"; j.passes[1] = { ...j.passes[0], mode: "actions", started_at: "2026-11-05T11:40:00Z", finished_at: "2026-11-05T11:44:00Z" }; },
      (j) => { j.omitted = 1; },
      (j) => { j.pools.items[0].observed_at = "2026-11-04T11:58:00Z"; },
      (j) => { j.pools.observed_at = "2099-01-01T00:00:00Z"; },
      (j) => { j.published_at = "2099-01-01T00:00:00Z"; },
    ];
    for (const change of variants) {
      const json = raw();
      change(json);
      const p = parsed(json);
      assert.doesNotMatch(text(view({ data: p })), /well under pace/, change.toString());
    }
  });

  it("counts a floor, not a total, where starts or reasons were left out", () => {
    const json = raw();
    json.passes[3].omitted.starts = 3;
    const t = text(view({ data: parsed(json) }));
    assert.match(t, /Started at least 0/);
    assert.match(t, /Left out to fit: 3 starts\./);
    assert.doesNotMatch(t, /published no reason/);
  });

  it("shows work in flight with its observation", () => {
    const t = text(view({ data: parsed() }));
    assert.match(t, /Work in flight read 2m ago/);
    assert.match(t, /Runs \(1\)cgwalters-forge\/review#245 · implement · pool claude · run 42064057295/);
    assert.match(t, /cgwalters-forge\/agent-board#680 · in the merge queue/);
    assert.match(t, /cgwalters-forge\/review#244 · waiting for review/);
  });

  it("says unknown, not none, for an incomplete or truncated empty list", () => {
    const json = raw();
    json.in_flight = { observed_at: "2026-11-05T11:58:00Z", complete: false, omitted: 3, runs: [], prs: [] };
    json.omitted = 2;
    const t = text(view({ data: parsed(json) }));
    assert.match(t, /not read whole, so what is missing is unknown — 3 left out to fit/);
    assert.match(t, /None listed: unknown/);
    assert.doesNotMatch(t, /None running|None queued/);
    assert.match(t, /2 left out to fit/);
    json.in_flight.complete = true;
    json.in_flight.omitted = 0;
    assert.match(text(view({ data: parsed(json) })), /None running\..*None queued or waiting for review\./);
  });

  it("marks a stale publication and drops its flag", () => {
    const el = view({ data: parsed() }, NOW + 2 * 3600_000);
    assert.match(text(el), /stale: the pass may have stopped, or failed to publish/);
    assert.match(text(el), /stale reading/);
    assert.doesNotMatch(text(el), /well under pace/);
    assert.ok(el.querySelector("p.warn"));
  });

  it("shows no readable records as unknown, not idle", () => {
    const json = raw();
    json.passes = [{ ...json.passes[0], mode: "nope" }];
    const t = text(view({ data: parsed(json) }));
    assert.match(t, /1 unreadable, left out/);
    assert.match(t, /No readable pass records: unknown, not idle/);
  });

  it("renders published text as text", () => {
    const json = raw();
    json.passes[3].sections[0].error = "<img src=x onerror=alert(1)>";
    const el = view({ data: parsed(json) });
    assert.equal(el.querySelector("img"), null);
    assert.match(text(el), /setup: <img src=x onerror=alert\(1\)>/);
  });
});

describe("readPasses", () => {
  const active = (over: Partial<Active>): Active => ({ at: NOW, warnings: [], sources: { holds: { state: "ok" } }, ...over });

  it("says not published for a legacy producer, and never shows idle", () => {
    const read = readPasses({}, active({ passes: null }));
    assert.deepEqual(read, { absent: true });
    const t = text(view(read));
    assert.match(t, /Not published: agent-board's holds.passes is off/);
    assert.doesNotMatch(t, /Started|None/);
  });

  it("keeps the last publication, said to be the last, while a read fails or can't be used", () => {
    const data = parsed();
    const failed = readPasses({ data }, active({ sources: { holds: { state: "unavailable", error: "HTTP 502" } } }));
    assert.equal(failed.data, data);
    assert.match(text(view(failed)), /Pass publication unavailable: couldn't read it \(HTTP 502\)\. What follows is the last one read\./);
    const bad = readPasses({ data }, active({ passes: "malformed header" }));
    assert.equal(bad.data, data);
    assert.match(bad.unavailable!, /can't be used \(malformed header\)/);
    assert.deepEqual(readPasses({ data }, active({})), { data });
    const none = readPasses({}, active({ sources: { holds: { state: "unavailable", error: "HTTP 404" } } }));
    assert.match(text(view(none)), /Nothing known about recent passes/);
  });

  it("replaces the last publication once a usable one is read", () => {
    const next = parsed({ ...raw(), published_at: "2026-11-05T11:59:50Z" });
    assert.deepEqual(readPasses({ data: parsed(), unavailable: "x" }, active({ passes: next })), { data: next });
  });
});

describe("countdown", () => {
  const cases: [string, string][] = [
    ["2026-11-05T12:00:00Z", "due"],
    ["2026-11-05T11:00:00Z", "due"],
    ["2026-11-05T12:00:20Z", "in 1m"],
    ["2026-11-05T14:05:00Z", "in 2h 5m"],
    ["2026-11-07T12:00:00Z", "in 2d"],
  ];
  for (const [at, want] of cases) it(`${at} is ${want}`, () => assert.equal(countdown(at, NOW), want));
});
