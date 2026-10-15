// The controller panel: what runs without anyone at a keyboard, and
// whether an interactive session is there too. The hosted pieces are
// workflows, or one job of a workflow, listed in controller.json, not
// here; for each the latest finished run (and one in progress) is read
// from the Actions API. The board scheduler's mode and what it started
// come from its pass's first line and item lines, as schedule.cjs prints
// them. The repository variable that
// sets the mode may not be readable with the viewer's token, the job
// summary has no API, and the log redirects to blob storage, which the
// page's connect-src (api.github.com only, the token's second fence)
// refuses. The row accepts an optional pasted log/summary instead of
// assuming that tracker publishes check annotations (it does not).

import { CacheMiss, GitHubError, type GitHub } from "./api.ts";
import config from "./controller.json" with { type: "json" };
import { isStale, type Heartbeat } from "./heartbeat.ts";
import { isActiveRun, type RawRun } from "./ops.ts";

/** How a piece is read beyond its latest run: the scheduler's log, or every run in flight. */
export type PieceRead = "scheduler" | "in-flight";

export interface HostedPiece {
  label: string;
  /** What it does, in a few words. */
  what: string;
  /** OWNER/NAME. */
  repo: string;
  /** The workflow's file name. */
  workflow: string;
  /** One job of it, by name; else the run as a whole. */
  job?: string;
  read?: PieceRead;
  /** Opt-in warning when no pass has finished within this many minutes. */
  staleAfterMinutes?: number;
}

export interface ControllerConfig {
  hosted: HostedPiece[];
}

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const WORKFLOW_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;
/** More would cost a read each on every refresh; the panel is meant to be short. */
const MAX_PIECES = 12;
const MAX_TEXT = 100;

/**
 * controller.json, checked: each repo and workflow is spliced into an
 * API path the viewer's token is sent to, so one that isn't a plain
 * name (a "../" in it, say) is refused rather than read.
 */
export function parseControllerConfig(raw: unknown): ControllerConfig {
  const hosted = (raw as { hosted?: unknown } | null)?.hosted;
  if (!Array.isArray(hosted)) throw new Error("controller config: hosted must be a list");
  if (hosted.length > MAX_PIECES) throw new Error(`controller config: at most ${MAX_PIECES} hosted pieces`);
  const text = (v: unknown, what: string): string => {
    if (typeof v !== "string" || !v.trim() || v.length > MAX_TEXT) throw new Error(`controller config: ${what} must be a short non-empty string`);
    return v;
  };
  return {
    hosted: hosted.map((p: Record<string, unknown> | null, i) => {
      const at = `hosted[${i}]`;
      if (typeof p !== "object" || p === null) throw new Error(`controller config: ${at} must be an object`);
      const piece: HostedPiece = { label: text(p.label, `${at}.label`), what: text(p.what, `${at}.what`), repo: text(p.repo, `${at}.repo`), workflow: text(p.workflow, `${at}.workflow`) };
      if (!REPO_RE.test(piece.repo)) throw new Error(`controller config: ${at}.repo is not OWNER/NAME`);
      if (!WORKFLOW_RE.test(piece.workflow)) throw new Error(`controller config: ${at}.workflow is not a workflow file name`);
      if (p.job !== undefined) piece.job = text(p.job, `${at}.job`);
      if (p.staleAfterMinutes !== undefined) {
        if (typeof p.staleAfterMinutes !== "number" || !Number.isInteger(p.staleAfterMinutes) || p.staleAfterMinutes < 1 || p.staleAfterMinutes > 10080) throw new Error(`controller config: ${at}.staleAfterMinutes must be an integer from 1 to 10080`);
        piece.staleAfterMinutes = p.staleAfterMinutes;
      }
      if (p.read !== undefined) {
        if (p.read !== "scheduler" && p.read !== "in-flight") throw new Error(`controller config: ${at}.read must be scheduler or in-flight`);
        piece.read = p.read;
      }
      return piece;
    }),
  };
}

/** controller.json as shipped, parsed on each load: a bad one is a warning in the ops view, not a broken app. */
export const CONTROLLER: unknown = config;

/** Runs read per workflow: enough to reach a finished one while newer ones run, and the runs in flight. */
const RUNS_READ = 30;
/** The statuses of a run in flight, each listed on its own. */
const IN_FLIGHT_STATUSES = ["in_progress", "queued", "waiting", "pending", "requested"] as const;
/** Runs whose jobs are read looking for a piece's job: a few, since a dispatched run may skip it. */
const JOB_RUNS_READ = 5;

export interface RawJobRun {
  id: number;
  name?: string;
  html_url?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

/** A run, or a job of one. */
export interface Ran {
  url: string;
  /** When it finished, or for one in progress, when it started. */
  at: string;
  conclusion?: string;
  /** For one not finished: queued, waiting or in_progress. */
  status?: string;
}

/** What the scheduler's last pass did: previewed (`[dry-run]`) or acted, and the runs it would start or started. */
export interface SchedulerPass {
  mode: "preview" | "acting" | "unknown";
  starts?: number;
  liveEpics?: number;
  candidates?: number;
  items?: string[];
  census?: string[];
  raw?: string;
}

export interface InFlight {
  title: string;
  url: string;
  status: string;
  since: string;
}

export interface PieceState {
  piece: HostedPiece;
  /**
   * absent: no such workflow, or it never ran: not built yet. unseen: its
   * job wasn't in the workflow's last few runs (not built, or skipped).
   * uncached: a cached render that lacks it.
   */
  state: "ok" | "absent" | "unseen" | "uncached" | "error";
  last?: Ran;
  running?: Ran;
  scheduler?: SchedulerPass;
  inFlight?: InFlight[];
  error?: string;
}

export interface ControllerData {
  pieces: PieceState[];
}

/** A scheduler pass's first line, and a line for an item it starts (not a skip, nor an error). */
const FORMATS = config.formats;
const PASS_RE = new RegExp(FORMATS.pass);
const IDLE_RE = new RegExp(FORMATS.idle);
const ITEM_RE = new RegExp(FORMATS.item);
const CENSUS_RE = new RegExp(FORMATS.census);
/** Avoid freezing the panel on a pasted build log; no network read is added. */
export const MAX_CONTROLLER_OUTPUT = 128 * 1024;
/** An Actions log line's timestamp, should a notice carry log lines as they were. */
const STAMP_RE = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;

/** The scheduler's pass, from its lines (schedule.cjs prints "[dry-run] " before each line of a preview). */
export function schedulerPass(log: string): SchedulerPass {
  if (log.length > MAX_CONTROLLER_OUTPUT) return { mode: "unknown", raw: "Output exceeds 128 KiB; paste only the scheduler and census output." };
  let out: SchedulerPass = { mode: "unknown" };
  const census: string[] = [];
  for (const raw of log.split("\n")) {
    const line = raw.replace(STAMP_RE, "").trimEnd();
    const pass = PASS_RE.exec(line);
    const idle = IDLE_RE.exec(line);
    if (pass || idle) {
      // A log with two passes counts the last.
      census.length = 0;
      const match = pass ?? idle!;
      const candidates = pass ? Number(pass[2]) : 0;
      const liveEpics = pass ? Number(pass[3]) : 0;
      out = Number.isSafeInteger(candidates) && Number.isSafeInteger(liveEpics)
        ? { mode: match[1] ? "preview" : "acting", starts: 0, candidates, liveEpics, items: [] }
        : { mode: "unknown", raw: line };
    }
    else if (CENSUS_RE.test(line)) census.push(line);
    else {
      const item = ITEM_RE.exec(line);
      if (item && out.mode !== "unknown" && Boolean(item[1]) === (out.mode === "preview")) {
        out.items!.push(line);
        if (item[4] === "dispatch" || item[4] === "triage") out.starts!++;
      } else if (line.startsWith("[dry-run] ") || /^(?:\d+ |no live epics|schedule:|\S+#\d+ )/.test(line)) {
        out = { mode: "unknown", raw: line };
      } else if (out.mode === "unknown" && line.trim() && !out.raw) out.raw = line;
    }
  }
  if (census.length) out.census = census;
  return out;
}

function ranOf(url: string, at: string | null | undefined, conclusion: string | null | undefined): Ran | undefined {
  if (!at) return undefined;
  return conclusion ? { url, at, conclusion } : { url, at };
}

interface Reads {
  runs: (path: string) => Promise<RawRun[]>;
  jobs: (repo: string, run: RawRun) => Promise<RawJobRun[]>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function loadPiece(gh: GitHub, piece: HostedPiece, reads: Reads): Promise<PieceState> {
  const base = `/repos/${piece.repo}/actions/workflows/${piece.workflow}/runs`;
  let runs: RawRun[];
  try {
    runs = await reads.runs(`${base}?per_page=${RUNS_READ}`);
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 404)) throw e;
    // No such workflow on the default branch: not built yet. Unless the
    // repository is what 404s, as for a token that can't see it: that is
    // unread, not "not built", or the panel would say nothing is hosted.
    await gh.get(`/repos/${piece.repo}`);
    return { piece, state: "absent" };
  }
  if (!runs.length) return { piece, state: "absent" };
  const out: PieceState = { piece, state: "ok" };
  if (piece.read === "in-flight") {
    // By status, not from the newest runs: a long run outlives many short ones after it.
    const lists = await Promise.all(IN_FLIGHT_STATUSES.map((st) => reads.runs(`${base}?status=${st}&per_page=${RUNS_READ}`)));
    const byId = new Map(lists.flat().filter(isActiveRun).map((r) => [r.id, r]));
    out.inFlight = [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((r) => ({ title: r.display_title?.trim() || `run ${r.id}`, url: r.html_url, status: r.status ?? "unknown", since: r.run_started_at ?? r.created_at }));
  }
  if (!piece.job) {
    const done = runs.find((r) => r.status === "completed");
    const active = runs.find(isActiveRun);
    if (done) {
      const last = ranOf(done.html_url, done.updated_at ?? done.created_at, done.conclusion);
      if (last) out.last = last;
    }
    if (active && (!done || Date.parse(active.created_at) > Date.parse(done.created_at))) {
      const running = ranOf(active.html_url, active.run_started_at ?? active.created_at, undefined);
      if (running) out.running = { ...running, status: active.status ?? "in_progress" };
    }
    return out;
  }
  // The newest runs that ran the job: one in progress, then the last finished.
  let seen = false;
  for (const run of runs.slice(0, JOB_RUNS_READ)) {
    const job = (await reads.jobs(piece.repo, run)).find((j) => j.name === piece.job && j.conclusion !== "skipped");
    if (!job) continue;
    seen = true;
    const url = job.html_url ?? run.html_url;
    if (job.status !== "completed") {
      const running = ranOf(url, job.started_at ?? run.run_started_at ?? run.created_at, undefined);
      if (running && !out.running) out.running = { ...running, status: job.status ?? "in_progress" };
      continue;
    }
    const last = ranOf(url, job.completed_at, job.conclusion);
    if (last) out.last = last;
    if (piece.read === "scheduler") {
      out.scheduler = { mode: "unknown" };
    }
    break;
  }
  if (!seen) out.state = "unseen";
  return out;
}

/**
 * Every hosted piece, side by side; one failing is shown as failed, and
 * the others still load. The runs and jobs several pieces share
 * (poll.yml's) are read once.
 */
export async function loadController(gh: GitHub, raw: unknown = CONTROLLER): Promise<ControllerData> {
  const cfg = parseControllerConfig(raw);
  const runLists = new Map<string, Promise<RawRun[]>>();
  const runsOf = (path: string): Promise<RawRun[]> => {
    let p = runLists.get(path);
    if (!p) {
      p = gh.get<{ workflow_runs?: RawRun[] }>(path).then((r) => r.data.workflow_runs ?? []);
      runLists.set(path, p);
    }
    return p;
  };
  const jobs = new Map<string, Promise<RawJobRun[]>>();
  const jobsOf = (repo: string, run: RawRun): Promise<RawJobRun[]> => {
    const key = `${repo}/${run.id}/${run.run_attempt ?? 1}`;
    let p = jobs.get(key);
    if (!p) {
      const path = `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=30`;
      const final = (d: { jobs?: RawJobRun[] }) => !!d.jobs?.length && d.jobs.every((j) => j.status === "completed");
      // A run in progress is read conditionally, so a cached render has its last copy.
      p = (isActiveRun(run) ? gh.get<{ jobs?: RawJobRun[] }>(path) : gh.getSettled<{ jobs?: RawJobRun[] }>(path, final)).then((r) => r.data.jobs ?? []);
      jobs.set(key, p);
    }
    return p;
  };
  const pieces = await Promise.all(
    cfg.hosted.map((piece) => loadPiece(gh, piece, { runs: runsOf, jobs: jobsOf }).catch(
      (e: unknown): PieceState => (e instanceof CacheMiss ? { piece, state: "uncached" } : { piece, state: "error", error: message(e) }),
    )),
  );
  return { pieces };
}

/**
 * Whether the interactive session is there: its heartbeat is fresh and it
 * didn't say it stopped. Fresh as the Local agents section has it: within
 * HEARTBEAT_STALE_MS, or asleep until a wake time it gave (plus grace).
 */
export function sessionPresent(hb: Heartbeat | null | undefined, now: number): boolean {
  return !!hb && hb.loopState !== "stopped" && !isStale(hb, now);
}
