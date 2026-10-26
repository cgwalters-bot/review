// Execution evidence comes from live Actions runs and fresh heartbeat jobs.
// The board supplies context, never proof that a claimed agent still runs.

import { type Item, parseIssueUrl, priorityIndex, repoOf } from "./board.ts";
import { AGENT_TARGET, IN_PROGRESS, TRACKER_REPO } from "./config.ts";
import { isOwnOrg, itemOrg } from "./filter.ts";
import { type Heartbeat, isStale } from "./heartbeat.ts";
import type { UsageData } from "./usage.ts";
import type { Holds } from "./holds.ts";
import type { ProjectStatus } from "./backend.ts";
import type { Sources } from "./freshness.ts";
import { RUNS_POLL_MS, type RunsData } from "./runs.ts";
import { DISPATCH_POLL_MS, type DispatchData } from "./dispatch.ts";

/** What the strip shows: the whole board and the heartbeat, as last read. */
export interface Active {
  sources?: Sources;
  status?: ProjectStatus | null;
  statusError?: string;
  /** Every unarchived board item; undefined when its read failed or isn't cached. */
  board?: Item[];
  /** The heartbeat: undefined when its read failed or isn't cached, null when none is published. */
  local?: Heartbeat | null;
  /** The plan's usage, for the usage section; undefined when its read failed or isn't cached. */
  usage?: UsageData;
  /** The pass's published holds; undefined when none could be read. */
  holds?: Holds;
  warnings: string[];
  at: number;
  /** Read from the cache only, before GitHub answered. */
  fromCache?: boolean;
}

/** Whom the work is for: the bot's own harness, upstream, or unknown (a tracker issue without an Org). */
export type Lane = "harness" | "upstream" | "unknown";

/** Where an agent was seen. */
export type AgentSource = "heartbeat" | "board" | "both" | "actions";

export interface ActiveAgent {
  engine?: string;
  location: "remote" | "local";
  /** The worker's name, else the item's Lead, else "agent run". */
  name: string;
  itemUrl?: string;
  /** OWNER/REPO#N, when the item is an issue or PR. */
  itemRef?: string;
  title?: string;
  priority?: string;
  /** The worker's last reported status; for one only the board knows, "run" or "claimed". */
  status: string;
  /** When it started: the worker's start, else when its board item last changed. */
  since?: string;
  source: AgentSource;
  lane: Lane;
  lead?: string;
  runUrl?: string;
  devspace?: string;
  /** Execution isn't confirmed: stale/unread sources or only a board claim. */
  stale: boolean;
}

export interface HeartbeatState {
  updatedAt: string;
  loopState: string;
  /** Too old to trust (see isStale). */
  stale: boolean;
  /** The coordinator said it stopped: its workers may have ended with it. */
  stopped: boolean;
}

export interface AgentSummary {
  /** At least one execution source was read, even if it reported no agents. */
  executionKnown: boolean;
  locations: { remote: number; local: number };
  opencode: number;
  unknownEngine: number;
  /** Running ones first (by priority, then longest running), then the unconfirmed. */
  agents: ActiveAgent[];
  /** Confirmed live Actions runs and fresh local heartbeat jobs. */
  running: number;
  target: number;
  /** The running ones by lane. */
  lanes: Record<Lane, number>;
  /** Unconfirmed heartbeat workers and board claims, excluded from running. */
  unconfirmed: number;
  /** Dispatch runs not started yet (dispatch.yml's live runs not in progress), newest first. */
  queued: { url: string; title: string }[];
  /** The heartbeat's freshness: undefined when it couldn't be read, null when none is published. */
  heartbeat?: HeartbeatState | null;
}

/** A board item claimed by an agent: In Progress, with a Lead or a Run. */
export function isClaimed(item: Item): boolean {
  const umbrella = item.labels.includes("epic") || item.subIssues !== undefined;
  return item.status === IN_PROGRESS && (item.run !== undefined || (item.lead !== undefined && !umbrella));
}

export function laneOf(org: string | undefined): Lane {
  if (org === undefined) return "unknown";
  return isOwnOrg(org) ? "harness" : "upstream";
}

/** The lane of an issue or PR URL no board item describes: its owner's, a tracker issue's unknown. */
function urlLane(url: string): Lane {
  const ref = parseIssueUrl(url);
  if (!ref || repoOf(ref) === TRACKER_REPO.toLowerCase()) return "unknown";
  return laneOf(ref.owner.toLowerCase());
}

const norm = (url: string) => url.toLowerCase();

function refText(url: string | undefined): string | undefined {
  const ref = url ? parseIssueUrl(url) : undefined;
  return ref ? `${ref.owner}/${ref.repo}#${ref.number}` : undefined;
}

/**
 * The board item a worker's item URL names: the item that is that issue
 * or PR, else one whose Branch holds it; a claimed one first, since that
 * is the one the worker is likely working for.
 */
function itemFor(url: string, board: readonly Item[]): Item | undefined {
  const u = norm(url);
  const candidates = [...board.filter((i) => i.url && norm(i.url) === u), ...board.filter((i) => i.branch.some((b) => norm(b) === u))];
  return candidates.find(isClaimed) ?? candidates[0];
}

function byPriorityThenAge(a: ActiveAgent, b: ActiveAgent): number {
  return priorityIndex(a.priority) - priorityIndex(b.priority) || (a.since ?? "￿").localeCompare(b.since ?? "￿") || a.name.localeCompare(b.name);
}

/** Repository plus numeric run id; attempts, query strings and fragments aren't new agents. */
export function actionRunIdentity(url: string | undefined): string | undefined {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/actions\/runs\/([1-9]\d*)(?:\/attempts\/[1-9]\d*)?\/?(?:[?#].*)?$/i.exec(url ?? "");
  return match ? `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}/${match[3]}` : undefined;
}

/**
 * Merge by concrete run identity, not by issue: local and remote jobs may
 * share an item. Agent runs are both agent.yml's (`runs`) and the
 * tracker's dispatch.yml's in-progress list (`dispatch`); its queued ones
 * haven't started an agent.
 */
export function activeAgents(board: readonly Item[], hb: Heartbeat | null | undefined, now: number, target: number = AGENT_TARGET, execution: { runs?: RunsData | undefined; dispatch?: DispatchData | undefined; sources?: Sources } = {}): AgentSummary {
  const stopped = hb?.loopState === "stopped";
  // A stopped coordinator isn't stale to the ops view, but nothing
  // vouches for the workers it last listed any more either.
  const hbSource = execution.sources?.heartbeat?.state;
  const hbStale = hb ? isStale(hb, now) || stopped || hbSource === "cached" || hbSource === "unavailable" : false;
  const runs = execution.runs;
  const runSource = execution.sources?.runs?.state;
  const runsFresh = runs?.state === "ok" && runSource !== "cached" && runSource !== "unavailable" && now >= runs.at && now - runs.at <= 2 * RUNS_POLL_MS;
  const used = new Set<string>();
  const agents: ActiveAgent[] = [];
  const remote = new Map<string, ActiveAgent>();
  // Loaders already deduplicate run ids; also tolerate duplicate snapshot rows.
  const records = new Map<string, RunsData["runs"][number]>();
  for (const run of runs?.runs ?? []) {
    const key = actionRunIdentity(run.url);
    if (!key) continue;
    const previous = records.get(key);
    const updated = (run.updatedAt ?? run.createdAt).localeCompare(previous?.updatedAt ?? previous?.createdAt ?? "");
    if (!previous || run.attempt > previous.attempt || (run.attempt === previous.attempt && (updated > 0 || (updated === 0 && previous.active && !run.active)))) records.set(key, run);
  }
  const context = (a: ActiveAgent, item: Item): void => {
    if (item.url) a.itemUrl = item.url;
    const ref = refText(item.url);
    if (ref) a.itemRef = ref;
    a.title = item.title;
    if (item.priority) a.priority = item.priority;
    if (item.lead) a.lead = item.lead;
    if (item.engine) a.engine ??= item.engine;
    a.lane = laneOf(itemOrg(item));
  };
  for (const [key, run] of records) {
    if (!run.active) continue;
    const a: ActiveAgent = { name: run.title, title: run.title, status: run.status, since: run.startedAt, source: "actions", location: "remote", lane: "unknown", runUrl: run.url, stale: !runsFresh };
    for (const item of board) if (actionRunIdentity(item.run) === key) {
      used.add(item.nodeId);
      if (!a.itemUrl) context(a, item);
    }
    remote.set(key, a);
    agents.push(a);
  }
  const dispatch = execution.dispatch;
  const dispatchFresh = dispatch?.state === "ok" && now >= dispatch.at && now - dispatch.at <= 2 * DISPATCH_POLL_MS;
  for (const run of dispatch?.live ?? []) {
    const key = actionRunIdentity(run.url);
    if (!key || remote.has(key) || run.status !== "in_progress") continue;
    const t = run.target;
    const a: ActiveAgent = { name: run.title, title: run.title, status: run.step?.name ?? run.status, since: run.startedAt, source: "actions", location: "remote", lane: "unknown", runUrl: run.url, stale: !dispatchFresh };
    const url = t ? `https://github.com/${t.owner}/${t.repo}/issues/${t.number}` : undefined;
    const item = board.find((i) => actionRunIdentity(i.run) === key) ?? (url ? itemFor(url, board) : undefined);
    if (item) {
      used.add(item.nodeId);
      context(a, item);
    } else if (url) {
      a.itemUrl = url;
      a.itemRef = refText(url)!;
      a.lane = urlLane(url);
    }
    remote.set(key, a);
    agents.push(a);
  }
  const workersSeen = new Set<string>();
  for (const w of hb?.workers ?? []) {
    if (workersSeen.has(w.name)) continue;
    workersSeen.add(w.name);
    const item = itemFor(w.itemUrl, board);
    const claimed = item !== undefined && isClaimed(item);
    if (claimed) used.add(item.nodeId);
    // A Run link alone must never reclassify a local heartbeat job as remote.
    const key = w.devspace ? actionRunIdentity(item?.run) : undefined;
    const seen = key ? remote.get(key) : undefined;
    if (seen) {
      if (w.devspace) seen.devspace ??= w.devspace;
      if (!hbStale && w.engine) seen.engine ??= w.engine;
      continue;
    }
    const a: ActiveAgent = {
      name: w.name,
      itemUrl: w.itemUrl,
      itemRef: w.itemRef,
      status: w.status,
      since: w.startedAt,
      source: claimed ? "both" : "heartbeat",
      location: w.devspace ? "remote" : "local",
      lane: item ? laneOf(itemOrg(item)) : urlLane(w.itemUrl),
      // Remote heartbeat sightings need confirmation by Actions, not a board URL.
      stale: hbStale || !!w.devspace,
    };
    if (item) {
      a.title = item.title;
      if (item.priority) a.priority = item.priority;
      if (claimed && item.lead) a.lead = item.lead;
      if (claimed && item.run) a.runUrl = item.run;
    }
    if (w.devspace) a.devspace = w.devspace;
    const engine = w.engine ?? item?.engine;
    if (engine) a.engine = engine;
    if (key) remote.set(key, a);
    agents.push(a);
  }
  for (const item of board) {
    if (!isClaimed(item) || used.has(item.nodeId)) continue;
    const a: ActiveAgent = {
      name: item.lead ?? "agent run",
      title: item.title,
      status: item.run ? "run" : "claimed",
      source: "board",
      location: item.run ? "remote" : "local",
      lane: laneOf(itemOrg(item)),
      stale: true,
    };
    if (item.url) a.itemUrl = item.url;
    const ref = refText(item.url);
    if (ref) a.itemRef = ref;
    if (item.priority) a.priority = item.priority;
    const since = item.movedAt ?? item.updatedAt;
    if (since) a.since = since;
    if (item.lead) a.lead = item.lead;
    if (item.run) a.runUrl = item.run;
    if (item.engine) a.engine = item.engine;
    const key = actionRunIdentity(item.run);
    if (key && remote.has(key)) continue;
    if (key) remote.set(key, a);
    agents.push(a);
  }
  const live = agents.filter((a) => !a.stale).sort(byPriorityThenAge);
  const unconfirmed = agents.filter((a) => a.stale).sort(byPriorityThenAge);
  const lanes: Record<Lane, number> = { harness: 0, upstream: 0, unknown: 0 };
  for (const a of live) lanes[a.lane]++;
  const locations = { remote: 0, local: 0 };
  for (const a of live) locations[a.location]++;
  const summary: AgentSummary = { executionKnown: hb !== undefined || runs?.state === "ok" || dispatch?.state === "ok", agents: [...live, ...unconfirmed], running: live.length, target, lanes, unconfirmed: unconfirmed.length, queued: (dispatch?.live ?? []).filter((r) => r.status !== "in_progress").map((r) => ({ url: r.url, title: r.title })), locations, opencode: live.filter((a) => a.engine === "opencode").length, unknownEngine: live.filter((a) => !a.engine).length };
  if (hb === null) summary.heartbeat = null;
  else if (hb) summary.heartbeat = { updatedAt: hb.updatedAt, loopState: hb.loopState, stale: isStale(hb, now) || hbSource === "cached" || hbSource === "unavailable", stopped };
  return summary;
}
