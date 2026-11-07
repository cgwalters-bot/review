// Readiness and dependency counts belong to the pass, never to browser prose parsing.
import type { Ask } from "./holds.ts";
import { decisionKey, githubTarget, NEEDS_YOU_MAX_AGE_MS, refusal, type Published } from "./inbox.ts";

export const ACT_NOW_LIMIT = 10;

export interface ActNowRow {
  ask: Ask;
  unblocks: number;
}

/** A new destructive write never inherits the inbox's legacy descriptor fallback. */
export function mergeRefusal(a: Ask): string | undefined {
  return refusal(a, "merge-or-enqueue") ?? (!a.requests?.length ? "No supported merge-or-enqueue descriptor was published." : undefined);
}

/** One row per published group, independent of the inbox's epic filter. */
export function actNowRows(p: Published, now: number, completed: ReadonlyMap<string, string> = new Map()): ActNowRow[] {
  const list = p.list;
  if (!list?.actNow || p.unavailable || p.error || p.checkedAt === undefined) return [];
  const age = now - Date.parse(list.validatedAt);
  if (!Number.isFinite(age) || age < 0 || age > NEEDS_YOU_MAX_AGE_MS) return [];
  const asks = new Map(p.asks.map((a) => [a.key, a]));
  return list.actNow.flatMap(({ key, unblocks }): ActNowRow[] => {
    const a = asks.get(key);
    // Unknown, carried or incomplete evidence cannot certify "right now".
    if (!a || a.detailMissing || a.carried || !githubTarget(a) || list.sources[a.source] !== "complete" ||
        a.requests?.some((r) => r.quality !== "decision") || completed.get(key) === decisionKey(a)) return [];
    return [{ ask: a, unblocks }];
  }).sort((a, b) => b.unblocks - a.unblocks ||
    (a.ask.priority ?? "P9").localeCompare(b.ask.priority ?? "P9") ||
    Date.parse(a.ask.waitingSince) - Date.parse(b.ask.waitingSince) || a.ask.key.localeCompare(b.ask.key)).slice(0, ACT_NOW_LIMIT);
}
