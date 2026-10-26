// What the scheduler's pass holds, as it publishes them (agent-board#307),
// each with whether only the operator releases it: the inbox renders these
// rather than deriving its own from labels. They are the bot's comment on
// the usage issue, read like the usage with the viewer's token, and parsed
// strictly: anything amiss in it, or a token that can't read it, is no holds.
// The pass's WIP limit and what it did come with them, and are shown from
// here rather than worked out again.

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

/** The WIP limit, and the runs holding a slot (null where the pass did not count them). */
export interface Wip {
  limit: number;
  inFlight: number | null;
}

/** What the pass did: its mode, stage 4's candidates, the runs it started (or would) and the live epics; null where a stage did not get that far. */
export interface PassSummary {
  /** preview, actions or local. */
  mode: string;
  candidates: number | null;
  started: number;
  liveEpics: number | null;
}

export interface Holds {
  /** When the pass that last changed them ran. */
  at: string;
  /** Absent from a comment older than agent-board#373, or one that doesn't parse; shown as not published. */
  wip?: Wip;
  pass?: PassSummary;
  holds: Hold[];
}

const isText = (v: unknown): v is string => typeof v === "string";
/** A count of runs or items: well under this. */
const MAX_COUNT = 10_000;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_COUNT;
const countOrNull = (v: unknown): number | null | undefined => (v === null ? null : isCount(v) ? v : undefined);
const MODE_RE = /^[a-z]{1,16}$/;

function parseWip(raw: unknown): Wip | undefined {
  if (!isObject(raw)) return undefined;
  const inFlight = countOrNull(raw.in_flight);
  return isCount(raw.limit) && inFlight !== undefined ? { limit: raw.limit, inFlight } : undefined;
}

function parsePass(raw: unknown): PassSummary | undefined {
  if (!isObject(raw)) return undefined;
  const candidates = countOrNull(raw.candidates);
  const liveEpics = countOrNull(raw.live_epics);
  const mode = str(raw.mode, MODE_RE);
  return mode && isCount(raw.started) && candidates !== undefined && liveEpics !== undefined ? { mode, candidates, started: raw.started, liveEpics } : undefined;
}

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
  if (!holds.every((h) => h !== undefined)) return undefined;
  const out: Holds = { at, holds: holds as Hold[] };
  // Added to v1 later: a malformed one is left out, not the holds with it.
  const wip = parseWip(raw.wip);
  if (wip) out.wip = wip;
  const pass = parsePass(raw.pass);
  if (pass) out.pass = pass;
  return out;
}

/** The bot's newest hold comment among an issue's comments, oldest first as GitHub lists them; nothing if it doesn't parse. */
export function findHolds(comments: readonly RawComment[]): Holds | undefined {
  const c = comments.findLast((c) => isBot(c.user?.login) && c.body?.startsWith(HOLDS_MARKER));
  return parseHolds(c?.body);
}

/** The published holds, read with the viewer's token; undefined on any failure or when none is published, which the inbox says as not read. */
export async function loadHolds(gh: GitHub): Promise<Holds | undefined> {
  try {
    const { data } = await gh.get<RawComment[]>(usagePath);
    return findHolds(Array.isArray(data) ? data : []);
  } catch {
    return undefined;
  }
}
