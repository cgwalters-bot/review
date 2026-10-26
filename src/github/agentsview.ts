// The "Agents" section's top: the agents working now against the target
// (agents.ts), each with its item, status and age, and where it runs
// (a remote run links to it). The ops detail (devspaces, runs, the
// coordinator) sits below it, see opsview.ts.

import { h, link } from "../dom.ts";
import { type Active, type ActiveAgent, activeAgents, type AgentSummary, type Lane } from "./agents.ts";
import { HEARTBEAT_ISSUE, TRACKER_REPO } from "./config.ts";
import { workerStatus } from "./opsview.ts";
import { age, ageLabel, agoLabel, pill, time } from "./view.ts";

/** The class of the agents list's rows, which the section shows a few of before "View all". */
export const AGENT_ROW_CLASS = "as-agent";

const LANE_LABEL: Record<Lane, string> = { harness: "harness", upstream: "upstream", unknown: "no org" };
const SOURCE_TITLE: Record<ActiveAgent["source"], string> = {
  heartbeat: "listed by the coordinator's heartbeat",
  board: "board claim only; execution is unconfirmed and excluded from the running count",
  both: "listed by the heartbeat and In Progress on the board",
  actions: "Actions workflow run; stale sightings are excluded from the running count",
};

function agentRow(a: ActiveAgent, now: number): HTMLElement {
  const sinceTitle = a.source === "board" ? `its board item last changed ${time(a.since)}` : `started ${time(a.since)}`;
  return h(
    "li",
    { class: `${AGENT_ROW_CLASS}${a.stale ? " stale" : ""}`, title: SOURCE_TITLE[a.source] },
    workerStatus(a.status),
    h("span", { class: "agent-engine" }, `${a.location} · ${a.engine ?? "engine unknown"}`),
    h(
      "span",
      { class: "as-who" },
      a.priority ? pill(a.priority) : null,
      a.priority ? " " : null,
      h("strong", {}, a.name),
      " ",
      a.itemUrl ? link(a.itemUrl, a.itemRef ?? a.itemUrl) : null,
      a.title ? h("span", { class: "as-title" }, ` ${a.title}`) : null,
    ),
    a.runUrl ? link(a.runUrl, "run ↗") : null,
    ageLabel(a.since, now, sinceTitle),
  );
}

/** The heading line's heartbeat part: its age, said plainly when stale or missing. */
function heartbeatText(s: AgentSummary, now: number, why: string): { text: string; cls: string; title: string } {
  if (s.heartbeat === undefined) return { text: "heartbeat unread", cls: "warn", title: `The coordinator's heartbeat couldn't be read; its local workers are missing.${why}` };
  if (s.heartbeat === null) return { text: "no heartbeat", cls: "warn", title: `Nothing published to ${TRACKER_REPO}#${HEARTBEAT_ISSUE}: local workers can't be seen.` };
  const ago = age(s.heartbeat.updatedAt, now);
  const text = `heartbeat ${ago === "now" ? "just now" : `${ago} old`}`;
  if (s.heartbeat.stopped) {
    return { text: `coordinator stopped · ${text}`, cls: "warn", title: `The coordinator said it stopped at ${time(s.heartbeat.updatedAt)}, so its workers are unconfirmed.` };
  }
  return s.heartbeat.stale
    ? { text, cls: "warn", title: `The coordinator last published at ${time(s.heartbeat.updatedAt)}: it may have stopped, so its workers are unconfirmed.` }
    : { text, cls: "", title: `The coordinator is ${s.heartbeat.loopState}; published at ${time(s.heartbeat.updatedAt)}.` };
}

/** What the section's header says: running against the target, or why that is unknown. */
export function agentsSummary(data: Active | undefined, now: number, summary?: AgentSummary): { count: string; title: string; under: boolean } {
  if (!data && !summary?.executionKnown) return { count: "…", title: "reading Actions and the heartbeat", under: false };
  if (!summary?.executionKnown && !data?.board && data?.local === undefined) return { count: "?", title: data?.warnings.join("\n") || "couldn't read Actions or the heartbeat", under: false };
  const s = summary ?? activeAgents(data?.board ?? [], data?.local, now, data?.holds?.wip?.limit);
  if (s.target === undefined) return { count: String(s.running), title: `${s.running} working; the pass's WIP limit is not published`, under: false };
  return { count: `${s.running}/${s.target}`, title: `${s.running} working, the pass's WIP limit ${s.target}`, under: s.running < s.target };
}

/**
 * The section's top: the count against the target, split by lane, the
 * heartbeat's age, then a row per agent.
 */
export function agentsBody(data: Active | undefined, now: number, summary?: AgentSummary): HTMLElement {
  const sec = h("div", { class: "agents-body", "aria-label": "Active agents" });
  if (!summary?.executionKnown && !data?.board && data?.local === undefined) {
    sec.append(h("p", { class: "note", title: data?.warnings.join("\n") ?? "" }, data ? "Couldn't read the board or the heartbeat." : "Reading…"));
    return sec;
  }
  const s = summary ?? activeAgents(data?.board ?? [], data?.local, now, data?.holds?.wip?.limit);
  const why = data?.warnings.length ? `\n${data.warnings.join("\n")}` : "";
  const hb = heartbeatText(s, now, why);
  const lanes = (["harness", "upstream", "unknown"] as const).filter((l) => s.lanes[l] > 0 || l !== "unknown").map((l) => `${LANE_LABEL[l]} ${s.lanes[l]}`);
  sec.append(
    h(
      "div",
      { class: "as-head" },
      h("span", { class: "as-lanes" }, `${s.running}${s.target === undefined ? " agents (WIP limit not published)" : `/${s.target} agents`} · remote ${s.locations.remote} · local ${s.locations.local} · OpenCode ${s.running ? Math.round(100 * s.opencode / s.running) : 0}% (${s.opencode}/${s.running})${s.unknownEngine ? ` · ${s.unknownEngine} engine unknown` : ""} · ${lanes.join(" · ")}`),
      s.unconfirmed ? h("span", { class: "as-unconfirmed warn", title: "claims or sightings without current execution evidence" }, `+${s.unconfirmed} unconfirmed`) : null,
      h("span", { class: `as-hb ${hb.cls}`, title: hb.title }, ...(s.heartbeat ? [s.heartbeat.stopped ? "coordinator stopped · heartbeat " : "heartbeat ", agoLabel(s.heartbeat.updatedAt, now)] : [hb.text])),
      data?.board ? null : h("span", { class: "warn", title: `The board couldn't be read; Actions runs and heartbeat jobs can still be counted.${why}` }, "board unread"),
    ),
  );
  if (s.agents.length) sec.append(h("ul", { class: "as-list" }, ...s.agents.map((a) => agentRow(a, now))));
  else sec.append(h("p", { class: "note" }, "No agent is working right now."));
  return sec;
}
