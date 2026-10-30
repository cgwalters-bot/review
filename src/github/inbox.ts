// The inbox: one card per thing only the operator can do.
//
// - What the pass publishes (holds.ts's needs-you list): its holds that
//   only he releases, review waits, operator-action proposals and digest
//   asks, in the pass's order and no others. A hold or a PR's needs-human
//   is Answer, an approval at a head Approve, a proposal Do, the digest's
//   approvals one Approve as a group, anything else a link to where it is
//   done. Each card reads its target again before it writes.
// - Then what the pass does not read: open decisions document entries
//   (Decide; ticking an option dims one, its About item closing resolves
//   it, comments on the item since the ask mark it) and open review-draft
//   issues (Send; a ticked send box dims one until the tracker's workflow
//   closes it).
//
// The list says how current it is from the pass's own clock, not from the
// HTTP read: a 304 says the comment is unchanged, not that the pass still
// runs. Empty means "nothing waits" only for a complete list the pass
// confirmed recently. A list that can't be read again keeps its cards,
// marked unavailable, and says why.

import type { DocumentEntry, Mark } from "./decisiondocument.ts";
import { OPERATOR } from "./config.ts";
import type { Ask, AskRef, NeedsYou } from "./holds.ts";
import type { ApproveItem } from "./maintain.ts";
import type { DraftIssue } from "./reviewdrafts.ts";
import { ago } from "../time.ts";

export type CardKind = "answer" | "approve" | "open" | "do" | "digest" | "document" | "send";

export const CARD_LABEL: Record<CardKind, string> = {
  answer: "Answer",
  approve: "Approve",
  open: "Act",
  do: "Do",
  digest: "Approve",
  document: "Decide",
  send: "Send",
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
  /** The board Priority the pass gave it. */
  priority?: string;
  /** From a list that can't be read now: shown, marked, until one can. */
  unavailable?: boolean;
}

export type Card = CardBase & (
  | { kind: "answer" | "approve" | "open" | "do"; ask: Ask }
  | { kind: "digest"; items: ApproveItem[] }
  | { kind: "send"; draft: DraftIssue }
  | { kind: "document"; entry: DocumentEntry; mark?: Mark }
);

const PULLS = ["pull_request", "approve_pull_request", "review_pull_request", "reply_pull_request", "close_pull_request"];

/** The page on GitHub an ask's action is on, made from its parts. */
export function askUrl(r: AskRef): string {
  return `https://github.com/${r.repository}/${PULLS.includes(r.type) ? "pull" : "issues"}/${r.number}${r.comment ? `#issuecomment-${r.comment}` : ""}`;
}

/** Where the app opens it: the PR pane, or the issue's item view. */
export function askHref(r: AskRef): string {
  return `#${PULLS.includes(r.type) ? "pr" : "issue"}/${r.repository}/${r.number}`;
}

const open = (state: string | undefined): boolean => state === undefined || state === "open";

/** The card for one published ask. */
export function askCard(a: Ask, unavailable = false): Card {
  const type = a.action.type;
  const kind = type === "operator_action" ? "do" : type === "approve_pull_request" ? "approve" : type === "issue" || type === "pull_request" ? "answer" : "open";
  const note = [a.recommendation && `Recommendation: ${a.recommendation}`, a.carried && "Carried over: the pass did not read its source again."].filter(Boolean).join(" ");
  return {
    kind, ask: a, key: a.key, title: a.ask, where: `${a.item} · ${a.kind}`, url: askUrl(a.action), since: a.waitingSince,
    ...(a.priority ? { priority: a.priority } : {}), ...(note ? { note } : {}), ...(unavailable ? { unavailable } : {}),
  };
}

/** The asks as cards in the pass's order, the digest's approvals one group where the first of them ranks. */
export function publishedCards(asks: readonly Ask[], unavailable = false): Card[] {
  const digest = asks.filter((a) => a.kind === "digest-approve" && a.action.head);
  const items = digest.map((a): ApproveItem => {
    const [owner = "", repo = ""] = a.action.repository.split("/");
    return { pr: { owner, repo, number: a.action.number }, head: a.action.head!, reason: a.recommendation ?? a.ask };
  });
  return asks.flatMap((a): Card[] => {
    if (!digest.includes(a)) return [askCard(a, unavailable)];
    if (a !== digest[0]) return [];
    return [{ kind: "digest", items, key: "digest", title: `Approve ${items.length} PR${items.length === 1 ? "" : "s"} as a group`, where: "the maintain digest", since: a.waitingSince, ...(unavailable ? { unavailable } : {}) }];
  });
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

/** What the inbox last read of the pass's list. */
export interface Published {
  /** The asks to show: the list's, else the snapshot's own operator holds (holdAsks). */
  asks: Ask[];
  /** The last list read, kept while a later read has none. */
  list?: NeedsYou;
  /** When GitHub last confirmed the comment holding `list`, a 304 included; undefined while it is the cache's. */
  checkedAt?: number;
  /** Why the latest read gave no list to use. */
  error?: string;
  /** `asks` are from a read that can't be confirmed now. */
  unavailable: boolean;
  /** Current snapshot holds alongside an unavailable older list; these supersede matching keys. */
  holds?: Ask[];
}

/**
 * Older than this, the pass's list is not known to be current: the pass
 * writes an unchanged list again once it is an hour old, and runs every
 * ten minutes (tracker's poll.yml).
 */
export const NEEDS_YOU_MAX_AGE_MS = 70 * 60_000;

/** A source the pass did not read whole, as "proposals partial". */
const shortfall = (l: NeedsYou): string[] => Object.entries(l.sources).flatMap(([name, read]) => (read === "complete" || read === "off" ? [] : [`${name} ${read}`]));

/**
 * What the inbox says over the cards of the pass's list, and whether an
 * empty inbox may say nothing waits: only a complete list, read now and
 * confirmed by the pass within NEEDS_YOU_MAX_AGE_MS.
 */
export function publishedNote(p: Published, now: number): { text: string; settled: boolean } {
  const l = p.list;
  if (!l && !p.error) return { text: "Reading the pass's needs-you list…", settled: false };
  const parts: string[] = [];
  if (p.error) parts.push(`${p.error}.`);
  if (l) {
    const old = now - Date.parse(l.validatedAt) > NEEDS_YOU_MAX_AGE_MS;
    parts.push(`${p.unavailable ? "Cards from the list the pass" : "The pass's list:"} confirmed ${ago(l.validatedAt, now)}, changed ${ago(l.changedAt, now)}${p.checkedAt === undefined ? ", shown from this browser's cache" : `, checked on GitHub ${ago(new Date(p.checkedAt).toISOString(), now)}`}${p.unavailable ? "; marked unavailable until it can be read again." : "."}`);
    if (old) parts.push("The pass has not confirmed it for over an hour: it may have stopped, and this may be out of date.");
    const missing = [...shortfall(l), ...(l.omitted ? [`${l.omitted} past the pass's cap`] : []), ...(l.refused ? [`${l.refused} unreadable here`] : [])];
    if (!l.complete) parts.push(`Incomplete${missing.length ? ` (${missing.join(", ")})` : ""}: more may wait on you.`);
    if (l.summaries !== "complete") parts.push("Not every summary was read: some asks show the board's question or the hold's reason.");
    return { text: parts.join(" "), settled: !p.error && p.checkedAt !== undefined && l.complete && !old };
  }
  parts.push(p.asks.length && !p.unavailable ? "Shown: the snapshot's own operator holds; review waits, proposals and digest asks are not listed." : "Holds, review waits, proposals and digest asks are not listed.");
  return { text: parts.join(" "), settled: false };
}

export interface InboxInput {
  published?: Published;
  document?: { entries: readonly DocumentEntry[]; marks: ReadonlyMap<string, Mark> };
  drafts?: readonly DraftIssue[];
}

/** Every card: the pass's in its order, then the document's and the drafts', those he did last. */
export function inboxCards(input: InboxInput): Card[] {
  const local = [
    ...(input.document?.entries ?? []).map((e) => documentCard(e, input.document?.marks.get(e.id))),
    ...(input.drafts ?? []).map(sendCard),
  ].filter((c): c is Card => c !== undefined);
  const holds = input.published?.holds ?? [];
  return [...publishedCards((input.published?.asks ?? []).filter((a) => !holds.some((h) => h.key === a.key)), input.published?.unavailable), ...publishedCards(holds), ...local.filter((c) => !c.answered), ...local.filter((c) => c.answered)];
}

/** Whether `login` may act on the inbox's cards: the operator, or a token GitHub hasn't named yet. */
export const mayAct = (login: string | undefined): boolean => login === undefined || login === OPERATOR;
