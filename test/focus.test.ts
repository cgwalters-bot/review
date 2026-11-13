import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fillFocus, focusView, parseEpicFocus, type EpicFocus } from "../src/github/focus.ts";
import { HOLDS_MARKER, parseHolds } from "../src/github/holds.ts";
import { homeSkeleton } from "../src/github/homeview.ts";
import { fixture, installDom } from "./helpers.ts";

installDom();
// Verbatim agent-board e48bf70 fixtures/epic-focus.json, not private data.
const sample = () => fixture<EpicFocus>("epic-focus.json");
const now = Date.parse("2026-11-08T12:05:00Z");
const snapshot = (epic_focus?: unknown) => parseHolds(`${HOLDS_MARKER}\n\n\`\`\`json\n${JSON.stringify({ schema: "agent-board/holds/v1", at: "2026-11-08T12:00:00Z", holds: [], epic_focus })}\n\`\`\``)!;

describe("Focus publication", () => {
  it("round-trips the shared fixture and its original clock through holds", () => {
    assert.deepEqual(snapshot(sample()).epicFocus, sample());
    assert.equal(snapshot().epicFocus, undefined);
    assert.equal(typeof snapshot(null).epicFocus, "string");
    assert.deepEqual(snapshot(null).holds, []);
  });

  const mutations: Record<string, (v: any) => void> = {
    schema: (v) => { v.schema = "future"; },
    priority: (v) => { v.priority = "P1"; },
    clock: (v) => { v.observed_at = "tomorrow"; },
    source: (v) => { v.sources.runs = "maybe"; },
    "false complete": (v) => { v.complete = true; },
    "negative count": (v) => { v.omitted = -1; },
    "overbound epics": (v) => { v.epics = Array(11).fill(v.epics[0]); },
    "duplicate epics": (v) => { v.epics.push(v.epics[0]); },
    "overbound children": (v) => { v.epics[0].children = Array(51).fill(v.epics[0].children[0]); },
    "overbound runs": (v) => { v.epics[0].runs = Array(9).fill(v.epics[0].runs[0]); },
    "duplicate child": (v) => { v.epics[0].children[1] = v.epics[0].children[0]; },
    "bad item": (v) => { v.epics[0].item = "o/t#0"; },
    "unsafe url": (v) => { v.epics[0].url = "javascript:alert(1)"; },
    "wrong item url": (v) => { v.epics[0].children[0].url = "https://github.com/o/t/issues/99"; },
    "bad blocker": (v) => { v.epics[0].children[0].blocker.type = "ready"; },
    "bad pull": (v) => { v.epics[0].children[0].blocker.pull = "o/t#1/../../evil"; },
    "bad since": (v) => { v.epics[0].children[0].blocker.since = "later"; },
    "overlong title": (v) => { v.epics[0].title = "x".repeat(121); },
    "control text": (v) => { v.epics[0].goal = "a\nb"; },
    "impossible progress": (v) => { v.epics[0].progress.done = 11; },
    "inconsistent total": (v) => { v.epics[0].progress.total = 11; },
    "done with blocker": (v) => { v.epics[0].children[0].state = "done"; },
    "unsafe run": (v) => { v.epics[0].runs[0].run.repository = "o/.."; },
    "zero run": (v) => { v.epics[0].runs[0].run.id = 0; },
    "bad start time": (v) => { v.epics[0].runs[0].started_at = "tomorrow"; },
    "unrelated run": (v) => { v.epics[0].runs[0].item = "o/t#999"; },
  };
  for (const [name, mutate] of Object.entries(mutations)) it(`refuses ${name}, preserving the rest of holds`, () => {
    const data = sample();
    mutate(data);
    assert.equal(typeof parseEpicFocus(data), "string");
    assert.deepEqual(snapshot(data).holds, []);
  });

  it("accepts bounded truncation, null details, unicode and unknown extensions", () => {
    const data = sample();
    const e = data.epics[0]!;
    e.children.pop(); e.omitted++;
    e.title = "😀".repeat(120); e.goal = null; e.changed_at = null;
    e.runs_omitted = 2;
    Object.assign(data, { future_extension: { ignored: true } });
    assert.deepEqual(parseEpicFocus(data), data);
    assert.match(focusView(data, now).textContent!, /1 children omitted · 2 runs omitted/);
  });
});

describe("Focus cards", () => {
  it("shows linked mixed children, deduplicated progress, typed blockers and runs", () => {
    const data = sample();
    const el = focusView(data, now);
    assert.equal(el.querySelectorAll(".focus-card").length, 2);
    const first = el.querySelector(".focus-card")!;
    assert.match(first.textContent!, /2 \/ 10 done · 1 blocked on operator/);
    assert.match(first.textContent!, /Waiting on operator — Ship it\?/);
    for (const label of ["Failing CI", "Waiting on upstream review / merge", "Pass hold", "Nothing started (publisher assessment)", "State unknown", "Plain task (unlinked task) — Done"]) assert.ok(first.textContent!.includes(label));
    assert.equal(first.querySelectorAll(".focus-children > li").length, 10);
    for (const e of data.epics) for (const c of e.children) if (c.item) assert.ok(el.querySelector(`a[href="${c.url}"]`), c.item);
    assert.equal(el.querySelector('a[href="https://github.com/o/t/issues/4"]')!.parentElement!.textContent, "o/t#4 · Issue 4 — Done");
    assert.ok(el.querySelector('a[href="https://github.com/o/runner/actions/runs/41"]'));
    assert.ok(el.querySelector('a[href="https://github.com/o/w/pull/50"]'));
    assert.match(el.textContent!, /1 unread epics · 0 epics omitted/);
    assert.equal(el.querySelector("button"), null);
  });

  it("links epic-owned as well as child-owned runs and preserves an epic hold", () => {
    const data = sample();
    const e = data.epics[0]!;
    e.runs.push({ ...e.runs[0]!, item: e.item, run: { repository: "other/runner", id: 42 } });
    e.blocker = e.children[0]!.blocker;
    const parsed = parseEpicFocus(data);
    assert.equal(typeof parsed, "object");
    const el = focusView(parsed, now);
    assert.ok(el.querySelector('a[href="https://github.com/other/runner/actions/runs/42"]'));
    assert.match(el.textContent!, /Epic: Waiting on operator/);
    assert.match(el.textContent!, /Run listed above; other blockers unknown/);
  });

  it("accepts producer starts without an optional timestamp as well as explicit null", () => {
    // view::Run::json omits started_at for a run just dispatched this pass.
    const data = sample();
    delete data.epics[0]!.runs[0]!.started_at;
    assert.equal(typeof parseEpicFocus(data), "object");
    assert.match(focusView(parseEpicFocus(data), now).textContent!, /run 41 · start time unknown/);
    data.epics[0]!.runs[0]!.started_at = null;
    assert.equal(typeof parseEpicFocus(data), "object");
  });

  it("sorts operator count, oldest change and identity, without mutating the publication", () => {
    const data = sample();
    const e = data.epics[1]!;
    data.epics.push({ ...e, item: "o/t#30", url: "https://github.com/o/t/issues/30", changed_at: null },
      { ...e, item: "o/t#19", url: "https://github.com/o/t/issues/19" });
    const cards = focusView(data, now).querySelectorAll(".focus-card h3 a");
    assert.deepEqual([...cards].map((a) => a.getAttribute("href")), [1, 19, 20, 30].map((n) => `https://github.com/o/t/issues/${n}`));
    assert.equal(data.epics[2]!.item, "o/t#30");
  });

  it("keeps absent, malformed, stale, cached, future and empty publications explicit", () => {
    const text = (v: EpicFocus | string | undefined, at = now, unavailable?: string) => focusView(v, at, unavailable).textContent!;
    assert.match(text(undefined), /not published.*unknown/);
    assert.match(text(parseEpicFocus(null)), /Focus unavailable/);
    assert.match(text(sample(), now + 3_600_000), /stale.*last observed/);
    assert.match(text(sample(), now - 600_000), /clock is in the future/);
    assert.match(text(sample(), now, "cached"), /unavailable: cached.*last read, not current/);
    assert.match(text({ ...sample(), epics: [] }), /No P0 epics listed.*unknown/);
    const data = sample();
    data.epics[0]!.runs = [];
    assert.match(text(data), /Issue 3 — State unknown \(no blocker published\)/);
  });

  it("renders hostile text as text, and mounts above agents only on Needs you", () => {
    const data = sample();
    data.epics[0]!.title = "<img src=x onerror=alert(1)>";
    const el = focusView(parseEpicFocus(data), now);
    assert.equal(el.querySelector("img, script"), null);
    const home = homeSkeleton({ toggled() {} });
    assert.equal(home.el.firstElementChild, home.slots.focus);
    assert.equal(home.slots.focus.getAttribute("data-view"), home.slots.active.getAttribute("data-view"));
  });

  it("keeps cards compact and preserves opened child inventories across polling", () => {
    const slot = document.createElement("div");
    fillFocus(slot, sample(), now);
    const first = slot.querySelector("details")!;
    assert.equal(first.open, false);
    first.open = true;
    fillFocus(slot, sample(), now + 60_000, "cached");
    assert.equal(slot.querySelector("details")!.open, true);
    assert.equal(slot.querySelectorAll("details")[1]!.open, false);
  });
});
