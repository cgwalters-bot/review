// The tracker's dispatch runs, one card each on the Agents view: the live
// ones from the workflow's in-progress and queued lists, with the newest
// step of their agent job, and the ones that finished in the last
// FINISHED_MS with the result their status comment on the item gives.
// Job logs aren't readable from the page (they redirect off the API), so
// the step is as close to the agent as it gets.

import type { GitHub } from "./api.ts";
import { isBot } from "./authors.ts";
import { DISPATCH_WORKFLOW, FETCH_CONCURRENCY, TRACKER_REPO } from "./config.ts";
import { isActiveRun, type RawRun, type RawStep } from "./ops.ts";
import { mapLimit } from "./prs.ts";
import type { RunJob } from "./runs.ts";

export const DISPATCH_POLL_MS = 60_000;
/** How long a finished run stays on the view. */
export const FINISHED_MS = 6 * 3600_000;
const PAGE_SIZE = 100;
/** The job that runs the agent itself; the others set it up and hand back. */
const AGENT_JOB = /(?:^|\/ )agent$/;
/** The status comment agentic-job keeps on the item, and the run it is about. */
const STATUS_MARKER = "<!-- agentic-job-status -->";
const runMarker = (id: number): string => `<!-- agentic-job-run: ${id} -->`;

/** What a run's title says it works on: `KIND OWNER/REPO#N (POOL)`. */
export interface DispatchTitle {
  kind: string;
  owner: string;
  repo: string;
  number: number;
  pool: string;
}

const TITLE = /^(\S+) ([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d{0,9}) \(([^()\s]+)\)$/;

export function parseDispatchTitle(title: string | undefined): DispatchTitle | undefined {
  const m = TITLE.exec(title?.trim() ?? "");
  return m ? { kind: m[1]!, owner: m[2]!, repo: m[3]!, number: Number(m[4]), pool: m[5]! } : undefined;
}

/** The step a run is at: its job's name, the step's, and when the step started. */
export interface Step {
  job: string;
  name: string;
  since?: string;
}

/**
 * The newest step of the agent job, once it started; before that, of the
 * newest job in progress (the setup ones). Undefined while nothing runs.
 */
export function currentStep(jobs: readonly RunJob[]): Step | undefined {
  const started = jobs.filter((j) => j.status === "in_progress" || j.status === "completed");
  const job = started.find((j) => AGENT_JOB.test(j.name ?? ""))
    ?? started.filter((j) => j.status === "in_progress").sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0];
  if (!job) return undefined;
  const steps = (job.steps ?? []).filter((s): s is RawStep & { started_at: string } => !!s.started_at);
  const step = steps.find((s) => s.status === "in_progress") ?? steps.sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  const out: Step = { job: job.name ?? "job", name: step?.name ?? "starting" };
  const since = step?.started_at ?? job.started_at;
  if (since) out.since = since;
  return out;
}

/** A finished run's result, as its status comment says it. */
export interface DispatchResult {
  /** The comment's text before its markers, as plain text. */
  text: string;
  /** What it handed back (a PR or a comment), when it says. */
  url?: string;
}

interface RawComment {
  body?: string | null;
  user?: { login?: string } | null;
}

/** The bot's status comment about run `id` among an item's comments, newest first. */
export function statusResult(comments: readonly RawComment[], id: number): DispatchResult | undefined {
  const body = [...comments].reverse().find((c) => isBot(c.user?.login ?? undefined) && c.body?.includes(STATUS_MARKER) && c.body.includes(runMarker(id)))?.body;
  if (!body) return undefined;
  const end = body.indexOf("<!--");
  const text = body.slice(0, end < 0 ? undefined : end)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const url = /\bResult: (https:\/\/github\.com\/\S+)/.exec(text)?.[1];
  return url ? { text, url } : { text };
}

export interface DispatchRun {
  id: number;
  url: string;
  title: string;
  /** Undefined for a title not of the dispatch form. */
  target?: DispatchTitle;
  status: string;
  conclusion?: string;
  startedAt: string;
  /** When it last changed: for a finished run, about when it finished. */
  updatedAt: string;
  step?: Step;
  jobsError?: string;
  /** Null when its item has no status comment about it. */
  result?: DispatchResult | null;
  resultError?: string;
}

export interface DispatchData {
  state: "ok" | "unavailable";
  at: number;
  /** Every run of the in-progress and queued lists, newest first. */
  live: DispatchRun[];
  /** Runs that finished within FINISHED_MS, newest first. */
  finished: DispatchRun[];
  warnings: string[];
}

/**
 * A finished run's result, by run id, once read: a run that concluded
 * doesn't change, so its item's comments are read once.
 */
export type ResultCache = Map<number, DispatchResult | null>;

function runOf(r: RawRun): DispatchRun {
  const run: DispatchRun = {
    id: r.id,
    url: r.html_url,
    title: r.display_title?.trim() || `run ${r.id}`,
    status: r.status ?? "unknown",
    startedAt: r.run_started_at ?? r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
  };
  const target = parseDispatchTitle(r.display_title);
  if (target) run.target = target;
  if (r.conclusion) run.conclusion = r.conclusion;
  return run;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Read the live runs and their jobs, and the finished runs, with the
 * result of each not in `results` yet. Lists are one page each.
 */
export async function loadDispatch(gh: GitHub, results: ResultCache, now = Date.now()): Promise<DispatchData> {
  const base = `/repos/${TRACKER_REPO}/actions/workflows/${DISPATCH_WORKFLOW}/runs?per_page=${PAGE_SIZE}`;
  const warnings: string[] = [];
  let lists: { workflow_runs: RawRun[]; total_count: number }[];
  try {
    lists = await Promise.all(["&status=in_progress", "&status=queued", ""].map(async (q) => (await gh.get<{ workflow_runs: RawRun[]; total_count: number }>(base + q)).data));
  } catch (e) {
    return { state: "unavailable", at: now, live: [], finished: [], warnings: [`Dispatch runs unavailable: ${message(e)}`] };
  }
  const [inProgress, queued, recent] = lists as [typeof lists[0], typeof lists[0], typeof lists[0]];
  if (inProgress.total_count > inProgress.workflow_runs.length || queued.total_count > queued.workflow_runs.length) warnings.push(`More than ${PAGE_SIZE} runs are in progress or queued; only the first are shown.`);
  const live = new Map<number, RawRun>();
  for (const r of [...inProgress.workflow_runs, ...queued.workflow_runs]) live.set(r.id, r);
  const from = now - FINISHED_MS;
  const done = recent.workflow_runs.filter((r) => !live.has(r.id) && !isActiveRun(r) && Date.parse(r.updated_at ?? r.created_at) >= from);
  const last = recent.workflow_runs.at(-1);
  if (recent.total_count > recent.workflow_runs.length && last && Date.parse(last.updated_at ?? last.created_at) >= from) warnings.push(`More than ${PAGE_SIZE} runs in the last ${FINISHED_MS / 3600_000} h; the oldest finished ones are missing.`);
  const newest = (a: DispatchRun, b: DispatchRun) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id;
  const liveRuns = await mapLimit([...live.values()], FETCH_CONCURRENCY, async (r) => {
    const run = runOf(r);
    try {
      const jobs = (await gh.get<{ jobs: RunJob[] }>(`/repos/${TRACKER_REPO}/actions/runs/${r.id}/jobs?per_page=${PAGE_SIZE}`)).data.jobs;
      const step = currentStep(jobs);
      if (step) run.step = step;
    } catch (e) {
      run.jobsError = message(e);
    }
    return run;
  });
  const finished = await mapLimit(done, FETCH_CONCURRENCY, async (r) => {
    const run = runOf(r);
    const t = run.target;
    const known = results.get(r.id);
    if (known !== undefined) run.result = known;
    else if (t) {
      try {
        const comments = (await gh.get<RawComment[]>(`/repos/${t.owner}/${t.repo}/issues/${t.number}/comments?since=${encodeURIComponent(r.created_at)}&per_page=${PAGE_SIZE}`)).data;
        run.result = statusResult(comments, r.id) ?? null;
        results.set(r.id, run.result);
      } catch (e) {
        run.resultError = message(e);
      }
    }
    return run;
  });
  // Runs that left the window are never shown again.
  const shown = new Set(done.map((r) => r.id));
  for (const id of results.keys()) if (!shown.has(id)) results.delete(id);
  return { state: "ok", at: now, live: liveRuns.sort(newest), finished: finished.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id), warnings };
}
