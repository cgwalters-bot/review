// The plan's usage on the coordinator's machine, the equivalent of
// Claude Code's /usage: per window, the percent used and reset time its
// status line last reported, and the tokens its transcripts spent; plus
// tokens per worker and for the coordinator's own session.
// bin/bot-heartbeat in homegit keeps it in one comment by the bot on
// USAGE_REPO#USAGE_ISSUE, a private repository, so it is read with the
// viewer's token, and a token that can't read it just gets no panel.
// The comment is parsed strictly, like the heartbeat.

import { GitHubError, type GitHub } from "./api.ts";
import { BOT_LOGIN, USAGE_ISSUE, USAGE_REPO } from "./config.ts";
import type { RawComment } from "./heartbeat.ts";

/** The comment's first line. */
export const USAGE_MARKER = "<!-- bot-usage v1 -->";
const SCHEMA = "bot-usage/v1";
const JSON_FENCE_RE = /^```json\n([\s\S]*?)\n```$/m;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A window's kind: five_hour, seven_day, or a newer one. */
const KIND_RE = /^[a-z][a-z0-9_]{0,23}$/;
/** bot-heartbeat reports two windows; a few more are shown, no more. */
const MAX_WINDOWS = 4;
/** bot-heartbeat lists at most this many workers. */
const MAX_WORKERS = 32;
/** A token count past this is nonsense, not usage. */
const MAX_TOKENS = 1e15;
/** A percent used can pass 100 a little, when usage runs past the cap. */
const MAX_PERCENT = 1000;

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One of the plan's usage windows. */
export interface UsageWindow {
  /** five_hour or seven_day. */
  kind: string;
  /** Where the token counts start. */
  since: string;
  /** Percent used and when the window resets, when the status line has reported them. */
  usedPercent?: number;
  resetsAt?: string;
  requests: number;
  tokens: Tokens;
}

export interface UsagePool {
  usedPercent: number;
  allowedPercent: number;
  resetsAt: string;
  observedAt: string;
  hold: boolean;
}

/** Mistral has no plan window, so no percent or pace: only the broker's counters since it started. */
export interface MistralUsage {
  requests: number;
  tokens: number;
}

export interface Usage {
  updatedAt: string;
  /** When the status line last reported the percents. */
  observedAt?: string;
  windows: UsageWindow[];
  /** The coordinator's own session, in the first (5-hour) window. */
  coordinatorTokens?: Tokens;
  /** Each worker's subagents' tokens (itself and its reviewer), all told, by the heartbeat's worker name. */
  workers: { name: string; tokens: Tokens }[];
  commentUrl?: string;
  pools?: Partial<Record<"claude" | "openai", UsagePool>>;
  mistral?: MistralUsage;
}

/** What the ops view knows of the usage: the snapshot, none published yet, or a repository this token can't read. */
export type UsageData = { state: "ok"; usage: Usage } | { state: "none" } | { state: "unreadable" };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, re: RegExp): string | undefined => (typeof v === "string" && re.test(v) ? v : undefined);
const time = (v: unknown): string | undefined => {
  const s = str(v, TIME_RE);
  return s && !Number.isNaN(Date.parse(s)) ? s : undefined;
};
const count = (v: unknown, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined);

function parseTokens(raw: unknown): Tokens | undefined {
  if (!isObject(raw)) return undefined;
  const input = count(raw.input, MAX_TOKENS);
  const output = count(raw.output, MAX_TOKENS);
  const cacheRead = count(raw.cache_read, MAX_TOKENS);
  const cacheWrite = count(raw.cache_write, MAX_TOKENS);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  return { input, output, cacheRead, cacheWrite };
}

/** All of a count's tokens: cache reads too, which are most of them. */
export const tokenTotal = (t: Tokens): number => t.input + t.output + t.cacheRead + t.cacheWrite;

function parseWindow(raw: unknown): UsageWindow | undefined {
  if (!isObject(raw)) return undefined;
  const kind = str(raw.kind, KIND_RE);
  const since = time(raw.since);
  const requests = count(raw.requests, MAX_TOKENS);
  const tokens = parseTokens(raw.tokens);
  if (!kind || !since || requests === undefined || !tokens) return undefined;
  const w: UsageWindow = { kind, since, requests, tokens };
  // The percent and its reset go together, or not at all.
  const pct = count(raw.used_percent, MAX_PERCENT);
  const resetsAt = time(raw.resets_at);
  if (pct !== undefined && resetsAt) Object.assign(w, { usedPercent: pct, resetsAt });
  return w;
}

function parsePool(raw: unknown): UsagePool | undefined {
  if (!isObject(raw)) return undefined;
  const usedPercent = count(raw.used_percent, MAX_PERCENT);
  const allowedPercent = count(raw.allowed_percent, MAX_PERCENT);
  const resetsAt = time(raw.resets_at);
  const observedAt = time(raw.observed_at);
  if (usedPercent === undefined || allowedPercent === undefined || !resetsAt || !observedAt || typeof raw.hold !== "boolean") return undefined;
  return { usedPercent, allowedPercent, resetsAt, observedAt, hold: raw.hold };
}

function parseMistral(raw: unknown): MistralUsage | undefined {
  if (!isObject(raw)) return undefined;
  const requests = count(raw.requests, MAX_TOKENS);
  const tokens = count(raw.tokens, MAX_TOKENS);
  return requests === undefined || tokens === undefined ? undefined : { requests, tokens };
}

/** The usage in a comment's body, or undefined if it isn't one. Malformed windows and workers are left out. */
export function parseUsage(body: string | null | undefined): Usage | undefined {
  if (!body?.startsWith(USAGE_MARKER)) return undefined;
  const m = JSON_FENCE_RE.exec(body);
  if (!m?.[1]) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return undefined;
  }
  if (!isObject(raw) || raw.schema !== SCHEMA) return undefined;
  const pools: NonNullable<Usage["pools"]> = {};
  for (const name of ["claude", "openai"] as const) {
    const pool = isObject(raw.pools) ? parsePool(raw.pools[name]) : undefined;
    if (pool) pools[name] = pool;
  }
  const updatedAt = time(raw.updated_at);
  const windows = (Array.isArray(raw.windows) ? raw.windows.slice(0, MAX_WINDOWS) : []).flatMap((w) => parseWindow(w) ?? []);
  if (!Object.keys(pools).length && (!updatedAt || !windows.length)) return undefined;
  const workers = (Array.isArray(raw.workers) ? raw.workers.slice(0, MAX_WORKERS) : []).flatMap((w) => {
    const name = isObject(w) ? str(w.name, NAME_RE) : undefined;
    const tokens = isObject(w) ? parseTokens(w.tokens) : undefined;
    return name && tokens ? [{ name, tokens }] : [];
  });
  // A pool-only publication need not carry a publication timestamp.
  const usage: Usage = { updatedAt: updatedAt ?? "", windows, workers };
  if (Object.keys(pools).length) usage.pools = pools;
  const mistral = parseMistral(raw.mistral);
  if (mistral) usage.mistral = mistral;
  const observedAt = time(raw.observed_at);
  if (observedAt) usage.observedAt = observedAt;
  const coordinatorTokens = parseTokens(raw.coordinator_tokens);
  if (coordinatorTokens) usage.coordinatorTokens = coordinatorTokens;
  return usage;
}

/** The bot's usage comment among an issue's comments. */
export function findUsage(comments: readonly RawComment[]): Usage | undefined {
  for (const c of comments) {
    if (c.user?.login !== BOT_LOGIN) continue;
    const usage = parseUsage(c.body);
    if (!usage) continue;
    if (c.html_url) usage.commentUrl = c.html_url;
    return usage;
  }
  return undefined;
}

export const usagePath = `/repos/${USAGE_REPO}/issues/${USAGE_ISSUE}/comments?per_page=100`;

/** The published usage, read conditionally with the viewer's token; a repository it can't see (403 or 404) is "unreadable", not an error. */
export async function loadUsage(gh: GitHub): Promise<UsageData> {
  try {
    const res = await gh.get<RawComment[]>(usagePath);
    const usage = findUsage(Array.isArray(res.data) ? res.data : []);
    return usage ? { state: "ok", usage } : { state: "none" };
  } catch (e) {
    // A 403 is also how GitHub says a rate limit ran out: that's a failed read, not a private repository.
    const rateLimited = e instanceof GitHubError && e.status === 403 && (gh.rate?.remaining === 0 || /rate limit/i.test(e.message));
    if (e instanceof GitHubError && (e.status === 403 || e.status === 404) && !rateLimited) return { state: "unreadable" };
    throw e;
  }
}
