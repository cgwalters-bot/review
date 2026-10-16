// The plan's usage on the coordinator's machine, the equivalent of
// Claude Code's /usage: per window, the percent used and reset time its
// status line last reported, and the tokens its transcripts spent; plus
// tokens per worker and for the coordinator's own session.
// bin/bot-heartbeat in homegit keeps it in one comment by the bot on
// USAGE_REPO#USAGE_ISSUE, a private repository, so it is read with the
// viewer's token, and a token that can't read it just gets no panel.
// The comment is parsed strictly, like the heartbeat.

import { GitHubError, type GitHub, RateLimited } from "./api.ts";
import { BOT_LOGIN, USAGE_ISSUE, USAGE_REPO } from "./config.ts";
import type { RawComment } from "./heartbeat.ts";
import config from "./usage-config.json" with { type: "json" };

/**
 * Where Mistral's monthly allowance is configured, when the snapshot
 * carries none: a pools file whose "mistral" pool has an "allowance".
 * null turns the read off.
 */
export const USAGE_CONFIG = config as { mistralAllowance: { repo: string; path: string } | null };

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
/** Dollars, of an allowance, a spend or a price per million tokens, past this are nonsense. */
const MAX_USD = 1e9;
/** Mistral models priced or counted; more are dropped. */
const MAX_MODELS = 32;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

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
  /** The scheduler's allowance at observedAt: its target times the share of the window gone, roughly. */
  allowedPercent: number;
  resetsAt: string;
  observedAt: string;
  hold: boolean;
  /** The window's length; a week when the snapshot doesn't say. */
  windowMinutes: number;
}

/** A pool's window, in minutes, when the snapshot doesn't give one. */
const WEEK_MINUTES = 7 * 24 * 60;
/** Before this share of the window has gone a projection is noise (8 hours of a week): none is made. */
const PROJECT_FROM_PERCENT = 5;

/** What a pool's numbers say together, at the time they were observed. */
export interface PoolPace {
  /** "week", or the window's length ("5h", "3d"). */
  unit: string;
  /** Percent of the window gone when the percent used was observed. */
  gonePercent: number;
  /** Percent used the window would end at, at the rate so far. */
  projectedPercent?: number;
}

/**
 * "Pace" alone was ambiguous: the tick is the scheduler's allowance, not
 * the share of the window gone. This works that share out from the
 * window's end and length (OpenAI's week runs from its own reset, not a
 * calendar week), and projects the percent used to the window's end.
 */
export function poolPace(pool: UsagePool): PoolPace {
  const length = pool.windowMinutes * 60_000;
  const gonePercent = Math.max(0, Math.min(100, 100 * (1 - (Date.parse(pool.resetsAt) - Date.parse(pool.observedAt)) / length)));
  const hours = pool.windowMinutes / 60;
  const unit = pool.windowMinutes === WEEK_MINUTES ? "week" : hours % 24 === 0 ? `${hours / 24}d window` : `${+hours.toFixed(1)}h window`;
  const pace: PoolPace = { unit, gonePercent };
  if (gonePercent >= PROJECT_FROM_PERCENT) pace.projectedPercent = (100 * pool.usedPercent) / gonePercent;
  return pace;
}

/**
 * Spend against Mistral's monthly allowance. The allowance, its reset and
 * the prices are the publisher's configuration, carried in the snapshot,
 * so none of them is a constant here.
 */
export interface MistralAllowance {
  limitUsd: number;
  resetsAt: string;
  spentUsd: number;
  /** Worked out from tokens and the published prices, not Mistral's own figure. */
  estimated: boolean;
  /** Models with tokens but no price, left out of an estimate. */
  unpriced: string[];
  /** An estimate that left out any entry (unpriced, malformed or past the cap): the spend is at least this. */
  lowerBound: boolean;
}

/** Mistral has no plan window, so no percent or pace: the broker's counters since it started, and the allowance when one is configured. */
export interface MistralUsage {
  requests: number;
  tokens: number;
  allowance?: MistralAllowance;
  /** The allowance from the pools file, for a snapshot that carries none: what is allowed, but no spend. */
  budget?: MistralBudget;
}

export interface MistralBudget {
  limitUsd: number;
  /** The start of the next calendar month, UTC. */
  resetsAt: string;
  /** The start of this one. */
  since: string;
  /** Where it was read from, to link. */
  url?: string;
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
  // A year at most: past that the "window" is no plan's.
  const minutes = count(raw.window_minutes, 366 * 24 * 60);
  return { usedPercent, allowedPercent, resetsAt, observedAt, hold: raw.hold, windowMinutes: minutes && minutes >= 1 ? minutes : WEEK_MINUTES };
}

/**
 * The allowance: limit_usd and resets_at, with spent_usd (Mistral's own
 * figure, preferred) or, failing that, this period's tokens per model
 * ({model, input_tokens, output_tokens}) and prices per million tokens
 * ({model: {input, output}}) to estimate it from. Undefined, and the
 * counters shown instead, when it is malformed or can't give a spend.
 */
export function parseAllowance(raw: unknown): MistralAllowance | undefined {
  if (!isObject(raw)) return undefined;
  const limitUsd = count(raw.limit_usd, MAX_USD);
  const resetsAt = time(raw.resets_at);
  if (!limitUsd || !resetsAt) return undefined;
  const spent = count(raw.spent_usd, MAX_USD);
  if (spent !== undefined) return { limitUsd, resetsAt, spentUsd: spent, estimated: false, unpriced: [], lowerBound: false };
  if (!Array.isArray(raw.models) || !isObject(raw.prices)) return undefined;
  const prices = raw.prices;
  let spentUsd = 0;
  let priced = 0;
  const unpriced: string[] = [];
  let dropped = Math.max(0, raw.models.length - MAX_MODELS);
  for (const m of raw.models.slice(0, MAX_MODELS)) {
    const model = isObject(m) ? str(m.model, MODEL_RE) : undefined;
    const input = isObject(m) ? count(m.input_tokens, MAX_TOKENS) : undefined;
    const output = isObject(m) ? count(m.output_tokens, MAX_TOKENS) : undefined;
    if (!model || input === undefined || output === undefined) {
      dropped++;
      continue;
    }
    // Own keys only: a model named "constructor" must not find a price on Object's prototype.
    const price = Object.hasOwn(prices, model) ? prices[model] : undefined;
    const inUsd = isObject(price) ? count(price.input, MAX_USD) : undefined;
    const outUsd = isObject(price) ? count(price.output, MAX_USD) : undefined;
    if (inUsd === undefined || outUsd === undefined) {
      if (input + output > 0) unpriced.push(model);
      continue;
    }
    spentUsd += (input * inUsd + output * outUsd) / 1e6;
    priced++;
  }
  // Tokens with nothing priced is no estimate at all, not a spend of $0; no tokens yet this month is $0.
  if (!priced && (unpriced.length || dropped)) return undefined;
  return { limitUsd, resetsAt, spentUsd, estimated: true, unpriced, lowerBound: unpriced.length > 0 || dropped > 0 };
}

function parseMistral(raw: unknown): MistralUsage | undefined {
  if (!isObject(raw)) return undefined;
  const requests = count(raw.requests, MAX_TOKENS);
  const tokens = count(raw.tokens, MAX_TOKENS);
  if (requests === undefined || tokens === undefined) return undefined;
  const allowance = parseAllowance(raw.allowance);
  return allowance ? { requests, tokens, allowance } : { requests, tokens };
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

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PATH_RE = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.json$/;
/** Pools files this tab's token can't read: not asked for again until a reload. */
const unreadableBudgets = new Set<string>();
/** A pools file is a few hundred bytes; past this it is not one. */
const MAX_POOLS_BYTES = 64 * 1024;

/**
 * The "mistral" pool's allowance in a pools file, as tracker's
 * .github/agentic-job/pools.json has it: {amount, currency: "USD",
 * period: "calendar-month"}. Anything else is not understood, so no budget.
 */
export function parseBudget(text: string, now: number): MistralBudget | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const allowance = isObject(raw) && isObject(raw.mistral) ? raw.mistral.allowance : undefined;
  if (!isObject(allowance) || allowance.currency !== "USD" || allowance.period !== "calendar-month") return undefined;
  const limitUsd = count(allowance.amount, MAX_USD);
  if (!limitUsd) return undefined;
  const d = new Date(now);
  return { limitUsd, since: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(), resetsAt: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString() };
}

/**
 * The allowance from the configured pools file: one more conditional
 * GET (a 304 costs no rate budget), made only for a snapshot with a
 * Mistral row and no allowance of its own, after the usage read rather
 * than beside it. A file that can't be read just leaves the counters.
 */
async function loadBudget(gh: GitHub, now: number, target = USAGE_CONFIG.mistralAllowance): Promise<MistralBudget | undefined> {
  // Both are spliced into a path the viewer's token is sent to: no "." or "..".
  if (!target || !REPO_RE.test(target.repo) || !PATH_RE.test(target.path) || [...target.repo.split("/"), ...target.path.split("/")].some((part) => /^\.+$/.test(part))) return undefined;
  const path = `/repos/${target.repo}/contents/${target.path}`;
  // A 404 has no ETag to revalidate, so asking again would cost budget each refresh.
  if (unreadableBudgets.has(path)) return undefined;
  try {
    const { data } = await gh.get<{ content?: string; encoding?: string; size?: number; html_url?: string }>(path);
    if (data.encoding !== "base64" || typeof data.content !== "string" || (data.size ?? 0) > MAX_POOLS_BYTES) return undefined;
    const budget = parseBudget(new TextDecoder().decode(Uint8Array.from(atob(data.content.replace(/\s/g, "")), (c) => c.charCodeAt(0))), now);
    if (budget && typeof data.html_url === "string" && data.html_url.startsWith("https://github.com/")) budget.url = data.html_url;
    return budget;
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 403 || e.status === 404) && !(e instanceof RateLimited)) unreadableBudgets.add(path);
    return undefined;
  }
}

/** The published usage, read conditionally with the viewer's token; a repository it can't see (403 or 404) is "unreadable", not an error. */
export async function loadUsage(gh: GitHub, now = Date.now(), budgetFrom = USAGE_CONFIG.mistralAllowance): Promise<UsageData> {
  try {
    const res = await gh.get<RawComment[]>(usagePath);
    const usage = findUsage(Array.isArray(res.data) ? res.data : []);
    if (usage?.mistral && !usage.mistral.allowance) {
      const budget = await loadBudget(gh, now, budgetFrom);
      if (budget) usage.mistral.budget = budget;
    }
    return usage ? { state: "ok", usage } : { state: "none" };
  } catch (e) {
    // A 403 is also how GitHub says a rate limit ran out: that's a failed read, not a private repository.
    if (e instanceof GitHubError && (e.status === 403 || e.status === 404) && !(e instanceof RateLimited)) return { state: "unreadable" };
    throw e;
  }
}
