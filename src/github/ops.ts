// Shared Actions run parsing and the CLI's active-state reads.

import type { Active } from "./agents.ts";
import type { GitHub } from "./api.ts";
import { loadWholeBoard } from "./backend.ts";
import { loadHeartbeat } from "./heartbeat.ts";
import { loadUsage } from "./usage.ts";
import { loadHolds } from "./holds.ts";
import { readSource, type Sources } from "./freshness.ts";

/** A runner label naming its size, e.g. rhel10-x86_64-16c-64g. */
const CORES_LABEL_RE = /(?:^|-)(\d+)c(?:-|$)/;

/** The run statuses of a run that hasn't finished. */
const ACTIVE_STATUSES: readonly string[] = ["requested", "waiting", "pending", "queued", "in_progress"];

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

/** How an Actions run ended; success means it ran out its duration. */
export type Outcome = "stopped" | "expired" | "failed" | "other";

/** The cores a runner label names, if any. */
export function coresOf(labels: readonly string[] | undefined): number | undefined {
  for (const l of labels ?? []) {
    const m = CORES_LABEL_RE.exec(l);
    if (m?.[1]) return Number(m[1]);
  }
  return undefined;
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

/** The CLI's whole board, heartbeat, usage and published holds, with per-source freshness. */
export async function loadActive(gh: GitHub, now: number = Date.now()): Promise<Active> {
  const warnings: string[] = [];
  const sources: Sources = {};
  const [board, local, usage, holds] = await Promise.all([
    readSource(sources, "board", (source) => loadWholeBoard(source).then((q) => q.items), gh),
    readSource(sources, "heartbeat", (source) => loadHeartbeat(source), gh),
    readSource(sources, "usage", (source) => loadUsage(source), gh),
    readSource(sources, "holds", (source) => loadHolds(source), gh),
  ]);
  for (const [name, source] of Object.entries(sources)) if (source.error) warnings.push(`Couldn't read ${name}: ${source.error}`);
  const active: Active = { warnings, at: now, sources };
  if (board) active.board = board;
  if (local !== undefined) active.local = local;
  if (usage) active.usage = usage;
  if (holds) active.holds = holds;
  return active;
}
