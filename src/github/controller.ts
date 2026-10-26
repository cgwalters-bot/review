// The controller panel: what runs without anyone at a keyboard, and
// whether an interactive session is there too. The hosted pieces are
// workflows listed in controller.json, not here; for each the latest
// finished run (and one in progress) is read from the Actions API. What
// the board scheduler's pass did is not read here: the pass publishes it
// with its holds (holds.ts).

import { CacheMiss, GitHubError, type GitHub } from "./api.ts";
import config from "./controller.json" with { type: "json" };
import { isStale, type Heartbeat } from "./heartbeat.ts";
import { isActiveRun, type RawRun } from "./ops.ts";

export interface HostedPiece {
  label: string;
  /** What it does, in a few words. */
  what: string;
  /** OWNER/NAME. */
  repo: string;
  /** The workflow's file name. */
  workflow: string;
  /** Also list every run in flight. */
  read?: "in-flight";
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
      if (p.staleAfterMinutes !== undefined) {
        if (typeof p.staleAfterMinutes !== "number" || !Number.isInteger(p.staleAfterMinutes) || p.staleAfterMinutes < 1 || p.staleAfterMinutes > 10080) throw new Error(`controller config: ${at}.staleAfterMinutes must be an integer from 1 to 10080`);
        piece.staleAfterMinutes = p.staleAfterMinutes;
      }
      if (p.read !== undefined) {
        if (p.read !== "in-flight") throw new Error(`controller config: ${at}.read must be in-flight`);
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

/** A run. */
export interface Ran {
  url: string;
  /** When it finished, or for one in progress, when it started. */
  at: string;
  conclusion?: string;
  /** For one not finished: queued, waiting or in_progress. */
  status?: string;
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
   * absent: no such workflow, or it never ran: not built yet. uncached: a
   * cached render that lacks it.
   */
  state: "ok" | "absent" | "uncached" | "error";
  last?: Ran;
  running?: Ran;
  inFlight?: InFlight[];
  error?: string;
}

export interface ControllerData {
  pieces: PieceState[];
}

function ranOf(url: string, at: string | null | undefined, conclusion: string | null | undefined): Ran | undefined {
  if (!at) return undefined;
  return conclusion ? { url, at, conclusion } : { url, at };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function loadPiece(gh: GitHub, piece: HostedPiece): Promise<PieceState> {
  const base = `/repos/${piece.repo}/actions/workflows/${piece.workflow}/runs`;
  const runsOf = async (path: string) => (await gh.get<{ workflow_runs?: RawRun[] }>(path)).data.workflow_runs ?? [];
  let runs: RawRun[];
  try {
    runs = await runsOf(`${base}?per_page=${RUNS_READ}`);
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
    const lists = await Promise.all(IN_FLIGHT_STATUSES.map((st) => runsOf(`${base}?status=${st}&per_page=${RUNS_READ}`)));
    const byId = new Map(lists.flat().filter(isActiveRun).map((r) => [r.id, r]));
    out.inFlight = [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((r) => ({ title: r.display_title?.trim() || `run ${r.id}`, url: r.html_url, status: r.status ?? "unknown", since: r.run_started_at ?? r.created_at }));
  }
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

/** Every hosted piece, side by side; one failing is shown as failed, and the others still load. */
export async function loadController(gh: GitHub, raw: unknown = CONTROLLER): Promise<ControllerData> {
  const cfg = parseControllerConfig(raw);
  const pieces = await Promise.all(
    cfg.hosted.map((piece) => loadPiece(gh, piece).catch(
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
