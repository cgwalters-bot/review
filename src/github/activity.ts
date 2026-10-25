// One newest-first stream; each source keeps its own bounded reader.

import type { Item } from "./board.ts";
import { diffBoard, isUrgent, type ItemChanges, type Snapshot } from "./boardfeed.ts";
import type { DispatchData, DispatchRun } from "./dispatch.ts";
import type { News, NewsItem } from "./news.ts";
import type { BotEvent } from "./ops.ts";

export const NEWS_POLL_MS = 5 * 60_000;

export interface ActivityData {
  board?: readonly Item[] | undefined;
  seen: Snapshot | undefined;
  news: News | undefined;
  events?: readonly BotEvent[] | undefined;
  eventsError?: string | undefined;
  dispatch?: DispatchData | undefined;
}

export type ActivityEntry =
  | { kind: "board"; at: string | undefined; item: ItemChanges }
  | { kind: "merge"; at: string; item: NewsItem }
  | { kind: "event"; at: string; item: BotEvent }
  | { kind: "run"; at: string; item: DispatchRun };

/** Unknown board times sort last, rather than inventing a transition time. */
export function activityEntries(data: ActivityData, urgentOnly = false): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  if (data.board && data.seen) {
    for (const item of diffBoard(data.seen, data.board)) {
      if (!urgentOnly || isUrgent(item)) entries.push({ kind: "board", at: item.at, item });
    }
  }
  for (const item of data.news?.items ?? []) entries.push({ kind: "merge", at: item.mergedAt, item });
  for (const item of data.events ?? []) entries.push({ kind: "event", at: item.at, item });
  for (const item of data.dispatch?.finished ?? []) entries.push({ kind: "run", at: item.updatedAt, item });
  const timestamp = (at: string | undefined) => at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : -Infinity;
  return entries.sort((a, b) => {
    const x = timestamp(a.at), y = timestamp(b.at);
    return x === y ? 0 : x > y ? -1 : 1;
  });
}
