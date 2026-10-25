// The board changes feed, in the "Changes" section: chips for what
// changed on each item since the viewer last marked the feed seen, the
// newest first, grouped by day; News lines stand out.

import { h, link } from "../dom.ts";
import type { Item } from "./board.ts";
import { type Change, diffBoard, groupByTime, isUrgent, type ItemChanges, type Snapshot } from "./boardfeed.ts";
import { ageLabel, pill } from "./view.ts";

export interface FeedOptions {
  now: number;
  urgentOnly: boolean;
  /** The board was read from the cache only, so it may be behind. */
  fromCache?: boolean;
  onUrgentOnly: (on: boolean) => void;
  onSeen: () => void;
}

const arrow = (from: string | undefined, to: string | undefined) => `${from ?? "none"} → ${to ?? "none"}`;

/** One change as a chip, and the text that goes with it. */
export function chip(c: Change): HTMLElement {
  switch (c.kind) {
    case "added":
      return h("span", { class: "chip ch-new", title: `added to the board${c.to ? ` as ${c.to}` : ""}` }, "new");
    case "gone":
      return h("span", { class: "chip ch-gone", title: `no longer on the board (was ${c.from ?? "untriaged"})` }, "gone");
    case "done":
      return h("span", { class: "chip ch-done", title: arrow(c.from, c.to) }, "Done");
    case "status":
      return h("span", { class: "chip ch-status" }, arrow(c.from, c.to));
    case "priority":
      return h("span", { class: `chip ch-${c.dir ?? "down"}`, title: arrow(c.from, c.to) }, `${c.dir === "up" ? "↑" : "↓"} ${c.to ?? "none"}`);
    case "lead":
      return h(
        "span",
        { class: "chip ch-lead" },
        c.from === undefined ? `claimed by ${c.to}` : c.to === undefined ? `released by ${c.from}` : `lead ${arrow(c.from, c.to)}`,
      );
    case "news":
      return h("span", { class: "chip ch-news" }, "news");
  }
}

/** The class of an item's row, which the section shows a few of before "View all". */
export const FEED_ROW_CLASS = "feed-row";

/** One item's changes as a list row. */
export function feedRow(c: ItemChanges, now: number): HTMLElement {
  const news = c.changes.find((x) => x.kind === "news");
  return h(
    "li",
    { class: FEED_ROW_CLASS },
    h(
      "div",
      { class: "feed-head" },
      pill(c.priority),
      h("span", { class: "feed-chips" }, ...c.changes.map(chip)),
      h("span", { class: "feed-title" }, link(c.url, c.title)),
      c.at ? ageLabel(c.at, now) : null,
    ),
    news?.to ? h("p", { class: "feed-news" }, news.to) : null,
  );
}

/** The feed section, or what to say before there is one. */
export function feedSection(board: readonly Item[] | undefined, seen: Snapshot | undefined, opts: FeedOptions): HTMLElement {
  const sec = h("div", { class: "feed" });
  if (!board) {
    sec.append(h("p", { class: "note" }, opts.fromCache ? "Not cached; reading the board…" : "The board couldn't be read."));
    return sec;
  }
  if (!seen) {
    sec.append(h("p", { class: "note" }, "Tracking starts now: changes to the board from here on show up here."));
    return sec;
  }
  const all = diffBoard(seen, board);
  const shown = opts.urgentOnly ? all.filter(isUrgent) : all;
  const toggle = h("input", { type: "checkbox", class: "feed-urgent" });
  toggle.checked = opts.urgentOnly;
  toggle.addEventListener("change", () => opts.onUrgentOnly(toggle.checked));
  const seenBtn = h("button", { type: "button", class: "feed-seen", title: "Start the feed over from the board as it is now" }, "Mark all seen");
  seenBtn.disabled = all.length === 0 || !!opts.fromCache;
  seenBtn.addEventListener("click", () => opts.onSeen());
  sec.append(
    h(
      "div",
      { class: "feed-bar" },
      h("span", { class: "note" }, "Since ", ageLabel(new Date(seen.at).toISOString(), opts.now), ` ago · ${all.length} item${all.length === 1 ? "" : "s"} changed`),
      h("label", {}, toggle, " P0/P1 only"),
      seenBtn,
    ),
  );
  if (!shown.length) {
    sec.append(h("p", { class: "note" }, all.length ? "No P0/P1 changes." : "Nothing changed since then."));
    return sec;
  }
  for (const g of groupByTime(shown, opts.now)) {
    sec.append(h("h3", {}, g.group), h("ul", { class: "feed-list" }, ...g.items.map((c) => feedRow(c, opts.now))));
  }
  return sec;
}
