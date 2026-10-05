// Board changes: empty and fixture feeds, literal titles and replacement renders.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseItem } from "../src/github/board.ts";
import { snapshotOf } from "../src/github/boardfeed.ts";
import { feedSection, type FeedOptions } from "../src/github/boardfeedview.ts";
import { installDom, rawItems } from "./helpers.ts";

installDom();
const NOW = Date.parse("2026-01-10T15:00:00Z");
const EVIL = "<img src=x onerror=alert(1)><script>alert(2)</script>\u202eRTL\u202c\u2066isolate\u2069\u0001";
const opts = (): FeedOptions => ({ now: NOW, urgentOnly: false, onUrgentOnly: () => {}, onSeen: () => {} });
const board = () => rawItems().slice(0, 3).map(parseItem);
const seen = snapshotOf([], NOW - 86_400_000);

describe("feedSection", () => {
  it("shows an empty feed and disables marking it seen", () => {
    const el = feedSection([], seen, opts());
    assert.ok(el.textContent?.includes("Nothing changed since then."));
    assert.equal(el.querySelectorAll(".feed-row").length, 0);
    assert.equal(el.querySelector<HTMLButtonElement>(".feed-seen")?.disabled, true);
  });

  it("shows fixture titles, new chips and issue links", () => {
    const items = board();
    const el = feedSection(items, seen, opts());
    const rows = [...el.querySelectorAll(".feed-row")];
    assert.equal(rows.length, items.length);
    assert.deepEqual(rows.map((r) => r.querySelector(".chip")?.textContent), ["new", "new", "new"]);
    assert.deepEqual(rows.map((r) => r.querySelector(".feed-title")?.textContent).sort(), items.map((i) => i.title).sort());
    assert.deepEqual([...el.querySelectorAll(".feed-title a")].map((a) => a.getAttribute("href")).sort(), items.flatMap((i) => i.url ? [i.url] : []).sort());
    assert.equal(el.querySelector<HTMLButtonElement>(".feed-seen")?.disabled, false);
  });

  it("preserves an untrusted title as inert literal text, including bidi and control characters", () => {
    const item = { ...board()[0]!, title: EVIL };
    const el = feedSection([item], seen, opts());
    assert.equal(el.querySelector(".feed-title a")?.textContent, EVIL);
    assert.equal(el.querySelectorAll("script, img, iframe, svg, style").length, 0, el.outerHTML);
    for (const node of el.querySelectorAll("*")) {
      for (const attr of node.getAttributeNames()) assert.ok(!/^on/i.test(attr), attr);
    }
  });

  it("renders equivalent output on fresh replacement DOM", () => {
    const items = board();
    const first = feedSection(items, seen, opts());
    document.body.replaceChildren(first);
    const replacement = feedSection(items, seen, opts());
    document.body.replaceChildren(replacement);
    assert.notEqual(replacement, first);
    assert.equal(first.isConnected, false);
    assert.equal(document.body.firstElementChild, replacement);
    assert.equal(replacement.outerHTML, first.outerHTML);
  });
});
