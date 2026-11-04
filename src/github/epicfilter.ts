// Display-only filtering of the publisher's epic index. No extra forge reads.
import { h } from "../dom.ts";
import { TRACKER_REPO } from "./config.ts";
import type { InboxEpic } from "./holds.ts";
import type { Card } from "./inbox.ts";
import { load, save } from "./store.ts";

export type EpicFilter = "active" | "all" | "other" | "none" | `epic:${string}`;
const valid = (v: unknown): v is EpicFilter => typeof v === "string" && (/^(active|all|other|none)$/.test(v) || /^epic:[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9]\d{0,9}$/.test(v));

export function epicChoice(login: string | undefined, hash: string): EpicFilter {
  const deep = /^#epic-([1-9]\d{0,9})$/.exec(hash);
  if (deep) return `epic:${TRACKER_REPO.toLowerCase()}#${deep[1]}`;
  return login ? load(`inbox.epic.${login.toLowerCase()}`, "active", valid) : "active";
}

export function saveEpicChoice(login: string | undefined, choice: EpicFilter): void {
  if (login) save(`inbox.epic.${login.toLowerCase()}`, choice);
}

const refs = (c: Card): string[] => "ask" in c ? [c.ask.epic, c.ask.topEpic].filter((v): v is string => !!v && v !== "none") : [];

export function epicSelection(cards: readonly Card[], epics: readonly InboxEpic[] | undefined, choice: EpicFilter) {
  const active = (epics ?? []).filter((e) => e.active).sort((a, b) => Number(b.focus) - Number(a.focus));
  const activeIds = new Set(active.map((e) => e.item));
  const matches = (c: Card, f: EpicFilter): boolean => {
    const ids = refs(c);
    if (f === "all" || (f === "active" && !epics)) return true;
    if (f === "active") return ids.some((id) => activeIds.has(id));
    if (f === "none") return "ask" in c && c.ask.epic === "none" && c.ask.topEpic === "none";
    if (f === "other") return !ids.some((id) => activeIds.has(id)) && !matches(c, "none");
    return ids.includes(f.slice(5));
  };
  const selected = cards.filter((c) => matches(c, choice));
  // Approvals first within each epic, then priority and oldest wait. Unknowns
  // remain distinct from explicit none and are reachable through Other / All.
  const epicRanks = new Map(active.map((e, i) => [e.item, i]));
  const groups = new Map(cards.map((c) => {
    const ids = refs(c);
    const rank = Math.min(...ids.map((id) => epicRanks.get(id) ?? active.length), active.length);
    return [c, { rank, item: active[rank]?.item ?? ids[0] ?? "~" }];
  }));
  const local = (c: Card) => c.kind === "document" || c.kind === "send";
  const ordered = [...cards].sort((a, b) => {
    const ag = groups.get(a)!, bg = groups.get(b)!;
    return Number(a.answered === true) - Number(b.answered === true)
      || Number(local(a)) - Number(local(b)) || ag.rank - bg.rank
      || ag.item.localeCompare(bg.item)
      || Number(b.kind === "approve") - Number(a.kind === "approve")
      || (a.priority ?? "P9").localeCompare(b.priority ?? "P9") || (a.since ?? "~").localeCompare(b.since ?? "~");
  });
  return { active, selected, ordered, hidden: cards.length - selected.length, count: (f: EpicFilter) => cards.filter((c) => matches(c, f)).length };
}

export function epicChips(model: ReturnType<typeof epicSelection>, choice: EpicFilter, available: boolean, choose: (f: EpicFilter) => void): HTMLElement {
  const chip = (f: EpicFilter, label: string) => {
    const b = h("button", { type: "button", class: "small", "data-epic-choice": f, "aria-pressed": String(f === choice) }, `${label} · ${model.count(f)}`);
    b.addEventListener("click", () => choose(f));
    return b;
  };
  return h("div", { class: "epic-filter" },
    h("p", { class: "note" }, available ? `${model.active.length} epics in progress: ${model.active.map((e) => `${e.title}${e.focus ? " (focus)" : ""} — ${e.activeWhy.join(", ") || "no reason published"}`).join("; ") || "none"}. Default: in-progress epics only.` : "Epic activity unavailable; default shows everything."),
    h("div", { class: "epic-chips", "aria-label": "Filter by epic" }, chip("active", "In progress"),
      ...model.active.map((e) => chip(`epic:${e.item}`, `${e.focus ? "Focus: " : ""}${e.title}`)),
      chip("other", "Other epics / unknown"), chip("none", "No epic"), chip("all", "Show everything")),
    choice.startsWith("epic:") ? h("p", { class: "note" }, `Selected ${choice.slice(5)}`) : null);
}
