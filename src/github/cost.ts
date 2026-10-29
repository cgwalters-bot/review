// A day's agent spend, as agent-board's `cost` command publishes it
// (agent-board/cost-day/v1, agent-board docs/cost.md): one file per UTC
// day, cost/YYYY-MM-DD.json on a branch of the tracker. The Usage view
// charts the last COST_DAYS of them. The dollars are agent-board's, at
// its prices: this reads them as published and prices nothing, and a
// group none of whose runs is priced (usd null) is shown as its tokens,
// never as $0.
//
// One conditional listing of cost/ a poll; each day's file is read by its
// blob sha, which never changes, so from the HTTP cache once read.

import { GitHubError, type GitHub, RateLimited } from "./api.ts";
import { isObject } from "./heartbeat.ts";
import { decodeBase64, USAGE_CONFIG } from "./usage.ts";

/** Days charted, ending yesterday: today's file is published tomorrow. */
export const COST_DAYS = 14;
/** Days the review share is taken over. */
export const SHARE_DAYS = 7;
/** Runs listed for the selected day. */
export const TOP_RUNS = 10;
const SCHEMA = "agent-board/cost-day/v1";
export const COST_KINDS = ["review", "implement", "triage", "fix", "planning", "supervisor", "other"] as const;
export type CostKind = (typeof COST_KINDS)[number];
/**
 * A day is a few hundred runs at most (agent-board reads at most 1000
 * requests a day); past these a file is not one, and is left unread
 * rather than tying up the tab.
 */
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RUNS = 2000;
const MAX_MODELS = 64;
const MAX_TOKENS = 1e15;
const MAX_USD = 1e9;
const MAX_TEXT = 200;
const REPO_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$/;
const DAY_MS = 24 * 60 * 60_000;

export interface CostGroup {
  runs: number;
  /** All four counts, cache reads included. */
  tokens: number;
  /** null where none of its runs is priced. */
  usd: number | null;
  unpricedRuns: number;
}

export interface CostRun {
  id: number;
  /** The run's page, checked to be a GitHub Actions run URL of this id. */
  url: string;
  kind: CostKind;
  repo: string;
  /** OWNER/REPO#N, or the summary's own text. */
  item?: string;
  model: string;
  tokens: number;
  usd: number | null;
}

export interface CostDay {
  date: string;
  totals: CostGroup;
  byKind: Partial<Record<CostKind, CostGroup>>;
  byModel: Record<string, CostGroup>;
  runs: CostRun[];
}

/** A charted day: its report, or none published (or none readable). */
export interface CostEntry {
  date: string;
  day?: CostDay;
  /** Published but not readable as cost-day/v1. */
  unreadable?: boolean;
}

/** Where the reports are published; null in usage-config.json turns the chart off. */
export interface CostSource {
  repo: string;
  ref: string;
}

/** The charted days, oldest first; "none" when nothing is published there yet. */
export type CostData = { state: "ok"; days: CostEntry[] } | { state: "none" };

const count = (v: unknown, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= MAX_TEXT ? v : undefined);

function parseTokens(raw: unknown): number | undefined {
  if (!isObject(raw)) return undefined;
  const parts = [raw.input, raw.output, raw.cache_read, raw.cache_write].map((v) => count(v, MAX_TOKENS));
  return parts.some((v) => v === undefined) ? undefined : parts.reduce((a, b) => a! + b!, 0);
}

/** usd is a number or null; anything else, a malformed entry. */
function parseUsd(v: unknown): number | null | undefined {
  return v === null ? null : count(v, MAX_USD);
}

function parseGroup(raw: unknown): CostGroup | undefined {
  if (!isObject(raw)) return undefined;
  const runs = count(raw.runs, MAX_TOKENS);
  const tokens = parseTokens(raw.tokens);
  const usd = parseUsd(raw.usd);
  const unpricedRuns = count(raw.unpriced_runs, MAX_TOKENS);
  if (runs === undefined || tokens === undefined || usd === undefined || unpricedRuns === undefined) return undefined;
  return { runs, tokens, usd, unpricedRuns };
}

/** A map of name to group, malformed entries and names left out; own keys only. */
function parseGroups(raw: unknown, ok: (name: string) => boolean): Record<string, CostGroup> {
  const out: Record<string, CostGroup> = {};
  for (const [name, entry] of isObject(raw) ? Object.entries(raw).slice(0, MAX_MODELS) : []) {
    const group = ok(name) ? parseGroup(entry) : undefined;
    if (group) out[name] = group;
  }
  return out;
}

const isKind = (v: unknown): v is CostKind => typeof v === "string" && (COST_KINDS as readonly string[]).includes(v);

function parseRun(raw: unknown): CostRun | undefined {
  if (!isObject(raw)) return undefined;
  const id = count(raw.id, Number.MAX_SAFE_INTEGER);
  const repo = typeof raw.repo === "string" && REPO_RE.test(raw.repo) ? raw.repo : undefined;
  const model = text(raw.model);
  const tokens = parseTokens(raw.tokens);
  const usd = parseUsd(raw.usd);
  // The link is the report's, so only a run page, and only this run's.
  const url = typeof raw.url === "string" && id && new RegExp(`^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/${id}$`).test(raw.url) && !raw.url.includes("/../") ? raw.url : undefined;
  if (!id || !Number.isInteger(id) || !url || !isKind(raw.kind) || !repo || !model || tokens === undefined || usd === undefined) return undefined;
  const run: CostRun = { id, url, kind: raw.kind, repo, model, tokens, usd };
  const item = text(raw.item);
  if (item) run.item = item;
  return run;
}

/**
 * A cost-day/v1 report, as published for `date`; undefined when it is
 * another schema or day, or its totals are malformed. A malformed group
 * or run is left out, not the day.
 */
export function parseCostDay(raw: unknown, date: string): CostDay | undefined {
  if (!isObject(raw) || raw.schema !== SCHEMA || raw.date !== date) return undefined;
  const totals = parseGroup(raw.totals);
  if (!totals) return undefined;
  return {
    date,
    totals,
    byKind: parseGroups(raw.by_kind, isKind),
    byModel: parseGroups(raw.by_model, (name) => name.length <= MAX_TEXT),
    runs: (Array.isArray(raw.runs) ? raw.runs.slice(0, MAX_RUNS) : []).flatMap((r) => parseRun(r) ?? []),
  };
}

/** The COST_DAYS UTC days before `now`'s, oldest first. */
export function costDates(now: number): string[] {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return Array.from({ length: COST_DAYS }, (_, i) => new Date(today - (COST_DAYS - i) * DAY_MS).toISOString().slice(0, 10));
}

/** The day's runs by cost, the priced first, then the unpriced by tokens. */
export function topRuns(day: CostDay, n = TOP_RUNS): CostRun[] {
  return [...day.runs].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.tokens - a.tokens || a.id - b.id).slice(0, n);
}

export interface ReviewShare {
  /** Reviews' share of the priced spend, 0 to 1; undefined with none priced. */
  share?: number;
  /** Of the SHARE_DAYS asked for, those published. */
  days: number;
  /** Review runs without a price, and their tokens. */
  unpricedRuns: number;
  unpricedTokens: number;
}

/** Reviews' share of the last `n` days' published dollars, summed as published; their unpriced runs counted apart. */
export function reviewShare(entries: readonly CostEntry[], n = SHARE_DAYS): ReviewShare {
  const days = entries.slice(-n).flatMap((e) => e.day ?? []);
  let review: number | undefined;
  let total = 0;
  const out: ReviewShare = { days: days.length, unpricedRuns: 0, unpricedTokens: 0 };
  for (const d of days) {
    // Reviews with no priced run have no share, not 0%.
    const usd = d.byKind.review?.usd;
    if (usd !== undefined && usd !== null) review = (review ?? 0) + usd;
    total += d.totals.usd ?? 0;
    for (const r of d.runs) {
      if (r.kind !== "review" || r.usd !== null) continue;
      out.unpricedRuns++;
      out.unpricedTokens += r.tokens;
    }
  }
  if (review !== undefined && total > 0) out.share = review / total;
  return out;
}

/** A bar series: the groups it stacks, by name. */
export interface CostSeries {
  key: string;
  label: string;
  names: string[];
}

/** Models with a series of their own; the rest share one. */
export const MODEL_SERIES = 6;

/** The series to stack by kind (fixed, so colors stay put), or by model, the costliest of the days first. */
export function costSeries(entries: readonly CostEntry[], by: "kind" | "model"): CostSeries[] {
  if (by === "kind") return COST_KINDS.map((k, i) => ({ key: `k${i}`, label: k, names: [k] }));
  const sums = new Map<string, { usd: number; tokens: number }>();
  for (const e of entries) {
    for (const [name, g] of Object.entries(e.day?.byModel ?? {})) {
      const s = sums.get(name) ?? { usd: 0, tokens: 0 };
      sums.set(name, { usd: s.usd + (g.usd ?? 0), tokens: s.tokens + g.tokens });
    }
  }
  const ranked = [...sums].sort(([an, a], [bn, b]) => b.usd - a.usd || b.tokens - a.tokens || an.localeCompare(bn)).map(([name]) => name);
  const series = ranked.slice(0, MODEL_SERIES).map((name, i) => ({ key: `k${i}`, label: name, names: [name] }));
  const rest = ranked.slice(MODEL_SERIES);
  if (rest.length) series.push({ key: `k${MODEL_SERIES}`, label: `${rest.length} other models`, names: rest });
  return series;
}

/** A series' groups on a day: their published dollars (null if none priced) and what they leave unpriced. */
export function seriesCell(day: CostDay, by: "kind" | "model", s: CostSeries): CostGroup {
  const groups = s.names.flatMap((n) => (by === "kind" ? day.byKind[n as CostKind] : Object.hasOwn(day.byModel, n) ? day.byModel[n] : undefined) ?? []);
  const priced = groups.filter((g) => g.usd !== null);
  return {
    runs: groups.reduce((a, g) => a + g.runs, 0),
    tokens: groups.reduce((a, g) => a + g.tokens, 0),
    usd: priced.length ? priced.reduce((a, g) => a + g.usd!, 0) : null,
    unpricedRuns: groups.reduce((a, g) => a + g.unpricedRuns, 0),
  };
}

interface Listed {
  name?: unknown;
  sha?: unknown;
  size?: unknown;
}

/**
 * The charted days from `source`: one conditional listing of cost/, then
 * each charted day's blob. A branch or directory that isn't there is
 * "none"; a file too large or not a report is that day unreadable.
 */
export async function loadCost(gh: GitHub, now = Date.now(), source: CostSource | null = USAGE_CONFIG.cost): Promise<CostData | undefined> {
  // Both are spliced into a path the viewer's token is sent to: no "." or "..".
  if (!source || !REPO_RE.test(source.repo) || !REF_RE.test(source.ref) || [...source.repo.split("/"), ...source.ref.split("/")].some((p) => /^\.+$/.test(p))) return undefined;
  let listing: Listed[];
  try {
    const { data } = await gh.get<Listed[]>(`/repos/${source.repo}/contents/cost?ref=${encodeURIComponent(source.ref)}`);
    listing = Array.isArray(data) ? data : [];
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404 && !(e instanceof RateLimited)) return { state: "none" };
    throw e;
  }
  const files = new Map(listing.flatMap((f) => (typeof f.name === "string" && typeof f.sha === "string" && /^[0-9a-f]{40,64}$/.test(f.sha) ? [[f.name, f] as const] : [])));
  const days = await Promise.all(
    costDates(now).map(async (date): Promise<CostEntry> => {
      const f = files.get(`${date}.json`);
      if (!f) return { date };
      if (typeof f.size !== "number" || f.size > MAX_BYTES) return { date, unreadable: true };
      let raw: unknown;
      try {
        const { data } = await gh.getSettled<{ content?: unknown; encoding?: unknown }>(`/repos/${source.repo}/git/blobs/${f.sha as string}`, () => true);
        raw = data.encoding === "base64" && typeof data.content === "string" ? JSON.parse(decodeBase64(data.content)) : undefined;
      } catch (e) {
        // One day that fails is that day unreadable; a rate limit stops the read.
        if (e instanceof RateLimited) throw e;
        raw = undefined;
      }
      const day = parseCostDay(raw, date);
      return day ? { date, day } : { date, unreadable: true };
    }),
  );
  return { state: "ok", days };
}
