// What the scheduler's pass holds, as it publishes them (agent-board#307),
// each with whether only the operator releases it: the inbox renders these
// rather than deriving its own from labels. They are the bot's comment on
// the usage issue, read like the usage with the viewer's token, and parsed
// strictly: anything amiss in it, or a token that can't read it, is no holds.

import type { GitHub } from "./api.ts";
import { isBot } from "./authors.ts";
import { fencedJson, isObject, type RawComment, str, time } from "./heartbeat.ts";
import { ITEM_RE, usagePath } from "./usage.ts";

/** The comment's first line. */
export const HOLDS_MARKER = "<!-- agent-board-holds v1 -->";
const SCHEMA = "agent-board/holds/v1";
/** A hold's kind: needs-human, wip, ..., or a newer one, shown as it is. */
const KIND_RE = /^[a-z][a-z-]{0,31}$/;
const PRIORITY_RE = /^P[0-9]$/;

/** One hold, as published: every key is there, null where there is no value. */
export interface Hold {
  /** OWNER/REPO#N; null for a hold of every new run (wip, pools). */
  item: string | null;
  url: string | null;
  epic: boolean;
  kind: string;
  /** What the pass's `hold …:` line says. */
  reason: string;
  /** Only the operator releases it: needs-human, needs-design, epic-unplanned, needs-operator. */
  operator: boolean;
  priority: string | null;
  /** What the item's board Why asks, after its `Q:`. */
  question: string | null;
}

export interface Holds {
  /** When the pass that last changed them ran. */
  at: string;
  holds: Hold[];
}

const isText = (v: unknown): v is string => typeof v === "string";

function parseHold(raw: unknown): Hold | undefined {
  if (!isObject(raw)) return undefined;
  const { item, url, epic, kind, reason, operator, priority, question } = raw;
  if ((item !== null && !str(item, ITEM_RE)) || (priority !== null && !str(priority, PRIORITY_RE)) || (question !== null && !isText(question))) return undefined;
  if (typeof epic !== "boolean" || typeof operator !== "boolean" || !str(kind, KIND_RE) || !isText(reason)) return undefined;
  // The link is the item's issue on github.com, or there is none: nothing else goes in an href.
  if (url !== (isText(item) ? `https://github.com/${item.replace("#", "/issues/")}` : null)) return undefined;
  return { item, url, epic, kind, reason, operator, priority, question } as Hold;
}

/** The holds in a comment's body, or undefined if it isn't a well-formed snapshot. */
export function parseHolds(body: string | null | undefined): Holds | undefined {
  const raw = fencedJson(body, HOLDS_MARKER);
  const at = time(raw?.at);
  if (raw?.schema !== SCHEMA || !at || !Array.isArray(raw.holds)) return undefined;
  const holds = raw.holds.map(parseHold);
  return holds.every((h) => h !== undefined) ? { at, holds: holds as Hold[] } : undefined;
}

/** The bot's newest hold comment among an issue's comments, oldest first as GitHub lists them; nothing if it doesn't parse. */
export function findHolds(comments: readonly RawComment[]): Holds | undefined {
  const c = comments.findLast((c) => isBot(c.user?.login) && c.body?.startsWith(HOLDS_MARKER));
  return parseHolds(c?.body);
}

/** The published holds, read with the viewer's token; undefined on any failure, as if none were published. */
export async function loadHolds(gh: GitHub): Promise<Holds | undefined> {
  try {
    const { data } = await gh.get<RawComment[]>(usagePath);
    return findHolds(Array.isArray(data) ? data : []);
  } catch {
    return undefined;
  }
}
