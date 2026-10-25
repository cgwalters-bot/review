// The triage and decisions views' model: board items grouped by their
// Theme with their Verdict, the P0 lane, and the open decisions. Pure
// functions over parsed items, so tests feed them synthetic ones.
//
// A decision is a question (see answer.ts) that the bot also labels
// `decision` and titles "D<n>: ...", so they read in order. Besides the
// question, its body lists the items the decision unblocks:
//
//     Unblocks:
//     - https://github.com/cgwalters-forge/bootc/pull/15
//     - https://github.com/cgwalters-forge/tracker/issues/160
//
// The URLs may also follow on the `Unblocks:` line itself, separated by
// commas or spaces, bare or in code spans.

import { parseQuestion, type Question, unfencedLines } from "../answer.ts";
import { type Item, parseIssueUrl, priorityIndex } from "./board.ts";
import { DONE, FORGE_ORG, TRACKER_REPO, TRIAGE_THEMES, type Verdict, VERDICTS } from "./config.ts";

/** A verdict, or none: an item not yet judged, or with a verdict the app doesn't know. */
export type VerdictBucket = Verdict | "none";
export const VERDICT_BUCKETS: readonly VerdictBucket[] = [...VERDICTS, "none"];

/** The triage view's filter: every item, or those with one verdict. */
export type TriageFilter = VerdictBucket | "all";
export const TRIAGE_FILTERS: readonly TriageFilter[] = ["all", ...VERDICT_BUCKETS];

/** The name of the group of items without a Theme. */
export const UNTRIAGED = "untriaged";

/**
 * An item's verdict, if the board gives one the app knows. Case and a
 * qualifier after a dash are ignored ("merge-into", "close-duplicate").
 */
export function verdictOf(item: Pick<Item, "verdict">): Verdict | undefined {
  const v = item.verdict?.trim().toLowerCase();
  if (!v) return undefined;
  return VERDICTS.find((x) => v === x || v.startsWith(`${x}-`));
}

export function bucketOf(item: Pick<Item, "verdict">): VerdictBucket {
  return verdictOf(item) ?? "none";
}

/** Where a merge or close verdict points, if it does. */
export function verdictTargetOf(item: Pick<Item, "verdict" | "verdictTarget">): string | undefined {
  const v = verdictOf(item);
  return v === "merge" || v === "close" ? item.verdictTarget : undefined;
}

export type VerdictCounts = Record<VerdictBucket, number>;

export function countVerdicts(items: readonly Item[]): VerdictCounts {
  const counts = Object.fromEntries(VERDICT_BUCKETS.map((b) => [b, 0])) as VerdictCounts;
  for (const i of items) counts[bucketOf(i)]++;
  return counts;
}

export interface ThemeGroup {
  /** The Theme, or UNTRIAGED. */
  theme: string;
  /** All its items, P0 first. */
  items: Item[];
  /** The items the filter keeps. */
  shown: Item[];
  counts: VerdictCounts;
}

export interface Triage {
  /** P0 items that aren't Done, whatever the filter. */
  p0: Item[];
  /** One group per Theme, in TRIAGE_THEMES order, then any others by name. */
  themes: ThemeGroup[];
  /** Items without a Theme. */
  untriaged: ThemeGroup;
  /** Verdict counts over every item, for the filter chips. */
  counts: VerdictCounts;
  total: number;
}

/** By priority, keeping board order within one (the sort is stable). */
function byPriority(items: readonly Item[]): Item[] {
  return [...items].sort((a, b) => priorityIndex(a.priority) - priorityIndex(b.priority));
}

function group(theme: string, items: readonly Item[], filter: TriageFilter): ThemeGroup {
  const sorted = byPriority(items);
  return {
    theme,
    items: sorted,
    shown: filter === "all" ? sorted : sorted.filter((i) => bucketOf(i) === filter),
    counts: countVerdicts(sorted),
  };
}

function themeRank(theme: string): number {
  const i = TRIAGE_THEMES.indexOf(theme);
  return i < 0 ? TRIAGE_THEMES.length : i;
}

/** Group open board items for the triage view. Done items are dropped, should any come in. */
export function buildTriage(all: readonly Item[], filter: TriageFilter = "all"): Triage {
  const items = all.filter((i) => i.status !== DONE);
  const byTheme = new Map<string, Item[]>();
  const none: Item[] = [];
  for (const i of items) {
    if (!i.theme) {
      none.push(i);
      continue;
    }
    const list = byTheme.get(i.theme) ?? [];
    list.push(i);
    byTheme.set(i.theme, list);
  }
  const themes = [...byTheme.keys()]
    .sort((a, b) => themeRank(a) - themeRank(b) || a.localeCompare(b))
    .map((t) => group(t, byTheme.get(t) ?? [], filter));
  return {
    p0: items.filter((i) => i.priority === "P0"),
    themes,
    untriaged: group(UNTRIAGED, none, filter),
    counts: countVerdicts(items),
    total: items.length,
  };
}

/** The items as the triage view lists them: the P0 lane, then each group's shown items; each once. */
export function triageOrder(t: Triage): Item[] {
  const seen = new Set<string>();
  return [...t.p0, ...[...t.themes, t.untriaged].flatMap((g) => g.shown)].filter((i) => !seen.has(i.nodeId) && seen.add(i.nodeId));
}

/** A decision issue, parsed. */
export interface Decision {
  item: Item;
  /** n in its "D<n>: ..." title, if it has one. */
  number?: number;
  /** The title without its "D<n>:" prefix. */
  title: string;
  question: Question;
  /** The URLs its `Unblocks:` list names, in order, without duplicates. */
  unblocks: string[];
}

const DECISION_TITLE_RE = /^D([0-9]{1,6})[ \t]*:[ \t]*(.*)$/;
const UNBLOCKS_RE = /^Unblocks:[ \t]*(.*)$/i;
const URL_RE = /^https:\/\/[^\s`<>]+$/;
// A list marker: "-", "*" or "1." before an item.
const LIST_MARKER_RE = /^(?:[-*+]|[0-9]+[.)])[ \t]+/;

/** The URLs in a line that holds nothing else (besides list markers, code spans and separators), or undefined. */
function urlLine(line: string): string[] | undefined {
  const tokens = line
    .replace(LIST_MARKER_RE, "")
    .split(/[\s,;`]+/)
    .filter(Boolean);
  if (tokens.length === 0 || !tokens.every((t) => URL_RE.test(t))) return undefined;
  return tokens;
}

/**
 * The URLs a decision's `Unblocks:` line lists: on that line, then one
 * or more per following line, up to the first line that isn't only
 * URLs. Blank lines in between are skipped; fenced code doesn't count.
 */
export function parseUnblocks(body: string): string[] {
  const lines = unfencedLines(body);
  const at = lines.findIndex((l) => UNBLOCKS_RE.test(l));
  if (at < 0) return [];
  const first = (UNBLOCKS_RE.exec(lines[at] as string)?.[1] ?? "").split(/[\s,;`]+/).filter((t) => URL_RE.test(t));
  const urls = [...first];
  for (const line of lines.slice(at + 1)) {
    if (line === "") continue;
    const found = urlLine(line);
    if (!found) break;
    urls.push(...found);
  }
  return [...new Set(urls)];
}

export function parseDecision(item: Item): Decision {
  const m = DECISION_TITLE_RE.exec(item.title.trim());
  const d: Decision = {
    item,
    title: m ? (m[2] as string).trim() || item.title : item.title,
    question: parseQuestion(item.body),
    unblocks: parseUnblocks(item.body),
  };
  if (m) d.number = Number(m[1]);
  return d;
}

/** Decisions in D-number order; any without one after them, by issue number. */
export function sortDecisions(ds: readonly Decision[]): Decision[] {
  const key = (d: Decision) => d.number ?? Number.POSITIVE_INFINITY;
  return [...ds].sort((a, b) => key(a) - key(b) || (a.item.ref?.number ?? 0) - (b.item.ref?.number ?? 0));
}

/** "D3", or the issue's "#n" when its title has no D-number. */
export function decisionLabel(d: Decision): string {
  if (d.number !== undefined) return `D${d.number}`;
  return d.item.ref ? `#${d.item.ref.number}` : "D?";
}

/**
 * A short name for an issue or PR URL: "tracker#12" in the tracker,
 * "forge bootc#15" in a forge fork, "bootc#2516" elsewhere, and the URL
 * itself for anything else.
 */
export function shortRef(url: string): string {
  const ref = parseIssueUrl(url);
  if (!ref) return url;
  const full = `${ref.owner}/${ref.repo}`.toLowerCase();
  if (full === TRACKER_REPO.toLowerCase()) return `tracker#${ref.number}`;
  if (ref.owner.toLowerCase() === FORGE_ORG.toLowerCase()) return `forge ${ref.repo}#${ref.number}`;
  return `${ref.repo}#${ref.number}`;
}
