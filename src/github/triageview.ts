// The themes and verdicts under "By priority": the P0 lane, then one
// collapsible group per board Theme with its verdict mix, and the items
// without a Theme.

import { h, link } from "../dom.ts";
import { chatButton, chatItem } from "./chatitem.ts";
import type { Item } from "./board.ts";
import { BOARD_URL, TRIAGE_FIELD } from "./config.ts";
import {
  bucketOf,
  buildTriage,
  shortRef,
  type ThemeGroup,
  TRIAGE_FILTERS,
  type TriageFilter,
  UNTRIAGED,
  VERDICT_BUCKETS,
  type VerdictBucket,
  type VerdictCounts,
  verdictTargetOf,
} from "./triage.ts";
import { pill } from "./view.ts";

/** What each verdict means, for the legend and chip titles. */
export const VERDICT_TITLE: Record<VerdictBucket, string> = {
  keep: "keep: work on it as it is",
  merge: "merge into another item (its target)",
  park: "park: not now",
  close: "close: a duplicate (of its target) or obsolete",
  none: "no verdict yet",
};

const FILTER_LABEL: Record<TriageFilter, string> = { all: "All", keep: "keep", merge: "merge", park: "park", close: "close", none: "no verdict" };

export interface TriageHooks {
  /** The app route of an item that is in the queue, if it is. */
  itemHref(item: Item): string | undefined;
  /** Themes whose group is open. */
  open: ReadonlySet<string>;
  /** Remember a group opened or closed, so a refresh keeps it. */
  toggled(theme: string, open: boolean): void;
  /** Filter by a verdict (or "all" to clear it). */
  setFilter(filter: TriageFilter): void;
}

export interface TriageBoard {
  items: Item[];
  missing: string[];
}

function verdictChip(item: Item): HTMLElement {
  const b = bucketOf(item);
  // An unknown verdict shows as the board has it.
  const text = b === "none" ? (item.verdict ?? "no verdict") : b;
  return h("span", { class: `verdict v-${b}`, title: VERDICT_TITLE[b] }, text);
}

function itemRow(item: Item, hooks: TriageHooks): HTMLElement {
  const target = verdictTargetOf(item);
  const inQueue = hooks.itemHref(item);
  const title = inQueue ? h("a", { href: inQueue }, item.title) : link(item.url, item.title);
  return h(
    "li",
    { class: `tri-item b-${bucketOf(item)}` },
    h("span", { class: "tri-ref" }, item.url ? link(item.url, shortRef(item.url)) : "draft"),
    h("span", { class: "tri-title" }, title),
    h(
      "span",
      { class: "tri-meta" },
      pill(item.priority),
      h("span", { class: "tag" }, item.status ?? "no status"),
      verdictChip(item),
      chatButton(chatItem(item.url, item.title, item.engine)),
      target ? h("span", { class: "tag" }, "→ ", link(target, shortRef(target))) : null,
    ),
  );
}

/** A bar of verdict shares, one segment per verdict present. */
function verdictBar(counts: VerdictCounts, total: number): HTMLElement {
  const bar = h("span", { class: "vbar", role: "img", "aria-label": VERDICT_BUCKETS.map((b) => `${counts[b]} ${b}`).join(", ") });
  for (const b of VERDICT_BUCKETS) {
    if (!counts[b] || !total) continue;
    const seg = h("span", { class: `v-${b}`, title: `${b}: ${counts[b]}` });
    seg.style.width = `${((counts[b] / total) * 100).toFixed(1)}%`;
    bar.append(seg);
  }
  return bar;
}

function countsText(counts: VerdictCounts): string {
  return VERDICT_BUCKETS.filter((b) => counts[b]).map((b) => `${counts[b]} ${b === "none" ? "no verdict" : b}`).join(" · ");
}

function themeGroup(g: ThemeGroup, hooks: TriageHooks, filtered: boolean): HTMLElement {
  const n = g.items.length;
  const details = h(
    "details",
    { class: `theme${g.theme === UNTRIAGED ? " untriaged" : ""}` },
    h(
      "summary",
      {},
      h("span", { class: "theme-name" }, g.theme === UNTRIAGED ? "No theme (untriaged)" : g.theme),
      h("span", { class: "tag" }, filtered ? `${g.shown.length} of ${n}` : `${n} item${n === 1 ? "" : "s"}`),
      verdictBar(g.counts, n),
      h("span", { class: "tag theme-counts" }, countsText(g.counts)),
    ),
    h("ul", { class: "tri-list" }, ...g.shown.map((i) => itemRow(i, hooks))),
  );
  // A filter opens every group it leaves something in.
  details.open = filtered || hooks.open.has(g.theme);
  details.addEventListener("toggle", () => {
    if (!filtered) hooks.toggled(g.theme, details.open);
  });
  return details;
}

function filterChips(counts: VerdictCounts, total: number, filter: TriageFilter, hooks: TriageHooks): HTMLElement {
  return h(
    "nav",
    { class: "filters", "aria-label": "Filter by verdict" },
    h(
      "div",
      { class: "chips" },
      h("span", { class: "chips-h" }, "Verdict"),
      h(
        "div",
        { class: "chips-list" },
        ...TRIAGE_FILTERS.map((f) => {
          const on = f === filter;
          const attrs: Record<string, string> = { type: "button", class: `chip${on ? " on" : ""}` };
          if (f !== "all") attrs.title = VERDICT_TITLE[f];
          if (on) attrs["aria-pressed"] = "true";
          const chip = h("button", attrs, FILTER_LABEL[f], h("span", { class: "count" }, String(f === "all" ? total : counts[f])));
          // Choosing the chosen verdict again clears it.
          chip.addEventListener("click", () => hooks.setFilter(on ? "all" : f));
          return chip;
        }),
      ),
    ),
  );
}

export function triageView(board: TriageBoard | undefined, filter: TriageFilter, hooks: TriageHooks): HTMLElement {
  const root = h("div", { class: "triage" });
  if (!board) {
    root.append(h("p", { class: "empty" }, "Loading the board…"));
    return root;
  }
  const t = buildTriage(board.items, filter);
  root.append(
    h(
      "p",
      { class: "summary" },
      `${t.total} open items on the `,
      link(BOARD_URL, "board"),
      ` · ${t.themes.length} themes · ${t.untriaged.items.length} untriaged`,
    ),
  );
  if (board.missing.length) {
    root.append(h("p", { class: "warn" }, `The board has no ${board.missing.map((m) => `"${m}"`).join(", ")} field yet, so items show without it.`));
  }
  root.append(filterChips(t.counts, t.total, filter, hooks));

  const p0 = h("section", { class: "p0-lane" }, h("h2", { class: "group-h" }, `P0 now · ${t.p0.length}`));
  if (t.p0.length) p0.append(h("ul", { class: "tri-list" }, ...t.p0.map((i) => itemRow(i, hooks))));
  else p0.append(h("p", { class: "note" }, "No P0 item is open."));
  root.append(p0);

  const filtered = filter !== "all";
  const groups = [...t.themes, t.untriaged].filter((g) => g.items.length > 0 && (!filtered || g.shown.length > 0));
  const themes = h(
    "section",
    { class: "themes" },
    h("h2", { class: "group-h" }, `Themes · ${t.themes.length}`),
    h(
      "div",
      { class: "legend" },
      ...VERDICT_BUCKETS.map((b) => h("span", { title: VERDICT_TITLE[b] }, h("i", { class: `v-${b}` }), b === "none" ? "no verdict" : b)),
    ),
  );
  if (groups.length === 0) {
    themes.append(
      h("p", { class: "empty" }, filtered ? "No item has this verdict. " : `No item has a ${TRIAGE_FIELD.theme} yet.`, filtered ? showAll(hooks) : null),
    );
  }
  for (const g of groups) themes.append(themeGroup(g, hooks, filtered));
  root.append(themes);
  return root;
}

function showAll(hooks: TriageHooks): HTMLElement {
  const b = h("button", { type: "button", class: "small" }, "Show all");
  b.addEventListener("click", () => hooks.setFilter("all"));
  return b;
}
