// The summary atop the Usage view: one line each for the agents
// running, the runs queued, the scheduler and the pools, each linking to
// the section with the detail. It reads nothing of its own: it is made
// from what the sections already read, so it adds no GitHub request and
// follows their refresh rules (none while the tab is hidden). The
// scheduler's line takes the pass from its published holds, and the broker
// probe's run from the controller, which only the ops detail reads; until
// it is opened the line says so. Each line says what its state means (new
// work held until when and why, agents not confirmed running) rather than
// a bare word to be looked up.

import { h, link } from "../dom.ts";
import type { ActiveAgent } from "./agents.ts";
import type { ControllerData } from "./controller.ts";
import { monthGone, poolLabel, poolNames, poolStateWords, poolWords } from "./opsview.ts";
import type { PageState } from "./state.ts";
import { agoLabel, time } from "./view.ts";

/** Agents linked by name on the line; the rest are counted. */
const AGENTS_LINKED = 4;
/** Statuses of a run that hasn't started. */
const QUEUED = new Set(["queued", "waiting", "pending", "requested"]);

export interface SummaryTargets {
  /** Open (if need be) and scroll to a section of the page. */
  show(id: string): void;
}

/** A link to a part of the page that opens it, without touching the hash (which is the route). */
function jump(id: string, text: string, targets: SummaryTargets): HTMLElement {
  const a = h("a", { href: `#${id}`, class: "sum-jump" }, text);
  a.addEventListener("click", (event) => {
    event.preventDefault();
    targets.show(id);
  });
  return a;
}

/** The pool an agent draws on, as far as its source says: its engine, else where it runs. */
const poolOf = (a: ActiveAgent) => a.engine ?? (a.location === "remote" ? "Actions" : "local");

function agentsLine(state: PageState, targets: SummaryTargets): HTMLElement {
  const s = state.agents;
  const running = s.agents.filter((a) => !a.stale);
  const line = h("li", {}, jump("sec-agents", "Agents", targets), " ");
  if (!s.executionKnown) return (line.append("not read yet"), line);
  const by = new Map<string, number>();
  for (const a of running) by.set(poolOf(a), (by.get(poolOf(a)) ?? 0) + 1);
  // Unconfirmed: a board claim or a sighting with no current run or
  // heartbeat behind it, so not counted as running (see agents.ts).
  line.append(`${running.length} running`, by.size ? ` (${[...by].map(([pool, n]) => `${pool} ${n}`).join(", ")})` : "", s.unconfirmed ? ` · ${s.unconfirmed} unconfirmed: claimed or last seen, not confirmed running` : "");
  running.slice(0, AGENTS_LINKED).forEach((a) => {
    line.append(" · ", link(a.runUrl ?? a.itemUrl, a.itemRef ?? a.name));
  });
  if (running.length > AGENTS_LINKED) line.append(` · +${running.length - AGENTS_LINKED}`);
  return line;
}

function queuedLine(state: PageState, targets: SummaryTargets): HTMLElement {
  const runs = state.runs?.runs;
  // agent.yml's runs that haven't started, and dispatch.yml's.
  const queued = [...runs?.filter((r) => r.active && QUEUED.has(r.status)) ?? [], ...state.agents.queued];
  return h("li", {}, jump("live-runs", "Queued", targets), " ", runs ? `${queued.length} run${queued.length === 1 ? "" : "s"}` : "not read yet", ...queued.slice(0, AGENTS_LINKED).flatMap((r) => [" · ", link(r.url, r.title)]));
}

/**
 * What the board pass did and its WIP, as it published them with its
 * holds, and the broker probe's last run (it has only a schedule, so
 * every run is the default branch's). The probe's job runs only
 * while tracker's BROKER_OUTAGE is apply, so otherwise it reads "skipped".
 */
function schedulerLine(state: PageState, controller: ControllerData | undefined, now: number, targets: SummaryTargets): HTMLElement {
  const line = h("li", {}, jump("ops", "Scheduler", targets), " ");
  const holds = state.holds;
  const p = holds?.pass;
  const of = (n: number | null, what: string) => (n === null ? "" : ` · ${n} ${what}`);
  line.append(
    !holds ? "pass not read" : !p ? "pass not published" : `${p.mode === "preview" ? `previewing (dry run): would start ${p.started}` : `${p.mode}: started ${p.started}`}${of(p.candidates, "candidates")}${of(p.liveEpics, "live epics")}`,
    holds ? (holds.wip ? ` · WIP ${holds.wip.inFlight ?? "?"}/${holds.wip.limit}` : " · WIP not published") : "",
    holds ? h("span", {}, " · as of ", agoLabel(holds.at, now)) : "",
  );
  const probe = controller?.pieces.find((x) => x.piece.label === "Broker probe");
  line.append(" · broker ", ...(!controller ? ["not read: it is read when the ops detail is opened"] : !probe?.last ? ["no pass"] : [`${probe.last.conclusion === "success" ? "ok" : probe.last.conclusion ?? "ended"} `, agoLabel(probe.last.at, now, `finished ${time(probe.last.at)}`)]));
  return line;
}

function resourcesLines(state: PageState, now: number, targets: SummaryTargets): HTMLElement[] {
  const usage = state.usage?.state === "ok" ? state.usage.usage : undefined;
  if (!usage) return [h("li", {}, jump("weekly-usage", "Resources", targets), !state.usage ? " not read yet" : state.usage.state === "unreadable" ? " unreadable with this token" : " not published")];
  const lines = poolNames(usage.pools).flatMap((name) => {
    const pool = usage.pools?.[name];
    if (!pool) return [];
    // What the pass decided on it: held and why, else where it stops dispatching.
    const { held, room } = poolStateWords(pool, now);
    return [h("li", pool.hold ? { class: "hot" } : {}, jump("weekly-usage", poolLabel(name), targets), ` ${pool.reading ? poolWords(pool.reading, pool.limitPercent).short : "no reading"}${room}${held}`)];
  });
  const m = usage.mistral;
  if (m?.allowance) lines.push(h("li", {}, jump("weekly-usage", "Mistral", targets), ` $${m.allowance.spentUsd.toFixed(2)}${m.allowance.estimated ? " est." : ""} of $${m.allowance.limitUsd} this month`));
  else if (m?.budget) lines.push(h("li", {}, jump("weekly-usage", "Mistral", targets), ` spend not published · $${m.budget.limitUsd} a month, ${Math.round(monthGone(m.budget, now))}% gone`));
  return lines;
}

/** The summary's lines; a short list a phone shows without scrolling. */
export function summaryView(state: PageState, controller: ControllerData | undefined, now: number, targets: SummaryTargets): HTMLElement {
  return h(
    "section",
    { class: "dashboard-summary", "aria-label": "Summary" },
    h("ul", {}, agentsLine(state, targets), queuedLine(state, targets), schedulerLine(state, controller, now, targets), ...resourcesLines(state, now, targets)),
  );
}
