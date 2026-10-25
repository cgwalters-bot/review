// agent.yml is an independent Actions source, not a heartbeat worker list.
import { GitHubError, type GitHub } from "./api.ts";
import { AGENT_WORKFLOW, DEVSPACE_REPO, FETCH_CONCURRENCY } from "./config.ts";
import { agentRunOf, coresOf, isActiveRun, jobsFinal, type AgentRun, type RawJob, type RawRun } from "./ops.ts";
import { mapLimit } from "./prs.ts";

export const RUNS_POLL_MS = 60_000;
const HOUR = 3_600_000;
const PAGE_SIZE = 100;
const USD_SCALE = 1_000_000;

export interface RunTitleMetrics {
  tokens: number | null;
  /** Explicit USD reading, never inferred from tokens or runner time. */
  cost: number | null;
}

/** Standalone labeled fields only; see README for the deliberately narrow grammar. */
export function parseRunTitleMetrics(title: string | undefined): RunTitleMetrics {
  const fields = (title ?? "").split(/[()[\];|·]|,(?=\s*(?:tokens|cost)\s*[:=])/i).flatMap((part) => {
    const match = /^\s*(tokens|cost)\s*[:=]\s*([\s\S]*?)\s*$/i.exec(part);
    return match ? [[match[1]!.toLowerCase(), match[2]!] as const] : [];
  });
  const single = (name: string): string | undefined => {
    const values = fields.filter(([key]) => key === name);
    return values.length === 1 ? values[0]![1] : undefined;
  };
  const rawTokens = single("tokens");
  const tokens = rawTokens !== undefined && /^\d+$/.test(rawTokens) ? Number(rawTokens) : NaN;
  const rawCost = single("cost");
  const amount = /^(?:\$\s*|USD\s+)(\d+)(?:\.(\d{1,6}))?$/i.exec(rawCost ?? "");
  const units = amount ? Number(amount[1]) * USD_SCALE + Number((amount[2] ?? "").padEnd(6, "0")) : NaN;
  const cost = units / USD_SCALE;
  return { tokens: Number.isSafeInteger(tokens) ? tokens : null,
    cost: Number.isSafeInteger(units) && Math.round(cost * USD_SCALE) === units ? cost : null };
}

export interface RunJob extends RawJob {
  id?: number;
  name?: string;
  html_url?: string;
  runner_name?: string;
  conclusion?: string | null;
}

export interface ActionRun extends AgentRun {
  metrics: RunTitleMetrics;
  createdAt: string;
  attempt: number;
  jobs: RunJob[];
  jobsError?: string;
}

export interface RunsData {
  state: "ok" | "unavailable";
  at: number;
  runs: ActionRun[];
  partial: boolean;
  warnings: string[];
}

export interface RunTotals {
  count: number;
  active: number;
  completed: number;
  failed: number;
  coreHours: number | null;
  buckets: number[];
  partial: boolean;
  unknownJobs: number;
  tokens: number | null;
  cost: number | null;
  tokensKnownRuns: number;
  costKnownRuns: number;
  tokensPartial: boolean;
  costPartial: boolean;
}

export function runTotals(data: RunsData, now: number): RunTotals {
  const from = now - 24 * HOUR;
  const recent = data.runs.filter((r) => Date.parse(r.createdAt) >= from && Date.parse(r.createdAt) <= now);
  const titleTotal = (metric: keyof RunTitleMetrics) => {
    const readings = recent.flatMap((run) => run.metrics[metric] === null ? [] : [run.metrics[metric]]);
    const scale = metric === "cost" ? USD_SCALE : 1;
    const units = readings.reduce((sum, reading) => sum + Math.round(reading * scale), 0);
    const value = units / scale;
    const safe = Number.isSafeInteger(units) && Math.round(value * scale) === units;
    const empty = data.state === "ok" && !data.partial && !recent.length;
    return { value: safe && (readings.length > 0 || empty) ? value : null, known: readings.length,
      partial: data.state !== "ok" || data.partial || readings.length < recent.length || recent.some((run) => run.active) || !safe };
  };
  const tokens = titleTotal("tokens");
  const cost = titleTotal("cost");
  const buckets = Array<number>(24).fill(0);
  let known = 0;
  let unknownJobs = 0;
  for (const run of data.runs) {
    if (run.jobsError || !run.jobs.length) unknownJobs++;
    for (const job of run.jobs) {
      const start = Date.parse(job.started_at ?? "");
      const end = job.completed_at ? Date.parse(job.completed_at) : job.status === "in_progress" ? now : NaN;
      const cores = coresOf(job.labels);
      if (!cores || !Number.isFinite(start) || !Number.isFinite(end)) {
        unknownJobs++;
        continue;
      }
      known++;
      for (let i = 0; i < 24; i++) {
        const b = from + i * HOUR;
        buckets[i] = (buckets[i] ?? 0) + Math.max(0, Math.min(end, b + HOUR, now) - Math.max(start, b)) * cores / HOUR;
      }
    }
  }
  return { count: recent.length, active: data.runs.filter((r) => r.active).length, completed: recent.filter((r) => !r.active).length,
    failed: recent.filter((r) => r.outcome === "failed").length,
    coreHours: known ? buckets.reduce((a, b) => a + b, 0) : data.state === "ok" && !data.runs.length && !data.partial ? 0 : null, buckets,
    partial: data.partial || unknownJobs > 0 || tokens.partial || cost.partial, unknownJobs,
    tokens: tokens.value, cost: cost.value, tokensKnownRuns: tokens.known, costKnownRuns: cost.known,
    tokensPartial: tokens.partial, costPartial: cost.partial };
}

/** Conditional list/job reads; final jobs are cached per attempt. Bounded lists are explicitly partial. */
export async function loadActionRuns(gh: GitHub, now = Date.now()): Promise<RunsData> {
  const base = `/repos/${DEVSPACE_REPO}/actions/workflows/${AGENT_WORKFLOW}/runs?per_page=${PAGE_SIZE}`;
  const warnings: string[] = [];
  try {
    const lists = await Promise.all(["", ...["requested", "waiting", "pending", "queued", "in_progress"].map((s) => `&status=${s}`)].map(async (suffix) =>
      (await gh.get<{ workflow_runs: RawRun[]; total_count: number }>(base + suffix)).data));
    // Concurrent status queries can still see an older attempt/status than
    // the unfiltered list. Keep the newest evidence rather than the last query.
    const byId = new Map<number, RawRun>();
    for (const run of lists.flatMap((l) => l.workflow_runs)) {
      const previous = byId.get(run.id);
      const attempt = (run.run_attempt ?? 1) - (previous?.run_attempt ?? 1);
      const updated = (run.updated_at ?? run.created_at).localeCompare(previous?.updated_at ?? previous?.created_at ?? "");
      if (!previous || attempt > 0 || (attempt === 0 && (updated > 0 || (updated === 0 && previous.status !== "completed" && run.status === "completed")))) byId.set(run.id, run);
    }
    const raw = [...byId.values()];
    const from = now - 24 * HOUR;
    const wanted = raw.filter((r) => isActiveRun(r) || Date.parse(r.updated_at ?? r.created_at) >= from);
    // Even old runs can have a recent retry whose jobs overlap the window.
    // A truncated history cannot establish complete core-hour coverage.
    const partial = lists.some((l) => l.total_count > l.workflow_runs.length);
    const runs = await mapLimit(wanted, FETCH_CONCURRENCY, async (r): Promise<ActionRun> => {
      const run: ActionRun = { ...agentRunOf(r), metrics: parseRunTitleMetrics(r.display_title), createdAt: r.created_at, attempt: r.run_attempt ?? 1, jobs: [] };
      try {
        const path = `/repos/${DEVSPACE_REPO}/actions/runs/${r.id}/attempts/${run.attempt}/jobs?per_page=100`;
        const jobs = (await (run.active ? gh.get<{ jobs: RunJob[]; total_count: number }>(path) : gh.getSettled<{ jobs: RunJob[]; total_count: number }>(path, (d) => d.total_count === d.jobs.length && jobsFinal(d.jobs, run.attempt)))).data;
        run.jobs = jobs.jobs;
        if (jobs.total_count > jobs.jobs.length) run.jobsError = "Job list truncated";
      } catch (e) {
        run.jobsError = e instanceof Error ? e.message : String(e);
      }
      return run;
    });
    if (partial) warnings.push("Actions list truncated; totals are a lower bound and some runs may be missing.");
    const retries = runs.some((run) => run.attempt > 1);
    if (retries) warnings.push("Only latest-attempt jobs are included; earlier attempts may add runner time in this window.");
    return { state: "ok", at: now, runs: runs.sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt.localeCompare(a.createdAt)), partial: partial || retries, warnings };
  } catch (e) {
    warnings.push(e instanceof GitHubError && e.status === 404 ? "agent.yml unavailable: workflow missing or inaccessible with this token." : `Actions unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return { state: "unavailable", at: now, runs: [], partial: true, warnings };
  }
}
