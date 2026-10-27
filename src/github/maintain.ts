// The Maintain view's data: agent-board's daily maintain digest, read
// from one issue, and Approve selected. The digest is the newest by date
// among `agent-board-maintain-digest` fences by configured authors,
// with ties going to the newer comment (then the later block).
// The fence holds one JSON object
// (test/fixtures/maintain-digest.md is an example):
//
//   schema   "agent-board/maintain-digest/v1"
//   date     the day it was assessed, YYYY-MM-DD
//   approve  [{pr, head, reason}]: approve as a group, at `head`
//   closer   [{pr, head, concern, minutes, links: [{path, start, end?}]}]
//   waiting  [{pr, reply}]: a reply drafted for the operator to post
//   stale    [{pr, reason}]
//
// `pr` is OWNER/REPO#N and `head` a full commit SHA. Off unless
// maintain-config.json names the issue: no repository or login is built in.

import rawConfig from "./maintain-config.json" with { type: "json" };
import type { GitHub } from "./api.ts";
import type { RawReview } from "./forge.ts";
import { parsePrRef, refText, type PrRef, type RawComment, type RawIssue } from "./reviewdrafts.ts";

export interface MaintainConfig {
  /** The digest issue, OWNER/REPO#N. */
  issue: string;
  /**
   * Logins whose texts may hold the digest: Approve selected approves as
   * the operator what it lists, so a digest anyone else posted there
   * would have the operator approve PRs of their choosing. A text keeps
   * its author when edited, so whoever can edit others' texts in the
   * digest repository (write access) is trusted too.
   */
  authors: string[];
}

const LOGIN = /^[A-Za-z0-9-]+(?:\[bot\])?$/;

export function maintainConfig(value: unknown): MaintainConfig | undefined {
  const c = value as MaintainConfig;
  if (c && c.issue === "" && Array.isArray(c.authors) && !c.authors.length) return undefined;
  if (!c || typeof c.issue !== "string" || !parsePrRef(c.issue) || !Array.isArray(c.authors) || !c.authors.length || c.authors.length > 10
    || c.authors.some((a) => typeof a !== "string" || !LOGIN.test(a))) throw new Error("Invalid maintain configuration");
  return c;
}

export const MAINTAIN_CONFIG = maintainConfig(rawConfig);

export const DIGEST_SCHEMA = "agent-board/maintain-digest/v1";
/** The operator's maintenance time a day, which Needs a closer look is totalled against. */
export const DAY_MINUTES = 60;
/** Items per section; a digest with more is refused, not shown in part. */
export const MAX_ITEMS = 100;
/** Days of comments read: a daily digest's newest is in the last few. */
export const COMMENT_DAYS = 7;
/** Comments read, one page; a full page is refused, as a newer digest may be past it. */
export const MAX_COMMENTS = 100;
/** One page per approval candidate; a full page is refused rather than guessing. */
export const MAX_REVIEWS = 100;

export interface FileLink { path: string; start: number; end?: number }
export interface ApproveItem { pr: PrRef; head: string; reason: string; approved?: boolean }
export interface CloserItem { pr: PrRef; head: string; concern: string; minutes: number; links: FileLink[] }
export interface WaitingItem { pr: PrRef; reply: string }
export interface StaleItem { pr: PrRef; reason: string }

export interface Digest {
  date: string;
  approve: ApproveItem[];
  closer: CloserItem[];
  waiting: WaitingItem[];
  stale: StaleItem[];
}

const FENCE = /^```agent-board-maintain-digest[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm;

type Obj = Record<string, unknown>;

function str(o: Obj, key: string, re?: RegExp): string {
  const v = o[key];
  if (typeof v !== "string" || !v.trim() || (re && !re.test(v))) throw new Error(`${key} must be ${re ? `a string matching ${re}` : "a non-empty string"}`);
  return v;
}

function int(v: unknown, key: string, max: number): number {
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) throw new Error(`${key} must be a whole number from 1 to ${max}`);
  return v as number;
}

function list<T>(o: Obj, key: string, item: (x: Obj) => T): T[] {
  const v = o[key] ?? [];
  if (!Array.isArray(v) || v.length > MAX_ITEMS) throw new Error(`${key} must be a list of at most ${MAX_ITEMS}`);
  return v.map((x, i) => {
    if (!x || typeof x !== "object") throw new Error(`${key}[${i}] must be an object`);
    try { return item(x as Obj); } catch (e) { throw new Error(`${key}[${i}]: ${e instanceof Error ? e.message : String(e)}`); }
  });
}

const pr = (o: Obj): PrRef => {
  const ref = parsePrRef(str(o, "pr"));
  if (!ref) throw new Error("pr must be OWNER/REPO#N");
  return ref;
};
const HEAD = /^[0-9a-f]{40}$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\s\\]{1,400}$/;

function fileLink(o: Obj): FileLink {
  const start = int(o.start, "start", 1e6);
  const end = o.end === undefined ? undefined : int(o.end, "end", 1e6);
  if (end !== undefined && end < start) throw new Error("end must not be before start");
  return { path: str(o, "path", PATH), start, ...(end === undefined ? {} : { end }) };
}

/** One digest block's JSON, checked against DIGEST_SCHEMA. */
export function parseDigest(json: string): Digest {
  const o = JSON.parse(json) as unknown;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("the digest must be a JSON object");
  const d = o as Obj;
  if (d.schema !== DIGEST_SCHEMA) throw new Error(`schema must be ${DIGEST_SCHEMA}`);
  const date = str(d, "date", /^\d{4}-\d{2}-\d{2}$/);
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw new Error("date must be a calendar date, YYYY-MM-DD");
  return {
    date,
    approve: list(d, "approve", (x) => ({ pr: pr(x), head: str(x, "head", HEAD), reason: str(x, "reason") })),
    closer: list(d, "closer", (x) => ({ pr: pr(x), head: str(x, "head", HEAD), concern: str(x, "concern"), minutes: int(x.minutes, "minutes", 480), links: list(x, "links", fileLink) })),
    waiting: list(d, "waiting", (x) => ({ pr: pr(x), reply: str(x, "reply") })),
    stale: list(d, "stale", (x) => ({ pr: pr(x), reason: str(x, "reason") })),
  };
}

/** The minutes Needs a closer look adds up to. */
export const closerMinutes = (d: Digest): number => d.closer.reduce((n, c) => n + c.minutes, 0);

/** A link to a file's lines at the head the digest assessed. */
export const fileUrl = (c: CloserItem, l: FileLink): string =>
  `https://github.com/${c.pr.owner}/${c.pr.repo}/blob/${c.head}/${l.path.split("/").map(encodeURIComponent).join("/")}#L${l.start}${l.end ? `-L${l.end}` : ""}`;

/** Where the shown digest was written, and it or why it can't be read. */
export interface Found { url: string; digest?: Digest; error?: string; stale?: boolean }

/** Today and yesterday in UTC are current, matching the digest's day-only date. */
export const digestIsStale = (date: string, now = Date.now()): boolean =>
  date < new Date(now - 86_400_000).toISOString().slice(0, 10);

/**
 * The highest dated trusted block, ties going to the newer comment and
 * then the later block. Refuse malformed trusted blocks: their date can't
 * be compared safely, so falling back could silently show an older digest.
 */
export function newestDigest(issue: RawIssue, comments: readonly RawComment[], c: MaintainConfig): Found | undefined {
  const trusted = (u: { login: string } | null) => !!u && c.authors.some((a) => a.toLowerCase() === u.login.toLowerCase());
  const texts = [
    ...(trusted(issue.user) ? [{ url: issue.html_url, text: issue.body ?? "" }] : []),
    ...comments.filter((cm) => trusted(cm.user)).sort((a, b) => a.id - b.id).map((cm) => ({ url: cm.html_url, text: cm.body ?? "" })),
  ];
  let found: Found | undefined;
  for (const t of texts) {
    for (const block of t.text.matchAll(FENCE)) {
      try {
        const digest = parseDigest(block[1]!);
        if (!found?.digest || digest.date >= found.digest.date) found = { url: t.url, digest };
      } catch (e) { return { url: t.url, error: e instanceof Error ? e.message : String(e) }; }
    }
  }
  return found;
}

// Bridge GitHub's read-after-write lag across redraws. Per client, at most
// MAX_ITEMS heads for five minutes; a page reload reads reviews from GitHub.
const recentApprovals = new WeakMap<GitHub, Map<string, number>>();
const approvalKey = (it: ApproveItem): string => `${refText(it.pr).toLowerCase()}@${it.head}`;
const APPROVAL_LAG_MS = 5 * 60_000;

/** Read the digest and the viewer's reviews through the existing Maintain source. */
export async function loadDigest(gh: GitHub, c: MaintainConfig, now = Date.now()): Promise<Found | undefined> {
  const ref = parsePrRef(c.issue)!;
  const base = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
  // From the start of a UTC day, so the URL, and the cached copy, stays the same all day.
  const since = new Date(now - COMMENT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [issue, comments] = await Promise.all([
    gh.get<RawIssue>(base),
    gh.get<RawComment[]>(`${base}/comments?since=${since}T00:00:00Z&per_page=${MAX_COMMENTS}`),
  ]);
  if (comments.data.length >= MAX_COMMENTS) throw new Error(`${c.issue} has ${MAX_COMMENTS} or more comments in ${COMMENT_DAYS} days; read it on GitHub`);
  const found = newestDigest(issue.data, comments.data, c);
  if (found?.digest) {
    found.stale = digestIsStale(found.digest.date, now);
    if (found.digest.approve.length) {
      const viewer = (await gh.get<{ login: string }>("/user")).data.login;
      for (const it of found.digest.approve) {
        const reviews = (await gh.get<RawReview[]>(`/repos/${it.pr.owner}/${it.pr.repo}/pulls/${it.pr.number}/reviews?per_page=${MAX_REVIEWS}`)).data;
        if (reviews.length >= MAX_REVIEWS) throw new Error(`${refText(it.pr)} has ${MAX_REVIEWS} or more reviews; read it on GitHub`);
        const decision = reviews.filter((r) => r.user?.login?.toLowerCase() === viewer.toLowerCase() && r.commit_id === it.head
          && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state ?? "")).at(-1);
        it.approved = decision?.state === "APPROVED" || (recentApprovals.get(gh)?.get(approvalKey(it)) ?? 0) > now;
      }
    }
  }
  return found;
}

export interface ApproveResult { pr: PrRef; status: "approved" | "skipped" | "failed"; note?: string }

/**
 * Approve each PR as the signed-in user at the head the digest assessed,
 * one at a time. A PR no longer open, or whose head moved since, is
 * skipped: the approval would be of a commit nobody assessed.
 */
export async function approveSelected(gh: GitHub, items: readonly ApproveItem[]): Promise<ApproveResult[]> {
  const out: ApproveResult[] = [];
  for (const it of items) {
    if (it.approved || (recentApprovals.get(gh)?.get(approvalKey(it)) ?? 0) > Date.now()) {
      out.push({ pr: it.pr, status: "skipped", note: `${refText(it.pr)} is already approved at the assessed head` });
      continue;
    }
    const path = `/repos/${it.pr.owner}/${it.pr.repo}/pulls/${it.pr.number}`;
    try {
      const now = await gh.send<{ state: string; head: { sha: string } }>("GET", path);
      if (now.state !== "open") out.push({ pr: it.pr, status: "skipped", note: `${refText(it.pr)} is no longer open` });
      else if (now.head.sha !== it.head) {
        out.push({ pr: it.pr, status: "skipped", note: `${refText(it.pr)}'s head moved to ${now.head.sha.slice(0, 12)} since the digest assessed ${it.head.slice(0, 12)}` });
      } else {
        await gh.send("POST", `${path}/reviews`, { event: "APPROVE", commit_id: it.head });
        it.approved = true;
        const recent = recentApprovals.get(gh) ?? new Map<string, number>();
        recent.set(approvalKey(it), Date.now() + APPROVAL_LAG_MS);
        if (recent.size > MAX_ITEMS) recent.delete(recent.keys().next().value!);
        recentApprovals.set(gh, recent);
        out.push({ pr: it.pr, status: "approved" });
      }
    } catch (e) {
      out.push({ pr: it.pr, status: "failed", note: `${refText(it.pr)}: ${String(e)}` });
    }
  }
  return out;
}
