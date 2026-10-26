// The ops view: what the bot is running now. Devspaces and agent runs
// are workflow runs in DEVSPACE_REPO (see bin/bot-devspace and
// bin/bot-runs in homegit), local agents are the coordinator's
// heartbeat (heartbeat.ts), usage is the plan's, from a private
// repository (usage.ts), the whole board feeds the changes feed
// (boardfeed.ts) and active work (its In Progress items), and bot
// activity is its public events. Pure parsing and
// derivation here, plus the reads: conditional (ETags), and a finished
// run's job is read once.

import type { Active } from "./agents.ts";
import { CacheMiss, GitHubError, type GitHub } from "./api.ts";
import { loadWholeBoard } from "./backend.ts";
import { type Item, priorityIndex } from "./board.ts";
import {
  AGENT_WORKFLOW,
  BOT_LOGIN,
  DEVSPACE_HOST_PREFIX,
  DEVSPACE_REPO,
  DEVSPACE_WORKFLOW,
  FETCH_CONCURRENCY,
  IN_PROGRESS,
  OPS_AGENT_RECENT,
  OPS_EVENTS,
  OPS_RUNS_PER_PAGE,
  OPS_WINDOW_HOURS,
} from "./config.ts";
import { CONTROLLER, type ControllerData, loadController } from "./controller.ts";
import { isOwnOrg, itemOrg, type Preset } from "./filter.ts";
import { type Heartbeat, loadHeartbeat } from "./heartbeat.ts";
import { loadUsage, type UsageData } from "./usage.ts";
import { loadHolds } from "./holds.ts";
import { mapLimit } from "./prs.ts";
import { readSource, type Sources } from "./freshness.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** devspace.yml's run-name: "Devspace NAME", optionally followed by " (16c, 120m)". */
const DEVSPACE_TITLE_RE = /^Devspace (\S+?)(?: \((\d+)c, (\d+)m\))?$/;
/** The longest duration devspace.yml offers, in minutes: the bound when a run's own isn't known. */
export const DEVSPACE_MAX_MINUTES = 240;
/** The step that keeps a devspace up; its duration timer starts when it does. */
const KEEP_STEP_RE = /keep the devspace available/i;
/** A runner label naming its size, e.g. rhel10-x86_64-16c-64g. */
const CORES_LABEL_RE = /(?:^|-)(\d+)c(?:-|$)/;

/** The run statuses of a run that hasn't finished. */
const ACTIVE_STATUSES: readonly string[] = ["requested", "waiting", "pending", "queued", "in_progress"];

// The subsets of the Actions API the view reads.

export interface RawRun {
  id: number;
  html_url: string;
  display_title?: string;
  status?: string | null;
  conclusion?: string | null;
  created_at: string;
  run_started_at?: string | null;
  updated_at?: string;
  run_attempt?: number;
  actor?: { login?: string } | null;
}

export interface RawStep {
  name?: string;
  status?: string;
  started_at?: string | null;
}

export interface RawJob {
  labels?: string[];
  status?: string;
  started_at?: string | null;
  completed_at?: string | null;
  run_attempt?: number;
  steps?: RawStep[];
}

/** Whether a run's jobs, as read, are final: every job of `attempt` completed. */
export function jobsFinal(jobs: readonly RawJob[] | undefined, attempt: number): boolean {
  return !!jobs?.length && jobs.every((j) => !!j.completed_at && (j.run_attempt ?? attempt) === attempt);
}

/** What a run's job adds to it: the runner's size and the phase timestamps. */
export interface JobInfo {
  cores?: number;
  startedAt?: string;
  completedAt?: string;
  /** When the keep-alive step started, which is when its timer starts. */
  readyAt?: string;
  /** Whether the keep-alive step has finished (the job is tearing down). */
  keepDone: boolean;
}

/**
 * What a devspace is doing: waiting for a runner, setting up, reachable,
 * tearing down, or finished.
 */
export type Phase = "queued" | "starting" | "ready" | "ending" | "done";

/**
 * How a devspace ended. Cancelled is how bot-devspace stop ends one, so
 * it is the normal case, not a failure; success means it ran out its
 * duration.
 */
export type Outcome = "stopped" | "expired" | "failed" | "other";

export interface Devspace {
  id: number;
  name: string;
  host: string;
  url: string;
  phase: Phase;
  outcome?: Outcome;
  /** The run's conclusion as GitHub names it, when finished. */
  conclusion?: string;
  cores?: number;
  /** Minutes asked for, when the run's title says (see DEVSPACE_TITLE_RE). */
  durationMin?: number;
  createdAt: string;
  /** When the runner picked it up (the job's start), else the run's. */
  startedAt?: string;
  readyAt?: string;
  /** When it finished, if it did. */
  endedAt?: string;
}

/** The name and, when the title carries them, the cores and minutes of a devspace run. */
export function parseDevspaceTitle(title: string | undefined): { name: string; cores?: number; durationMin?: number } | undefined {
  const m = DEVSPACE_TITLE_RE.exec(title?.trim() ?? "");
  if (!m?.[1]) return undefined;
  return { name: m[1], ...(m[2] ? { cores: Number(m[2]) } : {}), ...(m[3] ? { durationMin: Number(m[3]) } : {}) };
}

/** The cores a runner label names, if any. */
export function coresOf(labels: readonly string[] | undefined): number | undefined {
  for (const l of labels ?? []) {
    const m = CORES_LABEL_RE.exec(l);
    if (m?.[1]) return Number(m[1]);
  }
  return undefined;
}

/** A run's job, as JobInfo; the first job, since devspace.yml has one. */
export function parseJobs(jobs: readonly RawJob[]): JobInfo {
  const job = jobs[0];
  if (!job) return { keepDone: false };
  const keep = job.steps?.find((s) => KEEP_STEP_RE.test(s.name ?? ""));
  const info: JobInfo = { keepDone: keep?.status === "completed" };
  const cores = coresOf(job.labels);
  if (cores !== undefined) info.cores = cores;
  if (job.started_at) info.startedAt = job.started_at;
  if (job.completed_at) info.completedAt = job.completed_at;
  if (keep?.started_at && keep.status !== "queued" && keep.status !== "pending") info.readyAt = keep.started_at;
  return info;
}

export function isActiveRun(run: Pick<RawRun, "status">): boolean {
  return ACTIVE_STATUSES.includes(run.status ?? "");
}

export function outcomeOf(conclusion: string | null | undefined): Outcome {
  switch (conclusion) {
    case "cancelled":
      return "stopped";
    case "success":
      return "expired";
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "action_required":
      return "failed";
    default:
      return "other";
  }
}

function phaseOf(run: RawRun, job: JobInfo | undefined): Phase {
  if (!isActiveRun(run)) return "done";
  if (run.status !== "in_progress" || !job?.startedAt) return "queued";
  if (job.keepDone) return "ending";
  return job.readyAt ? "ready" : "starting";
}

/** A devspace.yml run as a devspace row, or undefined if its title isn't a devspace's. */
export function devspaceOf(run: RawRun, job: JobInfo | undefined): Devspace | undefined {
  const title = parseDevspaceTitle(run.display_title);
  if (!title) return undefined;
  const phase = phaseOf(run, job);
  const d: Devspace = { id: run.id, name: title.name, host: `${DEVSPACE_HOST_PREFIX}${run.id}`, url: run.html_url, phase, createdAt: run.created_at };
  const cores = job?.cores ?? title.cores;
  if (cores !== undefined) d.cores = cores;
  if (title.durationMin !== undefined) d.durationMin = title.durationMin;
  const started = job?.startedAt ?? run.run_started_at ?? undefined;
  if (started) d.startedAt = started;
  if (job?.readyAt) d.readyAt = job.readyAt;
  if (phase === "done") {
    d.outcome = outcomeOf(run.conclusion);
    if (run.conclusion) d.conclusion = run.conclusion;
    const ended = job?.completedAt ?? run.updated_at;
    if (ended) d.endedAt = ended;
  }
  return d;
}

export interface Remaining {
  ms: number;
  /** Of the whole duration, for a progress bar. */
  totalMs: number;
  /** "known" when the run says its duration; "max" when this is only the longest any devspace gets. */
  bound: "known" | "max";
}

/**
 * The time left on a live devspace: its duration from when its timer
 * started (the keep-alive step, else the job), or at most the longest
 * duration when the run doesn't say its own.
 */
export function timeLeft(d: Devspace, now: number): Remaining | undefined {
  if (d.phase === "done" || d.phase === "queued") return undefined;
  const anchor = Date.parse(d.readyAt ?? d.startedAt ?? "");
  if (Number.isNaN(anchor)) return undefined;
  const bound = d.durationMin !== undefined ? "known" : "max";
  const totalMs = (d.durationMin ?? DEVSPACE_MAX_MINUTES) * MINUTE;
  return { ms: Math.max(0, anchor + totalMs - now), totalMs, bound };
}

/** The part of [start, end) inside [from, to), in ms. */
function overlap(start: number, end: number, from: number, to: number): number {
  return Math.max(0, Math.min(end, to) - Math.max(start, from));
}

/** When a devspace held its runner: from the job's start to its end, or now. */
function span(d: Devspace, now: number): [number, number] | undefined {
  const start = Date.parse(d.startedAt ?? "");
  if (Number.isNaN(start)) return undefined;
  const end = d.endedAt ? Date.parse(d.endedAt) : now;
  return Number.isNaN(end) ? undefined : [start, Math.min(end, now)];
}

/**
 * Core-hours per hour over the last `hours` hours, oldest first, the last
 * bucket ending now. Devspaces of unknown size count nothing.
 */
export function coreHourBuckets(devspaces: readonly Devspace[], now: number, hours: number): number[] {
  const buckets = new Array<number>(hours).fill(0);
  const from = now - hours * HOUR;
  for (const d of devspaces) {
    const s = span(d, now);
    if (!s || !d.cores) continue;
    for (let i = 0; i < hours; i++) {
      const b = from + i * HOUR;
      buckets[i] = (buckets[i] ?? 0) + (overlap(s[0], s[1], b, b + HOUR) * d.cores) / HOUR;
    }
  }
  return buckets;
}

export interface History {
  /** Devspaces created in the window. */
  count: number;
  /** Core-hours used in the window, by every devspace (also ones started before it). */
  coreHours: number;
  buckets: number[];
  outcomes: Record<Outcome, number>;
  /** Devspaces in the window whose size isn't known, so their core-hours aren't counted. */
  unsized: number;
}

export function history(devspaces: readonly Devspace[], now: number, hours: number): History {
  const from = now - hours * HOUR;
  const buckets = coreHourBuckets(devspaces, now, hours);
  const outcomes: Record<Outcome, number> = { stopped: 0, expired: 0, failed: 0, other: 0 };
  let count = 0;
  let unsized = 0;
  for (const d of devspaces) {
    const inWindow = Date.parse(d.createdAt) >= from;
    if (inWindow) count++;
    if (inWindow && d.outcome) outcomes[d.outcome]++;
    const s = span(d, now);
    if (!d.cores && s && s[1] > from) unsized++;
  }
  return { count, coreHours: buckets.reduce((a, b) => a + b, 0), buckets, outcomes, unsized };
}

export interface AgentRun {
  id: number;
  title: string;
  url: string;
  active: boolean;
  status: string;
  conclusion?: string;
  outcome?: Outcome;
  actor?: string;
  startedAt: string;
  updatedAt?: string;
}

export function agentRunOf(run: RawRun): AgentRun {
  const a: AgentRun = {
    id: run.id,
    title: run.display_title?.trim() || `run ${run.id}`,
    url: run.html_url,
    active: isActiveRun(run),
    status: run.status ?? "unknown",
    startedAt: run.run_started_at ?? run.created_at,
  };
  if (!a.active) {
    a.outcome = outcomeOf(run.conclusion);
    if (run.conclusion) a.conclusion = run.conclusion;
  }
  if (run.actor?.login) a.actor = run.actor.login;
  if (run.updated_at) a.updatedAt = run.updated_at;
  return a;
}

/** The runs to show: every active one, then the newest finished ones. */
export function agentRuns(runs: readonly RawRun[], recent: number): AgentRun[] {
  const all = runs.map(agentRunOf);
  return [...all.filter((r) => r.active), ...all.filter((r) => !r.active).slice(0, recent)];
}

/** Active work, split like the queue's presets. */
export interface WorkGroup {
  scope: Exclude<Preset, "all"> | "none";
  items: Item[];
}

/** In Progress items by scope (upstream, the bot's own, no org), each by priority then most recently updated. */
export function workGroups(items: readonly Item[]): WorkGroup[] {
  const groups: WorkGroup[] = [
    { scope: "composefs", items: [] },
    { scope: "infra", items: [] },
    { scope: "none", items: [] },
  ];
  for (const item of items) {
    const org = itemOrg(item);
    const g = org === undefined ? groups[2] : isOwnOrg(org) ? groups[1] : groups[0];
    g?.items.push(item);
  }
  for (const g of groups) {
    g.items.sort((a, b) => priorityIndex(a.priority) - priorityIndex(b.priority) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }
  return groups.filter((g) => g.items.length > 0);
}

// The bot's activity, from the events API.

export interface RawEvent {
  id: string;
  type: string;
  created_at: string;
  repo?: { name?: string };
  payload?: {
    action?: string;
    ref?: string | null;
    ref_type?: string;
    head?: string;
    number?: number;
    issue?: { number?: number; title?: string; html_url?: string; pull_request?: unknown };
    comment?: { html_url?: string };
    review?: { state?: string; html_url?: string };
    pull_request?: { number?: number; title?: string; html_url?: string; merged?: boolean };
  };
}

export type EventKind = "push" | "pr" | "review" | "comment" | "issue" | "branch";

export interface BotEvent {
  kind: EventKind;
  repo: string;
  /** What happened, e.g. "opened", "commented on". */
  verb: string;
  /** What it happened to, e.g. "#31" or a branch. */
  target: string;
  title?: string;
  url: string;
  at: string;
  /** Consecutive events folded into this one. */
  count: number;
}

const GITHUB = "https://github.com";
const REPO_NAME_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** An event as a row, or undefined for kinds the view skips (stars, forks, ...). */
export function parseEvent(raw: RawEvent): BotEvent | undefined {
  const repo = raw.repo?.name ?? "";
  if (!REPO_NAME_RE.test(repo)) return undefined;
  const p = raw.payload ?? {};
  const base = { repo, at: raw.created_at, count: 1 };
  const repoUrl = `${GITHUB}/${repo}`;
  switch (raw.type) {
    case "PushEvent": {
      const branch = (p.ref ?? "").replace(/^refs\/heads\//, "");
      const url = p.head && /^[0-9a-f]{40}$/.test(p.head) ? `${repoUrl}/commit/${p.head}` : repoUrl;
      return { ...base, kind: "push", verb: "pushed", target: branch || "?", url };
    }
    case "PullRequestEvent": {
      const pr = p.pull_request ?? {};
      const n = pr.number ?? p.number;
      if (!n) return undefined;
      const verb = p.action === "closed" && pr.merged ? "merged" : (p.action ?? "updated");
      return { ...base, kind: "pr", verb: `${verb} PR`, target: `#${n}`, url: pr.html_url ?? `${repoUrl}/pull/${n}`, ...(pr.title ? { title: pr.title } : {}) };
    }
    case "PullRequestReviewEvent": {
      const n = p.pull_request?.number;
      if (!n) return undefined;
      const state = p.review?.state?.toLowerCase().replace(/_/g, " ");
      return { ...base, kind: "review", verb: state && state !== "commented" ? `reviewed (${state})` : "reviewed", target: `#${n}`, url: p.review?.html_url ?? `${repoUrl}/pull/${n}` };
    }
    case "PullRequestReviewCommentEvent": {
      const n = p.pull_request?.number;
      if (!n) return undefined;
      return { ...base, kind: "comment", verb: "commented on the diff of", target: `#${n}`, url: p.comment?.html_url ?? `${repoUrl}/pull/${n}` };
    }
    case "IssueCommentEvent":
    case "IssuesEvent": {
      const n = p.issue?.number;
      if (!n) return undefined;
      const comment = raw.type === "IssueCommentEvent";
      const url = (comment ? p.comment?.html_url : undefined) ?? p.issue?.html_url ?? `${repoUrl}/issues/${n}`;
      const verb = comment ? "commented on" : `${p.action ?? "updated"} issue`;
      return { ...base, kind: comment ? "comment" : "issue", verb, target: `#${n}`, url, ...(p.issue?.title ? { title: p.issue.title } : {}) };
    }
    case "CreateEvent":
    case "DeleteEvent": {
      if (p.ref_type !== "branch" || !p.ref) return undefined;
      const created = raw.type === "CreateEvent";
      return { ...base, kind: "branch", verb: created ? "created branch" : "deleted branch", target: p.ref, url: created ? `${repoUrl}/tree/${p.ref}` : repoUrl };
    }
    default:
      return undefined;
  }
}

/** Events newest first, each run of the same action on the same thing folded into one. */
export function botEvents(raw: readonly RawEvent[]): BotEvent[] {
  const out: BotEvent[] = [];
  const sorted = [...raw].sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const r of sorted) {
    const e = parseEvent(r);
    if (!e) continue;
    const last = out.at(-1);
    if (last && last.kind === e.kind && last.repo === e.repo && last.verb === e.verb && last.target === e.target) last.count++;
    else out.push(e);
  }
  return out;
}

// Reading it all.

/** A finished run's job, by run id and attempt: it never changes. */
export type JobCache = Map<string, JobInfo>;

export interface DevspaceData {
  devspaces: Devspace[];
  /** The one page read may not reach back over the whole window. */
  partial: boolean;
}

export type AgentData = { deployed: true; runs: AgentRun[] } | { deployed: false };

export interface Ops {
  sources?: Sources;
  /** Each section is undefined when its read failed; see warnings. */
  devspaces?: DevspaceData;
  agents?: AgentData;
  /** The coordinator's heartbeat; null when none is published. */
  local?: Heartbeat | null;
  /** The plan's usage, from the private repository. */
  usage?: UsageData;
  /** Every unarchived board item, for the changes feed. */
  board?: Item[];
  work?: Item[];
  events?: BotEvent[];
  /** The hosted pieces of the controller (controller.ts). */
  controller?: ControllerData;
  warnings: string[];
  at: number;
  /** Read from the cache only (a first render before GitHub answers): sections not cached are undefined, without a warning. */
  fromCache?: boolean;
}

const runsPath = (workflow: string) => `/repos/${DEVSPACE_REPO}/actions/workflows/${workflow}/runs?per_page=${OPS_RUNS_PER_PAGE}`;

async function loadDevspaces(gh: GitHub, cache: JobCache, now: number): Promise<DevspaceData> {
  const runs = (await gh.get<{ workflow_runs?: RawRun[] }>(runsPath(DEVSPACE_WORKFLOW))).data.workflow_runs ?? [];
  const from = now - OPS_WINDOW_HOURS * HOUR;
  // Active runs, and finished ones that ended inside the window.
  const wanted = runs.filter((r) => isActiveRun(r) || Date.parse(r.updated_at ?? r.created_at) >= from);
  const key = (r: RawRun) => `${r.id}/${r.run_attempt ?? 1}`;
  const jobs = new Map<number, JobInfo>();
  await mapLimit(wanted, FETCH_CONCURRENCY, async (r) => {
    const cached = cache.get(key(r));
    if (cached && !isActiveRun(r)) {
      jobs.set(r.id, cached);
      return;
    }
    try {
      // A finished run's jobs never change: a copy whose jobs had all
      // completed, read in this tab or an earlier one, is final.
      const path = `/repos/${DEVSPACE_REPO}/actions/runs/${r.id}/jobs?filter=latest&per_page=10`;
      const attempt = r.run_attempt ?? 1;
      const res = await (isActiveRun(r)
        ? gh.get<{ jobs?: RawJob[] }>(path)
        : gh.getSettled<{ jobs?: RawJob[] }>(path, (d) => jobsFinal(d.jobs, attempt)));
      const info = parseJobs(res.data.jobs ?? []);
      jobs.set(r.id, info);
      if (!isActiveRun(r)) cache.set(key(r), info);
    } catch {
      // Shown without its size; the next refresh tries again.
    }
  });
  const devspaces = wanted.flatMap((r) => devspaceOf(r, jobs.get(r.id)) ?? []);
  const oldest = runs.at(-1);
  const partial = runs.length >= OPS_RUNS_PER_PAGE && oldest !== undefined && Date.parse(oldest.created_at) > from;
  return { devspaces, partial };
}

async function loadAgents(gh: GitHub): Promise<AgentData> {
  try {
    const res = await gh.get<{ workflow_runs?: RawRun[] }>(runsPath(AGENT_WORKFLOW));
    return { deployed: true, runs: agentRuns(res.data.workflow_runs ?? [], OPS_AGENT_RECENT) };
  } catch (e) {
    // No such workflow on the default branch (yet).
    if (e instanceof GitHubError && e.status === 404) return { deployed: false };
    throw e;
  }
}

const eventReads = new WeakMap<GitHub, { events?: BotEvent[]; next: number; interval: number; pending?: Promise<BotEvent[]> }>();

/** Shared by Activity and ops; even an explicit refresh respects GitHub's minimum interval. */
export async function loadEvents(gh: GitHub, now = Date.now()): Promise<BotEvent[]> {
  let state = eventReads.get(gh);
  if (!state) {
    state = { next: 0, interval: MINUTE };
    eventReads.set(gh, state);
  }
  if (state.pending) return state.pending;
  if (state.events && now < state.next) return state.events;
  const current = state;
  current.pending = (async () => {
    const res = await gh.get<RawEvent[]>(`/users/${BOT_LOGIN}/events/public?per_page=${OPS_EVENTS}`, (headers) => {
      const interval = Number(headers.get("x-poll-interval") ?? NaN) * 1000;
      if (Number.isFinite(interval) && interval > 0) current.interval = Math.max(MINUTE, interval);
    });
    current.events = botEvents(res.data);
    current.next = now + current.interval;
    return current.events;
  })();
  try {
    return await current.pending;
  } finally {
    delete current.pending;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A guard that turns a section's failed read into a warning (none for a cache miss) and undefined. */
function guarded(warnings: string[]) {
  return async <T>(what: string, p: Promise<T>): Promise<T | undefined> => {
    try {
      return await p;
    } catch (e) {
      if (!(e instanceof CacheMiss)) warnings.push(`Couldn't read ${what}: ${message(e)}`);
      return undefined;
    }
  };
}

/**
 * What the agents, changes and usage sections need, and no more: the
 * whole board, the heartbeat and the usage, all conditional reads that
 * cost nothing while unchanged. The ops detail reads the same three, so
 * either read serves the other. The inbox's holds are the usage issue's
 * comments again: one more 304.
 */
export async function loadActive(gh: GitHub, now: number = Date.now()): Promise<Active> {
  const warnings: string[] = [];
  const sources: Sources = {};
  const [board, local, usage, holds] = await Promise.all([
    readSource(sources, "board", (source) => loadWholeBoard(source).then((q) => q.items), gh),
    readSource(sources, "heartbeat", (source) => loadHeartbeat(source), gh),
    readSource(sources, "usage", (source) => loadUsage(source), gh),
    loadHolds(gh),
  ]);
  for (const [name, source] of Object.entries(sources)) if (source.error) warnings.push(`Couldn't read ${name}: ${source.error}`);
  const active: Active = { warnings, at: now, sources };
  if (board) active.board = board;
  if (local !== undefined) active.local = local;
  if (usage) active.usage = usage;
  if (holds) active.holds = holds;
  return active;
}

/** Read every section side by side; one failing leaves the others. */
export async function loadOps(gh: GitHub, cache: JobCache, now: number = Date.now(), controller: unknown = CONTROLLER): Promise<Ops> {
  const warnings: string[] = [];
  const guard = guarded(warnings);
  const sources: Sources = {};
  const tracked = async <T>(name: string, read: (gh: GitHub) => Promise<T>): Promise<T> => {
    const scope = gh.readScope();
    try {
      const value = await read(scope);
      sources[name] = { state: scope.oldest === undefined ? "ok" : "cached", checkedAt: Date.now(), fetchedAt: scope.oldest ?? Date.now() };
      return value;
    } catch (e) {
      sources[name] = { state: "unavailable", checkedAt: Date.now(), error: message(e) };
      throw e;
    }
  };
  const [devspaces, agents, local, usage, board, events, hosted] = await Promise.all([
    guard(`the devspaces in ${DEVSPACE_REPO}`, loadDevspaces(gh, cache, now)),
    guard(`the agent runs in ${DEVSPACE_REPO}`, loadAgents(gh)),
    guard("the coordinator's heartbeat", tracked("heartbeat", (source) => loadHeartbeat(source))),
    guard("the plan's usage", tracked("usage", (source) => loadUsage(source))),
    guard("the board", tracked("board", (source) => loadWholeBoard(source).then((q) => q.items))),
    guard(`${BOT_LOGIN}'s recent activity`, loadEvents(gh)),
    guard("the controller's hosted runs", loadController(gh, controller)),
  ]);
  const ops: Ops = { warnings, at: now, sources };
  if (devspaces) ops.devspaces = devspaces;
  if (agents) ops.agents = agents;
  if (local !== undefined) ops.local = local;
  if (usage) ops.usage = usage;
  if (board) {
    ops.board = board;
    ops.work = board.filter((i) => i.status === IN_PROGRESS);
  }
  if (events) ops.events = events;
  if (hosted) ops.controller = hosted;
  return ops;
}

/** Keep last known shared data while applying every ops read's freshness, including failures. */
export function activeFromOps(previous: Active | undefined, ops: Ops): Active {
  const sources: Sources = { ...previous?.sources };
  for (const [name, source] of Object.entries(ops.sources ?? {})) sources[name] = source.state === "unavailable" ? { ...sources[name], ...source } : { ...source };
  return {
    ...previous, fromCache: false, warnings: ops.warnings, at: ops.at, sources,
    ...(ops.board !== undefined ? { board: ops.board } : {}),
    ...(ops.local !== undefined ? { local: ops.local } : {}),
    ...(ops.usage !== undefined ? { usage: ops.usage } : {}),
  };
}
