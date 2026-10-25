// The board changes feed: what changed on the Workstream board since
// the viewer last marked it seen. GitHub keeps no history of project
// field changes, so the app keeps its own: a snapshot of each item's
// feed fields, saved in this browser when the viewer marks the feed
// seen, and diffed against the board as read now. News, the line the
// coordinator writes when something notable happens to an item, is one
// of those fields, so a new line shows up as a change.
//
// The snapshot lives in localStorage (store.ts), not the response
// cache: that cache evicts by age and size and is wiped on sign-out,
// which would silently reset the feed. The board is public, so nothing
// private is kept.

import { type Item } from "./board.ts";
import { DONE } from "./config.ts";
import { priorityRank } from "./queue.ts";
import { load, save } from "./store.ts";

const SNAPSHOT_KEY = "board.seen";
const SNAPSHOT_VERSION = 1;

/** What the feed compares of an item. */
export interface ItemState {
  title: string;
  url?: string;
  status?: string;
  priority?: string;
  lead?: string;
  news?: string;
}

/** The board as last seen: each item's state, by node id. */
export interface Snapshot {
  v: typeof SNAPSHOT_VERSION;
  /** When it was taken, epoch ms. */
  at: number;
  items: Record<string, ItemState>;
}

export type ChangeKind = "added" | "gone" | "done" | "status" | "priority" | "lead" | "news";

/** One change to one field of an item. */
export interface Change {
  kind: ChangeKind;
  /** For priority: whether it went up (toward P0) or down. */
  dir?: "up" | "down";
  from?: string;
  to?: string;
}

/** An item's changes since the snapshot. */
export interface ItemChanges {
  nodeId: string;
  title: string;
  url?: string;
  /** Its priority now (or, once gone, its last one). */
  priority?: string;
  /** When the board item last changed, if still on the board. */
  at?: string;
  changes: Change[];
}

const blank = (s: string | undefined): string | undefined => (s?.trim() ? s : undefined);

export function stateOf(item: Item): ItemState {
  const s: ItemState = { title: item.title };
  const opt = <K extends keyof ItemState>(k: K, v: ItemState[K] | undefined) => {
    if (v !== undefined) s[k] = v;
  };
  opt("url", item.url);
  opt("status", blank(item.status));
  opt("priority", blank(item.priority));
  opt("lead", blank(item.lead));
  opt("news", blank(item.news));
  return s;
}

export function snapshotOf(items: readonly Item[], at: number): Snapshot {
  return { v: SNAPSHOT_VERSION, at, items: Object.fromEntries(items.map((i) => [i.nodeId, stateOf(i)])) };
}

const fromTo = (from: string | undefined, to: string | undefined): Pick<Change, "from" | "to"> => ({
  ...(from === undefined ? {} : { from }),
  ...(to === undefined ? {} : { to }),
});

/** The changes from one state of an item to the next, in a fixed order. */
export function changesOf(prev: ItemState, cur: ItemState): Change[] {
  const out: Change[] = [];
  if (prev.status !== cur.status) {
    out.push({ kind: cur.status === DONE ? "done" : "status", ...fromTo(prev.status, cur.status) });
  }
  if (prev.priority !== cur.priority) {
    out.push({ kind: "priority", dir: priorityRank(cur.priority) < priorityRank(prev.priority) ? "up" : "down", ...fromTo(prev.priority, cur.priority) });
  }
  if (prev.lead !== cur.lead) out.push({ kind: "lead", ...fromTo(prev.lead, cur.lead) });
  if (prev.news !== cur.news && cur.news !== undefined) out.push({ kind: "news", ...fromTo(prev.news, cur.news) });
  return out;
}

/**
 * Every item that changed since `seen`: new and changed ones by when the
 * board item was last touched (any field), newest first, then the gone
 * ones, but for those that were Done.
 */
export function diffBoard(seen: Snapshot, items: readonly Item[]): ItemChanges[] {
  const out: ItemChanges[] = [];
  const present = new Set<string>();
  for (const item of items) {
    present.add(item.nodeId);
    const cur = stateOf(item);
    const prev = seen.items[item.nodeId];
    const changes: Change[] = prev ? changesOf(prev, cur) : [{ kind: "added", ...fromTo(undefined, cur.status) }];
    if (!prev && cur.news) changes.push({ kind: "news", to: cur.news });
    if (!changes.length) continue;
    const c: ItemChanges = { nodeId: item.nodeId, title: cur.title, changes };
    if (cur.url) c.url = cur.url;
    if (cur.priority) c.priority = cur.priority;
    const at = item.movedAt ?? item.updatedAt;
    if (at) c.at = at;
    out.push(c);
  }
  out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  for (const [nodeId, prev] of Object.entries(seen.items)) {
    // Done items leaving (archived) is cleanup, not news.
    if (present.has(nodeId) || prev.status === DONE) continue;
    const c: ItemChanges = { nodeId, title: prev.title, changes: [{ kind: "gone", ...fromTo(prev.status, undefined) }] };
    if (prev.url) c.url = prev.url;
    if (prev.priority) c.priority = prev.priority;
    out.push(c);
  }
  return out;
}

/** Whether an item's changes pass the "P0/P1 only" filter: it is (or was, when gone or lowered) P0 or P1. */
export function isUrgent(c: ItemChanges): boolean {
  const urgent = (p: string | undefined) => p === "P0" || p === "P1";
  return urgent(c.priority) || c.changes.some((x) => x.kind === "priority" && urgent(x.from));
}

export type TimeGroup = "Today" | "Yesterday" | "This week" | "Earlier" | "Gone from the board";

/** Changes grouped by when the item last moved, in the viewer's local days; gone items last. */
export function groupByTime(changes: readonly ItemChanges[], now: number): { group: TimeGroup; items: ItemChanges[] }[] {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const today = day.getTime();
  const DAY = 24 * 3600 * 1000;
  const groupOf = (c: ItemChanges): TimeGroup => {
    if (c.changes.some((x) => x.kind === "gone")) return "Gone from the board";
    const t = c.at ? Date.parse(c.at) : Number.NaN;
    if (Number.isNaN(t)) return "Earlier";
    if (t >= today) return "Today";
    if (t >= today - DAY) return "Yesterday";
    if (t >= today - 6 * DAY) return "This week";
    return "Earlier";
  };
  const order: TimeGroup[] = ["Today", "Yesterday", "This week", "Earlier", "Gone from the board"];
  const groups = new Map<TimeGroup, ItemChanges[]>(order.map((g) => [g, []]));
  for (const c of changes) groups.get(groupOf(c))?.push(c);
  return order.flatMap((group) => {
    const items = groups.get(group) ?? [];
    return items.length ? [{ group, items }] : [];
  });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optString = (v: unknown) => v === undefined || typeof v === "string";

function isItemState(v: unknown): v is ItemState {
  return isObject(v) && typeof v.title === "string" && ["url", "status", "priority", "lead", "news"].every((k) => optString(v[k]));
}

function isSnapshot(v: unknown): v is Snapshot {
  return isObject(v) && v.v === SNAPSHOT_VERSION && typeof v.at === "number" && isObject(v.items) && Object.values(v.items).every(isItemState);
}

/** The snapshot last marked seen, if this browser kept a valid one. */
export function loadSeen(): Snapshot | undefined {
  return load<Snapshot | undefined>(SNAPSHOT_KEY, undefined, (v): v is Snapshot | undefined => isSnapshot(v));
}

export function saveSeen(s: Snapshot): void {
  save(SNAPSHOT_KEY, s);
}

/** The feed's filter: only P0/P1 items, or all. */
export function loadUrgentOnly(): boolean {
  return load("board.urgentOnly", false, (v): v is boolean => typeof v === "boolean");
}

export function saveUrgentOnly(on: boolean): void {
  save("board.urgentOnly", on);
}
