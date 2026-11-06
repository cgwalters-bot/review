// Independent pass history proposed in #248, recovered at 1d30f03.
// What the scheduler's recent passes did, as agent-board publishes it
// (docs/passes.md, `agent-board/passes/v1`): the bot's own comment beside
// the hold snapshot, read in the same request. It is a separate comment
// because the hold snapshot is written only after a pass's stages 3 and 4
// succeed, so a failed or partial pass would never reach it.
//
// Read-only display data: nothing here authorizes a write or is followed
// as an address. Links are built from typed repository, number and run id
// parts; every text field is a bounded single line, with any address left
// in it redacted. What is missing, malformed or unread stays unknown,
// never zero or empty.

import { isBot } from "./authors.ts";
import { fencedJson, isObject, type RawComment, str, time } from "./heartbeat.ts";
import { ITEM_RE } from "./usage.ts";

/** The comment's first line. */
export const PASSES_MARKER = "<!-- agent-board-passes v1 -->";
const SCHEMA = "agent-board/passes/v1";

/** Bounds of the contract (docs/passes.md): past one, that block is unreadable. */
export const MAX_PASSES = 10;
const MAX_SECTIONS = 16;
const MAX_STARTS = 20;
const MAX_NO_START = 20;
const MAX_POOLS = 16;
const MAX_IN_FLIGHT = 50;
/** One line of text: a first error line, never a body. */
const MAX_TEXT = 200;
/** GitHub's comment cap is 65,536 characters; a body past this is not the producer's. */
export const MAX_BODY = 60_000;
const MAX_COUNT = 1_000_000;

/**
 * A pool is well under pace when its allowed percent is at least this many
 * points above its used percent. Fixed here, not published, so the flag
 * is the same for every reader of the same numbers.
 */
export const UNDER_PACE_POINTS = 20;
/** A publication or observation older than this may be from a pass that stopped. */
export const STALE_MS = 3600_000;
/** A time further ahead of the viewer's clock than this is not trusted either. */
const SKEW_MS = 5 * 60_000;

const TOKEN_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export type Mode = "actions" | "preview" | "local";
export type Result = "success" | "partial" | "failure";
export type Outcome = "ok" | "failed" | "skipped" | "cut-short";
/** An unrecognized start state is read as uncertain, never as confirmed. */
export type StartState = "confirmed" | "preview" | "uncertain";

export interface RunRef {
  repository: string;
  id: number;
  attempt?: number;
}

export interface Section {
  name: string;
  outcome: Outcome;
  /** The first error line, addresses redacted; null where there was none. */
  error: string | null;
}

export interface Start {
  state: StartState;
  /** OWNER/REPO#N. */
  item: string;
  kind: string;
  pool: string | null;
  run: RunRef | null;
}

export interface NoStart {
  /** no-ready-work, replan-wait, capped, held, or a newer token shown as it is. */
  reason: string;
  item: string | null;
  until: string | null;
  cap: string | null;
  hold: string | null;
}

export interface Candidates {
  read: number;
  unread: number;
  ready: number;
}

export interface Pass {
  run: RunRef | null;
  startedAt: string;
  finishedAt: string;
  mode: Mode;
  result: Result;
  sections: Section[];
  starts: Start[];
  noStart: NoStart[];
  /** Null where stage 4 did not get as far as reading them. */
  candidates: Candidates | null;
  omitted: { sections: number; starts: number; noStart: number };
}

export interface Pool {
  pool: string;
  observedAt: string;
  usedPercent: number | null;
  allowedPercent: number | null;
  resetsAt: string | null;
  held: boolean | null;
  ready: number | null;
}

export interface Pools {
  observedAt: string;
  complete: boolean;
  omitted: number;
  items: Pool[];
}

export interface FlightRun {
  item: string;
  kind: string;
  pool: string | null;
  run: RunRef;
  since: string | null;
}

export interface FlightPr {
  repository: string;
  number: number;
  state: "merge-queue" | "review-wait";
  since: string | null;
}

export interface InFlight {
  observedAt: string;
  complete: boolean;
  omitted: number;
  runs: FlightRun[];
  prs: FlightPr[];
}

export interface Passes {
  publishedAt: string;
  /** The newest records the producer keeps. */
  retention: number;
  /** Records left out to fit the byte bound. */
  omitted: number;
  passes: Pass[];
  /** Records present but not readable here, left out and counted. */
  unreadable: number;
  /** Null where none is published; a string says why the published one is unreadable. */
  pools: Pools | string | null;
  inFlight: InFlight | string | null;
}

const ADDRESS_RES: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b(?::\d+)?/gi,
  // Host names: three labels or more (inference.example.com, 1.2.3.4.nip.io), or a private suffix.
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+){2,}\b(?::\d+)?/gi,
  /\b[a-z0-9-]+\.(?:internal|local|lan|home\.arpa|localdomain)\b(?::\d+)?/gi,
  // Bracketed IPv6 includes unspecified and trailing compression, with a port.
  /\[(?=[0-9a-f:.%\w-]*:)[0-9a-f:]+(?:%[a-z0-9_.-]+)?\](?::\d+)?/gi,
  // Bare trailing compression, including ::, but not a Rust namespace.
  /(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?![\w:])/gi,
  // Three colons or more, so a time of day (12:30:00) is not taken for one; or a :: form.
  /\[?\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}\b\]?(?::\d+)?/gi,
  /\[?(?:\b[0-9a-f]{1,4})?::[0-9a-f]{1,4}\b(?::[0-9a-f]{1,4})*\]?(?::\d+)?/gi,
  // host:port, the host starting with a letter so that T12:30 is not one.
  /\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*:\d{2,5}\b/gi,
];

/** Any URL, tailnet name, IP address or host:port in published text, replaced: the producer must leave them out, and this is a second guard. */
export function redactAddresses(text: string): string {
  return ADDRESS_RES.reduce((t, re) => t.replace(re, "[address]"), text);
}

const isToken = (v: unknown): v is string => typeof v === "string" && TOKEN_RE.test(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_COUNT;
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isPercent = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1000;
const isItem = (v: unknown): v is string => typeof v === "string" && v.length <= 212 && ITEM_RE.test(v) && isRepo(v.split("#")[0]);
const isRepo = (v: unknown): v is string => typeof v === "string" && REPO_RE.test(v) && !v.split("/").some((p) => p === "." || p === "..");
const nullable = <T>(v: unknown, read: (v: unknown) => T | undefined): T | null | undefined => (v === null ? null : read(v));
const pick = <T extends string>(v: unknown, values: readonly T[]): T | undefined => (values as readonly unknown[]).includes(v) ? (v as T) : undefined;

/** One line of display text, addresses redacted; undefined if it isn't one. */
function line(v: unknown): string | undefined {
  if (typeof v !== "string" || !v || v.length > MAX_TEXT || /[\x00-\x1f\x7f\u2028\u2029]/.test(v)) return undefined;
  return redactAddresses(v);
}

function runRef(v: unknown): RunRef | undefined {
  if (!isObject(v) || !isRepo(v.repository) || !isId(v.id)) return undefined;
  if (v.attempt !== undefined && !isId(v.attempt)) return undefined;
  return { repository: v.repository, id: v.id, ...(v.attempt === undefined ? {} : { attempt: v.attempt as number }) };
}

/** Every element, or undefined if any isn't one or there are more than `max`. */
function list<T>(v: unknown, max: number, read: (v: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(v) || v.length > max) return undefined;
  const out = v.map(read);
  return out.every((x) => x !== undefined) ? (out as T[]) : undefined;
}

function section(v: unknown): Section | undefined {
  if (!isObject(v) || !isToken(v.name)) return undefined;
  const outcome = pick(v.outcome, ["ok", "failed", "skipped", "cut-short"] as const);
  const error = nullable(v.error, line);
  // A failed section says why; one that didn't fail has nothing to say.
  if (!outcome || error === undefined || (outcome === "failed") !== (error !== null)) return undefined;
  return { name: v.name, outcome, error };
}

function start(v: unknown): Start | undefined {
  if (!isObject(v) || !isItem(v.item) || !isToken(v.kind)) return undefined;
  const pool = nullable(v.pool, (p) => (isToken(p) ? p : undefined));
  const run = nullable(v.run, runRef);
  if (pool === undefined || run === undefined || !isToken(v.state)) return undefined;
  const state = pick(v.state, ["confirmed", "preview"] as const) ?? "uncertain";
  // Confirmed means the dispatch was accepted; a preview has no run.
  if (state === "preview" && run) return undefined;
  return { state, item: v.item, kind: v.kind, pool, run };
}

function noStart(v: unknown): NoStart | undefined {
  if (!isObject(v) || !isToken(v.reason)) return undefined;
  const item = nullable(v.item, (i) => (isItem(i) ? i : undefined));
  const until = nullable(v.until, time);
  const cap = nullable(v.cap, (c) => (isToken(c) ? c : undefined));
  const hold = nullable(v.hold, (c) => (isToken(c) ? c : undefined));
  if (item === undefined || until === undefined || cap === undefined || hold === undefined) return undefined;
  // A re-plan wait is until a time; that is what it says.
  if (v.reason === "replan-wait" && !until) return undefined;
  return { reason: v.reason, item, until, cap, hold };
}

function pass(v: unknown): Pass | undefined {
  if (!isObject(v) || !isObject(v.omitted)) return undefined;
  const run = nullable(v.run, runRef);
  const startedAt = time(v.started_at);
  const finishedAt = time(v.finished_at);
  const mode = pick(v.mode, ["actions", "preview", "local"] as const);
  const result = pick(v.result, ["success", "partial", "failure"] as const);
  const sections = list(v.sections, MAX_SECTIONS, section);
  const starts = list(v.starts, MAX_STARTS, start);
  const noStarts = list(v.no_start, MAX_NO_START, noStart);
  const c = v.candidates;
  const candidates = c === null ? null : isObject(c) && isCount(c.read) && isCount(c.unread) && isCount(c.ready) ? { read: c.read, unread: c.unread, ready: c.ready } : undefined;
  const o = v.omitted;
  if (run === undefined || !startedAt || !finishedAt || Date.parse(finishedAt) < Date.parse(startedAt) || !mode || !result
    || !sections || !starts || !noStarts || candidates === undefined || !isCount(o.sections) || !isCount(o.starts) || !isCount(o.no_start)) return undefined;
  // A pass's mode decides what its starts can be: a preview confirms nothing, an apply previews nothing.
  if (starts.some((s) => (s.state === "preview") !== (mode === "preview"))) return undefined;
  return { run, startedAt, finishedAt, mode, result, sections, starts, noStart: noStarts, candidates, omitted: { sections: o.sections, starts: o.starts, noStart: o.no_start } };
}

function pool(v: unknown): Pool | undefined {
  if (!isObject(v) || !isToken(v.pool)) return undefined;
  const observedAt = time(v.observed_at);
  const usedPercent = nullable(v.used_percent, (p) => (isPercent(p) ? p : undefined));
  const allowedPercent = nullable(v.allowed_percent, (p) => (isPercent(p) ? p : undefined));
  const resetsAt = nullable(v.resets_at, time);
  const held = nullable(v.held, (b) => (typeof b === "boolean" ? b : undefined));
  const ready = nullable(v.ready, (n) => (isCount(n) ? n : undefined));
  if (!observedAt || usedPercent === undefined || allowedPercent === undefined || resetsAt === undefined || held === undefined || ready === undefined) return undefined;
  return { pool: v.pool, observedAt, usedPercent, allowedPercent, resetsAt, held, ready };
}

function flightRun(v: unknown): FlightRun | undefined {
  if (!isObject(v) || !isItem(v.item) || !isToken(v.kind)) return undefined;
  const pool = nullable(v.pool, (p) => (isToken(p) ? p : undefined));
  const run = runRef(v.run);
  const since = nullable(v.since, time);
  if (pool === undefined || !run || since === undefined) return undefined;
  return { item: v.item, kind: v.kind, pool, run, since };
}

function flightPr(v: unknown): FlightPr | undefined {
  if (!isObject(v) || !isRepo(v.repository) || !isId(v.number)) return undefined;
  const state = pick(v.state, ["merge-queue", "review-wait"] as const);
  const since = nullable(v.since, time);
  if (!state || since === undefined) return undefined;
  return { repository: v.repository, number: v.number, state, since };
}

function observed(v: unknown): { observedAt: string; complete: boolean; omitted: number } | undefined {
  if (!isObject(v)) return undefined;
  const observedAt = time(v.observed_at);
  return observedAt && typeof v.complete === "boolean" && isCount(v.omitted) ? { observedAt, complete: v.complete, omitted: v.omitted } : undefined;
}

function pools(v: unknown): Pools | string | null {
  if (v === null || v === undefined) return null;
  const head = observed(v);
  const items = isObject(v) ? list(v.items, MAX_POOLS, pool) : undefined;
  return head && items ? { ...head, items } : "malformed or past its bounds";
}

function inFlight(v: unknown): InFlight | string | null {
  if (v === null || v === undefined) return null;
  const head = observed(v);
  const runs = isObject(v) ? list(v.runs, MAX_IN_FLIGHT, flightRun) : undefined;
  const prs = isObject(v) ? list(v.prs, MAX_IN_FLIGHT, flightPr) : undefined;
  return head && runs && prs ? { ...head, runs, prs } : "malformed or past its bounds";
}

/**
 * The passes in a comment's body: undefined if it isn't one, a string
 * saying why if it is one that can't be used. A malformed pass record is
 * left out and counted, not the others with it; a malformed pools or
 * in-flight block is unreadable on its own.
 */
export function parsePasses(body: string | null | undefined): Passes | string | undefined {
  if (!body?.startsWith(PASSES_MARKER)) return undefined;
  if (body.length > MAX_BODY) return `over ${MAX_BODY} characters`;
  const raw = fencedJson(body, PASSES_MARKER);
  if (!raw) return "no JSON object";
  if (raw.schema !== SCHEMA) return `unknown schema ${redactAddresses(str(raw.schema, /^[\x20-\x7e]{1,64}$/) ?? "(none)")}`;
  const publishedAt = time(raw.published_at);
  if (!publishedAt || !isCount(raw.retention) || !isCount(raw.omitted) || !Array.isArray(raw.passes)) return "malformed header";
  if (raw.passes.length > MAX_PASSES) return `more than ${MAX_PASSES} passes`;
  const read = raw.passes.map(pass);
  const passes = read.filter((p) => p !== undefined).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return { publishedAt, retention: raw.retention, omitted: raw.omitted, passes, unreadable: read.length - passes.length, pools: pools(raw.pools), inFlight: inFlight(raw.in_flight) };
}

/** The bot's newest pass comment among an issue's comments: undefined where none is published. */
export function findPasses(comments: readonly RawComment[]): Passes | string | undefined {
  const c = comments.findLast((c) => isBot(c.user?.login) && c.body?.startsWith(PASSES_MARKER));
  return parsePasses(c?.body);
}

/** Whether a pool is well under pace by UNDER_PACE_POINTS; undefined when either reading is missing. */
export function underPace(p: Pool): boolean | undefined {
  return p.usedPercent === null || p.allowedPercent === null ? undefined : p.allowedPercent - p.usedPercent >= UNDER_PACE_POINTS;
}

/**
 * Whether a pass shows, from complete evidence, that nothing was ready: it
 * succeeded with every section listed and none failed or cut short, and
 * read every candidate, none of them ready. Anything less is unknown.
 */
export function readyEvidence(p: Pass): boolean {
  return p.result === "success" && p.sections.length > 0 && p.omitted.sections === 0
    && p.sections.every((s) => s.outcome === "ok" || s.outcome === "skipped")
    && p.candidates !== null && p.candidates.unread === 0 && p.candidates.ready === 0;
}

/** Whether a time is too old to trust, or ahead of this clock by more than a little skew. */
export function stale(iso: string, now: number): boolean {
  const t = Date.parse(iso);
  return now - t > STALE_MS || t - now > SKEW_MS;
}

/**
 * Whether the publication shows nothing ready from complete evidence: its
 * newest pass is its newest record (none unreadable or left out), that
 * pass's evidence is complete, and the pool readings are whole and current.
 */
export function nothingReady(p: Passes, now: number): boolean {
  const newest = p.passes[0];
  if (!newest || newest.mode === "preview" || p.unreadable || p.omitted || stale(newest.finishedAt, now) || stale(p.publishedAt, now) || !readyEvidence(newest)) return false;
  return typeof p.pools === "object" && p.pools !== null && p.pools.complete && !p.pools.omitted && !stale(p.pools.observedAt, now);
}
