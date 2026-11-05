import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOLDS_MARKER, parseHolds } from "../src/github/holds.ts";
import { parsePassView, passView, type PassView, retainPassView } from "../src/github/passview.ts";
import { fixture, installDom } from "./helpers.ts";

installDom();
const snapshot = () => fixture<{ pass_view: PassView }>("pass-view.json");
const publication = (raw: unknown) => `${HOLDS_MARKER}\n\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``;
const now = Date.parse("2026-11-05T12:00:00Z");

describe("pass publication replay", () => {
  it("renders the exact producer fixture through the holds parser", () => {
    const data = parseHolds(publication(snapshot()))?.passView;
    assert.equal(typeof data, "object");
    const el = passView(data, now);
    for (const s of ["API rate limit exceeded", "HTTP 503", "Started 0", "no-ready-work", "replan-delay", "12:30:00Z", "capped", "held", "10% used / 60% allowed", "in 120m", "well under pace with nothing ready", "merge-queue", "waiting-review", "implement · claude"]) assert.ok(el.textContent?.includes(s), s);
    assert.equal(el.querySelector("a[href$='/actions/runs/42']")?.getAttribute("href"), "https://github.com/example/runner/actions/runs/42");
    assert.equal(el.querySelector("a[href$='/pull/14']")?.textContent, "example/work#14");
    assert.match(el.textContent!, /Started nothing; reason not published/);
    assert.equal(el.querySelector("button, input, script"), null);
  });

  it("keeps absence, bad data, unread, partial and stale distinct from an empty queue", () => {
    assert.match(passView(undefined).textContent!, /not published/);
    assert.match(passView(parsePassView({})).textContent!, /unavailable/);
    const raw = snapshot().pass_view;
    raw.complete = false;
    raw.omitted = 3;
    raw.in_flight = [];
    raw.passes[0]!.omitted = 2;
    const el = passView(parsePassView(raw), now + 7_200_000, "HTTP 503");
    for (const s of ["Publication unavailable", "not current", "stale", "partial", "3 records omitted", "2 pass records omitted", "incomplete publication is not an empty queue", "due; awaiting reading"]) assert.ok(el.textContent?.includes(s), s);
    assert.match(passView(raw, now - 120_000).textContent!, /clock is in the future/);
  });

  it("keeps the last readable view across a failed refresh and recovers on the next read", () => {
    const last = parsePassView(snapshot().pass_view) as PassView;
    const fresh = parsePassView({ ...snapshot().pass_view, observed_at: "2026-11-05T12:05:00Z" }) as PassView;
    assert.equal(retainPassView(last, undefined, true), last);
    assert.equal(retainPassView(last, "malformed", true), last);
    assert.equal(retainPassView(last, fresh, true), fresh);
    assert.equal(retainPassView(last, fresh, false), fresh);
    assert.equal(retainPassView(last, undefined, false), undefined);
    assert.equal(retainPassView(undefined, undefined, true), undefined);
    const el = passView(retainPassView(last, undefined, true), now, "HTTP 503");
    for (const s of ["Publication unavailable", "not current", "API rate limit exceeded", "merge-queue"]) assert.ok(el.textContent?.includes(s), s);
  });

  it("renders publisher text as text, and ignores untyped URLs", () => {
    const raw = snapshot().pass_view;
    raw.passes[0]!.reasons[0]!.reason = '<img src=x onerror="alert(1)">';
    Object.assign(raw.in_flight[0]!, { url: "https://invalid.example/" });
    const el = passView(parsePassView(raw), now);
    assert.equal(el.querySelector("img, [onerror], a[href*='invalid']"), null);
    assert.ok(el.textContent?.includes("<img"));
  });

  it("rejects malformed or over-bound arrays, addresses, counts and text without losing holds", () => {
    const mutations: ((v: PassView) => void)[] = [
      (v) => { v.passes = Array(9).fill(v.passes[0]); },
      (v) => { v.passes[0]!.sections = Array(13).fill(v.passes[0]!.sections[0]); },
      (v) => { v.passes[1]!.started = Array(33).fill(v.passes[1]!.started[0]); },
      (v) => { v.passes[0]!.reasons = Array(33).fill(v.passes[0]!.reasons[0]); },
      (v) => { v.pools = Array(17).fill(v.pools[0]); },
      (v) => { v.in_flight = Array(101).fill(v.in_flight[0]); },
      (v) => { v.passes[0]!.sections[0]!.error = "HTTP 503\nsecret detail"; },
      (v) => { v.passes[0]!.sections[0]!.error = "x".repeat(241); },
      (v) => { v.passes[0]!.reasons[1]!.until = null; },
      (v) => { v.pools[0]!.used_percent = 101; },
      (v) => { v.pools[0]!.ready = -1; },
      (v) => { v.passes[1]!.started[0]!.run.repository = "../x"; },
      (v) => { v.passes[1]!.started[0]!.run.id = Number.MAX_SAFE_INTEGER + 1; },
      (v) => { v.passes[0]!.reasons[0]!.item = "https://invalid.example#1"; },
    ];
    for (const mutate of mutations) {
      const raw = snapshot();
      mutate(raw.pass_view);
      const result = parseHolds(publication(raw));
      assert.ok(result);
      assert.equal(typeof result.passView, "string");
    }
  });
});
