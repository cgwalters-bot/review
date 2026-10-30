// What the scheduler's pass holds, as it publishes them (agent-board#307),
// each with whether only the operator releases it: the inbox renders these
// rather than deriving its own from labels. They are the bot's comment on
// the usage issue, read like the usage with the viewer's token, and parsed
// strictly: anything amiss in it, or a token that can't read it, is no holds.
// The pass's WIP limit and what it did come with them, and are shown from
// here rather than worked out again. So does its ranked needs-you list
// (agent-board's docs/pass.md, `holds.needsYou`): the inbox's holds,
// review waits, proposals and digest asks, which the inbox shows in the
// pass's order and with its count instead of assembling its own.

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

/** What an ask names to act on: typed parts the inbox makes its own link from, never an address it follows. */
export interface AskRef {
  /** issue, pull_request, approve_pull_request, review_pull_request, reply_pull_request, close_pull_request or operator_action. */
  type: string;
  /** OWNER/REPO. */
  repository: string;
  number: number;
  /** The proposal's comment, for operator_action. */
  comment?: number;
  /** The full head an approval or review is at. */
  head?: string;
}

/** One thing that waits on the operator, as the pass lists it. */
export interface Ask {
  /** The same from pass to pass: `owner/repo#n`, with `/comment-ID` or `/digest`. */
  key: string;
  /** OWNER/REPO#N it is on. */
  item: string;
  /** epics, items, pass, reviews, proposals or digest. */
  source: string;
  /** The hold's kind, review-…, operator-action or digest-…. */
  kind: string;
  priority: string | null;
  waitingSince: string;
  /** The one-line question, display text only. */
  ask: string;
  recommendation: string | null;
  action: AskRef;
  /** Kept from an earlier pass, as its source was not read again whole. */
  carried: boolean;
}

/** The pass's ranked list of what waits on the operator. */
export interface NeedsYou {
  /** Every source read whole (or off), nothing omitted, and every item read here: only then is an empty list "nothing waits". */
  complete: boolean;
  /** When the pass last wrote the list, if only to confirm it: its age, whatever a 304 says of the comment. */
  validatedAt: string;
  /** When a pass last changed it. */
  changedAt: string;
  /** How much of each source the pass read: complete, partial, unread or off. */
  sources: Record<string, string>;
  /** Whether the bot's summaries of the held issues were all read; an ask falls back to the board's question or the hold's reason. */
  summaries: string;
  /** Asks past the pass's cap, left out. */
  omitted: number;
  items: Ask[];
  /** Items left out here as malformed. */
  refused: number;
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
  /** The ranked list, or why the snapshot's can't be used; absent where the snapshot has none (holds.needsYou off, an older pass, or past the comment's cap). */
  needsYou?: NeedsYou | string;
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

const NEEDS_YOU_SCHEMA = "agent-board/needs-you/v2";
const READS = ["complete", "partial", "unread", "off"];
const KEY_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9]\d{0,9}(?:\/comment-[1-9]\d{0,19}|\/digest)?$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEAD_RE = /^[0-9a-f]{40}$/;
/** The pass cuts every text to its first line and this many characters. */
const TEXT_MAX = 500;
/** The action types a published ask may have; any other is not read. */
export const ASK_ACTIONS = ["issue", "pull_request", "approve_pull_request", "review_pull_request", "reply_pull_request", "close_pull_request", "operator_action"];
const isPositive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const text = (v: unknown): string | undefined => (isText(v) && v.trim() ? v.split("\n")[0]!.slice(0, TEXT_MAX) : undefined);

function parseRef(raw: unknown): AskRef | undefined {
  if (!isObject(raw) || !ASK_ACTIONS.includes(raw.type as string) || !str(raw.repository, REPO_RE) || /\/\.+$/.test(raw.repository as string) || !isPositive(raw.number)) return undefined;
  if ((raw.comment !== undefined && !isPositive(raw.comment)) || (raw.head !== undefined && raw.head !== null && !str(raw.head, HEAD_RE))) return undefined;
  // Approving and running a proposal each need their part.
  if ((raw.type === "approve_pull_request" && !raw.head) || (raw.type === "operator_action" && raw.comment === undefined)) return undefined;
  return { type: raw.type as string, repository: raw.repository as string, number: raw.number, ...(raw.comment ? { comment: raw.comment as number } : {}), ...(raw.head ? { head: raw.head as string } : {}) };
}

function parseAsk(raw: unknown): Ask | undefined {
  if (!isObject(raw)) return undefined;
  const action = parseRef(raw.action);
  const key = str(raw.key, KEY_RE);
  const item = str(raw.item, ITEM_RE);
  const waitingSince = time(raw.waiting_since);
  const ask = text(raw.ask);
  const recommendation = raw.recommendation === null ? null : text(raw.recommendation);
  if (!action || !key || !item || !waitingSince || !ask || recommendation === undefined || !str(raw.source, MODE_RE) || !str(raw.kind, KIND_RE)) return undefined;
  if ((raw.priority !== null && !str(raw.priority, PRIORITY_RE)) || (raw.carried !== undefined && typeof raw.carried !== "boolean")) return undefined;
  return { key, item, source: raw.source as string, kind: raw.kind as string, priority: raw.priority as string | null, waitingSince, ask, recommendation, action, carried: raw.carried === true };
}

/** The snapshot's needs-you list; a string says why it can't be used. A malformed item is left out and makes the list incomplete, not the others unread. */
export function parseNeedsYou(raw: unknown): NeedsYou | string {
  if (!isObject(raw)) return "the needs-you list is not an object";
  if (raw.schema !== NEEDS_YOU_SCHEMA) return `the needs-you list's schema ${JSON.stringify(raw.schema).slice(0, 60)} is not ${NEEDS_YOU_SCHEMA}`;
  const validatedAt = time(raw.validated_at);
  const changedAt = time(raw.changed_at);
  const sources = isObject(raw.sources) ? Object.entries(raw.sources).filter(([k, v]) => str(k, MODE_RE) && READS.includes(v as string)) as [string, string][] : [];
  if (!validatedAt || !changedAt || !Array.isArray(raw.items) || !isCount(raw.omitted) || !READS.includes(raw.summaries as string) || !sources.length) return "the needs-you list is malformed";
  const items = raw.items.map(parseAsk).filter((a) => a !== undefined);
  const refused = raw.items.length - items.length;
  const complete = raw.complete === true && refused === 0 && raw.count === raw.items.length && raw.omitted === 0 && sources.length === Object.keys(raw.sources as object).length && sources.every(([, v]) => v === "complete" || v === "off");
  return { complete, validatedAt, changedAt, sources: Object.fromEntries(sources), summaries: raw.summaries as string, omitted: raw.omitted, items, refused };
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
  if (raw.needs_you !== undefined) out.needsYou = parseNeedsYou(raw.needs_you);
  return out;
}

/** The bot's newest hold comment among an issue's comments, oldest first as GitHub lists them; nothing if it doesn't parse. */
export function findHolds(comments: readonly RawComment[]): Holds | undefined {
  const c = comments.findLast((c) => isBot(c.user?.login) && c.body?.startsWith(HOLDS_MARKER));
  return parseHolds(c?.body);
}

const DECISION_COMMENTS = `query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) { issueOrPullRequest(number:$number) {
    ... on Issue { comments(last:100) { nodes { body author { login } } } }
    ... on PullRequest { comments(last:100) { nodes { body author { login } } } }
  } }
}`;

/** Fresh bounded read: a newer bot comment may replace the ask without editing the issue. */
export async function readHoldAsk(gh: GitHub, owner: string, repo: string, number: number): Promise<string | undefined> {
  const result = await gh.send<{ data?: { repository?: { issueOrPullRequest?: { comments: { nodes: { body: string; author: { login: string } | null }[] } } } } }>("POST", "/graphql", { query: DECISION_COMMENTS, variables: { owner, repo, number } });
  const nodes = result.data?.repository?.issueOrPullRequest?.comments.nodes;
  if (!nodes) throw new Error("The hold's current question could not be read");
  return nodes.findLast((c) => isBot(c.author?.login))?.body;
}

/** The published holds, read with the viewer's token; undefined when none is published. A failed read throws, for readSource to say. */
export async function loadHolds(gh: GitHub): Promise<Holds | undefined> {
  const { data } = await gh.get<RawComment[]>(usagePath);
  return findHolds(Array.isArray(data) ? data : []);
}

/**
 * Without a usable needs-you list, the snapshot's own operator holds on
 * items as asks, in its order, so an older pass's holds are not dropped
 * with the list; they ask the board's question or say the hold's reason.
 */
export function holdAsks(h: Holds): Ask[] {
  return h.holds.flatMap((x) => {
    const [, repository = "", number] = (x.operator && x.item && ITEM_RE.exec(x.item)) || [];
    return repository ? [{ key: x.item!.toLowerCase(), item: x.item!, source: "holds", kind: x.kind, priority: x.priority, waitingSince: h.at, ask: x.question ?? x.reason, recommendation: null, action: { type: "issue", repository, number: Number(number) }, carried: false }] : [];
  });
}
