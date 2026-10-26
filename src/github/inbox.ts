// The inbox: one card per thing only the operator can do, each from a live
// predicate with its own leave rule (#135, §2 of its design):
//
// - Answer and Approve: the "Needs you" rows (needs.ts), an ask on an open
//   issue, a hold of the pass's only he releases and a review request at an
//   unreviewed head; answered dims the card until the bot acts, the item
//   closing, the pass releasing it or the head being reviewed removes it.
// - Send: an open review-draft issue; ticking its send box dims it until the
//   tracker's workflow closes the issue.
// - Rerun: the newest dispatch run of an item, failed or cancelled in the
//   last day, while the item is open; a newer run overtakes it.
// - Do: an open operator-action proposal no decision or ask carries.
// - Document entry: an open decisions document entry; ticking an option dims
//   it, its About item closing or merging resolves it, and comments on the
//   item since the ask mark it as changed.
//
// Each predicate takes what the page already read and returns the card, or
// undefined when the thing has left. A proposal whose issue a decision or
// ask is about, or links to, rides on that card (attachOffers): many
// decisions are exactly an operator action. Cards are listed by board
// Priority, then age; the view draws the first screen of them, and a
// proposal's live preconditions are read only once its card is drawn.

import type { GitHub } from "./api.ts";
import type { Offered } from "./actions.ts";
import { FAILED_CONCLUSIONS } from "./asks.ts";
import { OPERATOR, TRACKER_REPO } from "./config.ts";
import type { DocumentEntry, Mark } from "./decisiondocument.ts";
import type { Need } from "./needs.ts";
import { priorityRank } from "./queue.ts";
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
  /** The board Priority of the item it is about, when the board gives one. */
  priority?: string;
  /** Proposals this decision or ask carries, each with its exact mutations and a Run button. */
  offers?: readonly Offered[];
}

export type Card = CardBase & (
  | { kind: "answer" | "approve"; need: Need }
  | { kind: "send"; draft: DraftIssue }
  | { kind: "rerun"; run: DispatchRun }
  | { kind: "do"; offer: Offered }
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
  const url = n.hold?.url ?? n.entry?.pr?.url ?? item?.url;
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

/** A Do card for a proposal no decision carries; its live preconditions are read when it is drawn. */
export function doCard(o: Offered): Card {
  return { kind: "do", offer: o, key: `do:${o.comment.databaseId}`, title: o.proposal.title, where: `${TRACKER_REPO}#${o.issue}`, note: o.proposal.why, since: o.comment.updatedAt };
}

/** `owner/repo#n`, lowercased: how a card and a proposal name the same issue. */
const refOf = (repo: string, number: number): string => `${repo}#${number}`.toLowerCase();

/** The issue a decision or ask is about, and the text that may link to another. */
function decisionOf(c: Card): { ref?: string; text: string } | undefined {
  if (c.kind === "document") return { ...(c.entry.about ? { ref: refOf(c.entry.about.repo, c.entry.about.number) } : {}), text: c.entry.text };
  if (c.kind !== "answer") return undefined;
  const item = c.need.decision?.item ?? c.need.entry?.item;
  return { ...(item?.ref ? { ref: refOf(`${item.ref.owner}/${item.ref.repo}`, item.ref.number) } : {}), text: item?.body ?? "" };
}

/** Whether `text` links to issue `number` of `repo`, as `owner/repo#n` or its URL. */
export function linksTo(text: string, repo: string, number: number): boolean {
  const name = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:(?<![\\w./-])${name}#|https://github\\.com/${name}/(?:issues|pull)/)${number}(?!\\d)`, "i").test(text);
}

/**
 * Put each proposal on the first card, in order, of a decision or ask
 * about its tracker issue, else of one whose text links to it; a proposal
 * no card takes is a Do card of its own. A proposal rides on one card only,
 * so it has one Run button.
 */
export function attachOffers(cards: readonly Card[], offers: readonly Offered[]): Card[] {
  const out = cards.map((c) => ({ ...c }));
  const loose: Card[] = [];
  for (const o of offers) {
    const ref = refOf(TRACKER_REPO, o.issue);
    const about = out.find((c) => decisionOf(c)?.ref === ref) ?? out.find((c) => linksTo(decisionOf(c)?.text ?? "", TRACKER_REPO, o.issue));
    if (about) about.offers = [...about.offers ?? [], o];
    else loose.push(doCard(o));
  }
  return [...out, ...loose];
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
  /** The board Priority of an item, by its lowercased `owner/repo#n`. */
  priorityOf?: (item: string) => string | undefined;
  /** The open proposals, as loaded. */
  offers?: readonly Offered[];
  now: number;
}

/**
 * Every card, the ones still waiting on him before those he did, each part
 * by board Priority, then oldest first, then kind. Proposals ride on their
 * decisions (attachOffers), the earliest such card first.
 */
export function inboxCards(input: InboxInput): Card[] {
  const priorityOf = input.priorityOf ?? (() => undefined);
  const cards = [
    ...(input.document?.entries ?? []).map((e) => documentCard(e, input.document?.marks.get(e.id))),
    ...(input.needs ?? []).map(needCard),
    ...(input.drafts ?? []).map(sendCard),
    ...rerunCards(input.runs ?? [], input.now, input.itemState ?? (() => undefined)),
  ].filter((c): c is Card => c !== undefined);
  const loose = attachOffers(sortCards(cards, priorityOf), input.offers ?? []);
  return sortCards(loose, priorityOf);
}

/** Cards in the inbox's order, each given its Priority: a need's own, else the board's for the item it names. */
export function sortCards(cards: readonly Card[], priorityOf: (item: string) => string | undefined): Card[] {
  const ranked = cards.map((c, i) => {
    const priority = c.kind === "answer" || c.kind === "approve" ? c.need.priority : priorityOf(c.where.toLowerCase());
    return { c: priority ? { ...c, priority } : c, i };
  });
  const since = (c: Card) => {
    const t = Date.parse(c.since ?? "");
    return Number.isFinite(t) ? t : Infinity;
  };
  return ranked.sort((a, b) => Number(a.c.answered === true) - Number(b.c.answered === true)
    || priorityRank(a.c.priority) - priorityRank(b.c.priority)
    || since(a.c) - since(b.c)
    || CARD_KINDS.indexOf(a.c.kind) - CARD_KINDS.indexOf(b.c.kind)
    || a.i - b.i).map(({ c }) => c);
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
