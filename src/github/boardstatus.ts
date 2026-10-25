// The board's status, computed from the board items at read time: the
// sections the posted status update writes (Changed, In progress,
// Waiting on the operator, At risk), but complete and with full titles.
// The posted update cuts every title and stops each list at ten
// ("+90 more"); the board as read has neither limit. Pure, so tests feed
// it items.

import type { Item } from "./board.ts";
import { DONE, IN_PROGRESS, QUEUE_STATUSES } from "./config.ts";
import { priorityRank } from "./queue.ts";

/** How far back Changed reaches, and how long a P0 may sit unmoved before it is at risk. */
export const STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;

export const STATUS_SECTIONS = ["changed", "inProgress", "waiting", "atRisk"] as const;
export type StatusSectionId = (typeof STATUS_SECTIONS)[number];

export const STATUS_SECTION_TITLE: Record<StatusSectionId, string> = {
  changed: "Changed",
  inProgress: "In progress",
  waiting: "Waiting on the operator",
  atRisk: "At risk",
};

export const STATUS_SECTION_HINT: Record<StatusSectionId, string> = {
  changed: "moved on the board in the last 24 h",
  inProgress: `Status ${IN_PROGRESS}`,
  waiting: "Status Needs human or Draft",
  atRisk: "unfinished P0 not moved in 24 h",
};

export type BoardStatus = Record<StatusSectionId, Item[]>;

/**
 * When an item last moved on the board, as the changes feed reads it: not
 * its issue's time, which every comment bumps, so a bot's comment neither
 * lists an item as changed nor takes a stale P0 off At risk.
 */
export function lastMoved(item: Item): number | undefined {
  const t = Date.parse(item.movedAt ?? item.updatedAt ?? "");
  return Number.isFinite(t) ? t : undefined;
}

function unfinished(item: Item): boolean {
  return item.state !== "closed" && item.state !== "merged" && item.status !== DONE;
}

const byPriority = (a: Item, b: Item) => priorityRank(a.priority) - priorityRank(b.priority) || a.title.localeCompare(b.title);

export function boardStatus(board: readonly Item[], now: number): BoardStatus {
  const since = now - STATUS_WINDOW_MS;
  const open = board.filter(unfinished);
  return {
    changed: board.filter((i) => (lastMoved(i) ?? -Infinity) >= since).sort((a, b) => lastMoved(b)! - lastMoved(a)! || byPriority(a, b)),
    inProgress: open.filter((i) => i.status === IN_PROGRESS).sort(byPriority),
    waiting: open.filter((i) => i.status !== undefined && QUEUE_STATUSES.includes(i.status)).sort(byPriority),
    // An item whose times are unknown is not called at risk.
    atRisk: open.filter((i) => i.priority === "P0" && (lastMoved(i) ?? Infinity) < since).sort(byPriority),
  };
}
