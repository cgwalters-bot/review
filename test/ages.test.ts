import assert from "node:assert/strict";
import { it } from "node:test";
import { ageLabel, tickAges, time } from "../src/github/view.ts";
import { newsList } from "../src/github/newsview.ts";
import { feedRow } from "../src/github/boardfeedview.ts";
import { installDom } from "./helpers.ts";

installDom();
const since = "2026-01-15T11:00:00Z";
const now = Date.parse("2026-01-15T11:30:00Z");

it("ticks shared labels in place and retains the absolute time in title", () => {
  const label = ageLabel(since, now);
  assert.equal(label.textContent, "30m");
  assert.equal(label.title, time(since));
  assert.match(label.title, /2026/);
  const root = document.createElement("div");
  root.append(label, ageLabel(undefined, now), ageLabel("bad date", now));
  tickAges(root, now + 3600_000);
  assert.equal(root.firstChild, label);
  assert.equal(label.textContent, "1h");
  assert.equal(label.title, time(since));
  assert.equal(root.lastChild?.textContent, "age unknown");
});

it("ticks news and board-feed ages without redrawing their full titles", () => {
  const title = "An unabridged item title ".repeat(30);
  const root = newsList({ items: [{ repo: "example/project", number: 1, url: "https://github.com/example/project/pull/1", title, author: "someone", mergedAt: since, summary: "", labels: [], harness: false }], warnings: [], changed: true }, () => document.createDocumentFragment(), now);
  root.append(feedRow({ title, url: "https://github.com/example/project/issues/1", at: since, changes: [], priority: "P1", nodeId: "item-1" }, now));
  const labels = [...root.querySelectorAll<HTMLElement>(".age")];
  assert.equal(labels.length, 2);
  tickAges(root, now + 3600_000);
  for (const label of labels) {
    assert.equal(label.textContent, "1h");
    assert.match(label.title, /2026/);
  }
  assert.equal(root.querySelector("h3 a")?.textContent, title);
});
