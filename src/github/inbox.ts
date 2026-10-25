// The inbox: one card per thing only the operator can do, each from a live
// predicate with its own leave rule (#135, §2 of its design):
//
// - Answer and Approve: the "Needs you" rows (needs.ts), an ask on an open
//   issue and a review request at an unreviewed head; answered dims the
//   card until the bot acts, the item closing or the head being reviewed
//   removes it.
// - Send: an open review-draft issue; ticking its send box dims it until the
//   tracker's workflow closes the issue.
// - Rerun: the newest dispatch run of an item, failed or cancelled in the
//   last day, while the item is open; a newer run overtakes it.
// - Do: an operator-action proposal whose preconditions still hold.
// - Document entry: an open decisions document entry; ticking an option dims
//   it, its About item closing or merging resolves it, and comments on the
//   item since the ask mark it as changed.
//
// Each predicate takes what the page already read and returns the card, or
// undefined when the thing has left.

import type { GitHub } from "./api.ts";
import type { Offered, Plan } from "./actions.ts";
import { FAILED_CONCLUSIONS } from "./asks.ts";
import { OPERATOR, TRACKER_REPO } from "./config.ts";
import type { DocumentEntry, Mark } from "./decisiondocument.ts";
import type { Need } from "./needs.ts";
import type { DraftIssue } from "./reviewdrafts.ts";

export type CardKind = "document" | "answer" | "approve" | "send" | "rerun" | "do";

/** The kinds in the order the inbox lists them. */
export const CARD_KINDS: readonly CardKind[] = ["document", "answer", "approve", "send", "rerun", "do"];

export const CARD_LABEL: Record<CardKind, string> = {
  document: "Decide",
  answer: "Answer",
  approve: "Approve",
  send: "Send",
  rerun: "Rerun",
  do: "Do",
};

interface CardBase {
  /** Stable while the thing is the same thing: the view keeps a card by it. */
  key: string;
  title: string;
  /** Where it is, e.g. `owner/repo#12`. */
  where: string;
  /** Its page on GitHub. */
  url?: string;
  since?: string;
  /** He did his part: dimmed until the bot (or a workflow) acts. */
  answered?: boolean;
  /** A line under the title: what changed, or why it waits. */
  note?: string;
}

export type Card = CardBase & (
  | { kind: "answer" | "approve"; need: Need }
  | { kind: "send"; draft: DraftIssue }
  | { kind: "rerun"; run: DispatchRun }
  | { kind: "do"; offer: Offered; plan: Plan }
  | { kind: "document"; entry: DocumentEntry; mark?: Mark }
);

const open = (state: string | undefined): boolean => state === undefined || state === "open";

/**
 * An Answer or Approve card for a "Needs you" row. A row on a closed item
 * or a PR no longer open has left, whatever the queue still says; so has a
 * review request once the head it names was reviewed.
 */
export function needCard(n: Need): Card | undefined {
  const item = n.decision?.item ?? n.entry?.item;
  if (!open(item?.state)) return undefined;
  const approve = n.action === "review" || n.action === "promote";
  if (n.action === "review" && n.entry?.wait?.reviewedCurrentHead) return undefined;
  const url = n.entry?.pr?.url ?? item?.url;
  return {
    kind: approve ? "approve" : "answer",
    need: n,
    key: n.key,
    title: n.title,
    where: n.where,
    ...(url ? { url } : {}),
    ...(n.since ? { since: n.since } : {}),
    ...(n.done ? { answered: true, note: "Answered: waiting on the bot." } : n.why ? { note: n.why } : {}),
  };
}

/** A Send card for an open review-draft issue; a ticked box waits on the tracker's workflow, which closes the issue. */
export function sendCard(d: DraftIssue & { issue: { state?: string } }): Card | undefined {
  if (!open(d.issue.state)) return undefined;
  return {
    kind: "send",
    draft: d,
    key: `send:${d.issue.number}`,
    title: d.issue.title,
    where: `#${d.issue.number}`,
    url: d.issue.html_url,
    ...(d.box === "ticked" ? { answered: true, note: "Send is ticked: waiting on the tracker's workflow." } : {}),
  };
}

/** A dispatch run, as its title names it: `KIND OWNER/REPO#N (POOL)`. */
export interface DispatchRun {
  id: number;
  url: string;
  title: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  kind?: string;
  /** `owner/repo#n`, lowercased so runs of one item group. */
  item?: string;
  pool?: string;
}

// A repository name that is only dots is refused: the item is spliced into
// an API path (offeredReruns), and `..` would point that read elsewhere.
const RUN_TITLE = /^(\S+) ([A-Za-z0-9-]+\/(?!\.+#)[A-Za-z0-9_.-]+#[1-9]\d{0,9})(?: \(([^()]+)\))?$/;

/** The kind, item and pool a dispatch run's title names, if it names them. */
export function parseRunTitle(title: string): Pick<DispatchRun, "kind" | "item" | "pool"> {
  const m = RUN_TITLE.exec(title.trim());
  return m ? { kind: m[1]!, item: m[2]!.toLowerCase(), ...(m[3] ? { pool: m[3] } : {}) } : {};
}

/** How long a failed run stays offered for a rerun. */
export const RERUN_WINDOW_MS = 24 * 3_600_000;


/**
 * Rerun cards: per item, its newest run, when that failed or was cancelled
 * within RERUN_WINDOW_MS and the item is not known to be closed. A failed
 * run with a newer one for its item (a rerun is the same run, so it is
 * live again) is overtaken. `itemState` says what the board knows of an
 * item; one it doesn't know stays offered.
 */
export function rerunCards(runs: readonly DispatchRun[], now: number, itemState: (item: string) => string | undefined): Card[] {
  const newest = new Map<string, DispatchRun>();
  for (const r of runs) {
    if (!r.item) continue;
    const seen = newest.get(r.item);
    if (!seen || r.createdAt > seen.createdAt || (r.createdAt === seen.createdAt && r.id > seen.id)) newest.set(r.item, r);
  }
  return [...newest.values()].flatMap((r): Card[] => {
    if (r.status !== "completed" || !FAILED_CONCLUSIONS.includes(r.conclusion ?? "")) return [];
    if (now - Date.parse(r.createdAt) > RERUN_WINDOW_MS) return [];
    if (!open(itemState(r.item!))) return [];
    return [{ kind: "rerun", run: r, key: `rerun:${r.item}`, title: `${r.kind ?? "run"} ${r.conclusion}${r.pool ? ` (${r.pool})` : ""}`, where: r.item!, url: r.url, since: r.createdAt }];
  });
}

/** A Do card for a proposal whose plan (its live preconditions) held when read; without one, a precondition no longer holds. */
export function doCard(o: Offered, plan: Plan | undefined): Card | undefined {
  if (!plan) return undefined;
  return { kind: "do", offer: o, plan, key: `do:${o.comment.databaseId}`, title: o.proposal.title, where: `#${o.issue}`, note: o.proposal.why, since: o.comment.updatedAt };
}

/**
 * A card for an open decisions document entry. Its About item closed or
 * merged resolves it, as the document view does; a ticked option is his
 * answer, waiting on the bot; comments on the item since the ask mark it.
 */
export function documentCard(entry: DocumentEntry, mark: Mark | undefined): Card | undefined {
  if (entry.done) return undefined;
  const about = entry.about ? `${entry.about.repo}#${entry.about.number}` : undefined;
  // A mark read for another About line (an older body) is not this entry's.
  const m = mark && mark.item === about ? mark : undefined;
  if (m && m.state !== "answered") return undefined;
  const answered = entry.options.some((o) => o.checked);
  return {
    kind: "document",
    entry,
    ...(m ? { mark: m } : {}),
    key: `document:${entry.id}`,
    title: `${entry.id} ${entry.title}`,
    where: about ?? entry.id,
    ...(m ? { url: m.url } : about ? { url: `https://github.com/${entry.about!.repo}/issues/${entry.about!.number}` } : {}),
    ...(entry.about?.asked ? { since: entry.about.asked } : {}),
    ...(answered ? { answered: true, note: "Answered: waiting on the bot." } : m ? { note: `Changed since asked: ${m.comments === 1 ? "a comment" : `${m.comments} comments`} on ${m.item}.` } : {}),
  };
}

export interface InboxInput {
  needs?: readonly Need[];
  document?: { entries: readonly DocumentEntry[]; marks: ReadonlyMap<string, Mark> };
  drafts?: readonly DraftIssue[];
  runs?: readonly DispatchRun[];
  itemState?: (item: string) => string | undefined;
  /** Proposals as loaded, each with its plan when its preconditions held. */
  offers?: readonly { offer: Offered; plan?: Plan }[];
  now: number;
}

/** Every card, by kind, the ones still waiting on him before those he did. */
export function inboxCards(input: InboxInput): Card[] {
  const cards = [
    ...(input.document?.entries ?? []).map((e) => documentCard(e, input.document?.marks.get(e.id))),
    ...(input.needs ?? []).map(needCard),
    ...(input.drafts ?? []).map(sendCard),
    ...rerunCards(input.runs ?? [], input.now, input.itemState ?? (() => undefined)),
    ...(input.offers ?? []).map((o) => doCard(o.offer, o.plan)),
  ].filter((c): c is Card => c !== undefined);
  const rank = (c: Card) => Number(c.answered === true) * CARD_KINDS.length + CARD_KINDS.indexOf(c.kind);
  return cards.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map(({ c }) => c);
}

/** The dispatch workflow whose failed runs are offered for a rerun. */
export const DISPATCH_WORKFLOW = "dispatch.yml";

interface RawDispatchRun { id: number; html_url: string; display_title?: string; name?: string | null; status: string | null; conclusion: string | null; created_at: string }

/** The newest dispatch runs (one conditional read), with what their titles name. */
export async function loadDispatchRuns(gh: GitHub, now = Date.now()): Promise<DispatchRun[]> {
  const since = new Date(now - RERUN_WINDOW_MS).toISOString().slice(0, 10);
  const { data } = await gh.get<{ workflow_runs: RawDispatchRun[] }>(`/repos/${TRACKER_REPO}/actions/workflows/${DISPATCH_WORKFLOW}/runs?per_page=100&created=%3E%3D${since}`);
  return data.workflow_runs.map((r) => {
    const title = r.display_title ?? r.name ?? "";
    return { id: r.id, url: r.html_url, title, status: r.status ?? "", conclusion: r.conclusion, createdAt: r.created_at, ...parseRunTitle(title) };
  });
}

/**
 * The runs a Rerun card for `run`'s item may rerun, read now rather than at
 * the last poll: the dispatch runs (a newer one overtakes it) and the item
 * itself (closed takes it away), so a click can't start a second run.
 */
export async function offeredReruns(gh: GitHub, run: DispatchRun, now = Date.now()): Promise<string[]> {
  const m = run.item ? /^([^/]+)\/([^#]+)#(\d+)$/.exec(run.item) : null;
  if (!m) return [];
  const [runs, { data: item }] = await Promise.all([loadDispatchRuns(gh, now), gh.get<{ state: string }>(`/repos/${m[1]}/${m[2]}/issues/${m[3]}`)]);
  return rerunCards(runs, now, (i) => (i === run.item ? item.state : undefined)).flatMap((c) => (c.kind === "rerun" && c.run.item === run.item ? [c.run.url] : []));
}

/** Whether `login` may act on the inbox's cards: the operator, or a token GitHub hasn't named yet. */
export const mayAct = (login: string | undefined): boolean => login === undefined || login === OPERATOR;
