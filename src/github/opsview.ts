// The ops detail under the Agents section (devspaces, local agents,
// agent runs, active work and the bot's recent activity) and the Usage
// section's body. Times that move (uptime, time left) are marked so
// tickOps can update them in place every second without a re-render.

import { h, link, svg } from "../dom.ts";
import { type IssueRef, type Item, parseIssueUrl } from "./board.ts";
import { AGENT_WORKFLOW, BOT_LOGIN, DEVSPACE_REPO, DEVSPACE_WORKFLOW, HEARTBEAT_ISSUE, HEARTBEAT_STALE_MS, OPS_EVENTS_SHOWN, OPS_WINDOW_HOURS, TRACKER_REPO, USAGE_REPO } from "./config.ts";
import { PRESET_LABEL, PRESET_TITLE } from "./filter.ts";
import { type Heartbeat, isStale, type LocalWorker } from "./heartbeat.ts";
import {
  type AgentData,
  type AgentRun,
  type BotEvent,
  type Devspace,
  type DevspaceData,
  history,
  type Ops,
  type Outcome,
  type Phase,
  timeLeft,
  workGroups,
  type WorkGroup,
} from "./ops.ts";
import { type MistralUsage, type Tokens, tokenTotal, type UsageData, type UsagePool, type UsageWindow } from "./usage.ts";
import { age, pill, time } from "./view.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Classes and attributes tickOps finds its live times by. */
const TICK_SINCE = "tick-since";
const TICK_LEFT = "tick-left";
const TICK_BAR = "tick-bar";
const ATTR_T = "data-t";
const ATTR_MAX = "data-max";
const ATTR_TOTAL = "data-total";

/** "4m 05s" under an hour (with seconds, if asked), else "3h 07m". */
export function duration(ms: number, seconds = true): string {
  const s = Math.max(0, Math.floor(ms / SECOND));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hh > 0) return `${hh}h ${pad(mm)}m`;
  if (!seconds) return mm > 0 ? `${mm}m` : "<1m";
  return `${mm}m ${pad(s % 60)}s`;
}

/** The text of a time-left cell; "≤" when only the longest duration bounds it. */
export function leftText(ms: number, max: boolean): string {
  if (ms <= 0) return max ? "ending soon at the latest" : "ending now";
  return `${max ? "≤ " : ""}${duration(ms)} left`;
}

/** A token count: 950, 12k, 4.2M, 1.25B. */
export function tokensText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** Core-hours, to one decimal below 10. */
export function coreHoursText(n: number): string {
  return n < 10 ? n.toFixed(1) : String(Math.round(n));
}

function clock(iso: string | undefined): string {
  const d = new Date(iso ?? "");
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const PHASE_LABEL: Record<Phase, string> = { queued: "queued", starting: "starting", ready: "up", ending: "ending", done: "done" };
const PHASE_TITLE: Record<Phase, string> = {
  queued: "waiting for a runner",
  starting: "the runner is setting up; SSH isn't ready yet",
  ready: "reachable over SSH",
  ending: "its time is up or it was stopped; the runner is tearing down",
  done: "finished",
};
const OUTCOME_LABEL: Record<Outcome, string> = { stopped: "stopped", expired: "expired", failed: "failed", other: "other" };
const OUTCOME_TITLE: Record<Outcome, string> = {
  stopped: "cancelled: how bot-devspace stop ends a devspace, the normal case",
  expired: "ran out its duration",
  failed: "the run failed",
  other: "ended some other way",
};

/** A status dot with its word: never color alone. */
function status(cls: string, label: string, title: string): HTMLElement {
  return h("span", { class: `st ${cls}`, title }, h("span", { class: "dot", "aria-hidden": "true" }), label);
}

function sparkline(buckets: readonly number[], now: number): SVGSVGElement {
  const BAR = 4;
  const GAP = 1;
  const H = 28;
  const max = Math.max(...buckets, 0);
  const width = buckets.length * (BAR + GAP) - GAP;
  const el = svg("svg", { class: "spark", viewBox: `0 0 ${width} ${H}`, width: String(width * 1.5), height: String(H), role: "img", "aria-label": `core-hours per hour over the last ${buckets.length} hours` });
  buckets.forEach((v, i) => {
    const hgt = max > 0 && v > 0 ? Math.max(2, (v / max) * H) : 1;
    const from = new Date(now - (buckets.length - i) * HOUR);
    const label = `${from.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${coreHoursText(v)} core-h`;
    el.append(svg("rect", { x: String(i * (BAR + GAP)), y: String(H - hgt), width: String(BAR), height: String(hgt), rx: "1", class: v > 0 ? "on" : "off" }, svg("title", {}, label)));
  });
  return el;
}

function tile(value: string, label: string, ...more: (Node | string | null)[]): HTMLElement {
  return h("div", { class: "tile" }, h("div", { class: "big" }, value), h("div", { class: "label" }, label), ...more);
}

function tiles(data: DevspaceData | undefined, now: number): HTMLElement | null {
  if (!data) return null;
  const live = data.devspaces.filter((d) => d.phase !== "done");
  const cores = live.reduce((n, d) => n + (d.cores ?? 0), 0);
  const hist = history(data.devspaces, now, OPS_WINDOW_HOURS);
  const o = hist.outcomes;
  const outcomes = [
    o.stopped ? `${o.stopped} stopped` : "",
    o.expired ? `${o.expired} expired` : "",
    o.other ? `${o.other} other` : "",
  ].filter(Boolean);
  return h(
    "div",
    { class: "tiles" },
    tile(String(live.length), live.length === 1 ? "devspace running" : "devspaces running", h("div", { class: "sub" }, cores ? `${cores} cores` : "no cores in use")),
    tile(
      coreHoursText(hist.coreHours),
      `core-hours, last ${OPS_WINDOW_HOURS}h`,
      sparkline(hist.buckets, now),
      hist.unsized ? h("div", { class: "sub" }, `${hist.unsized} of unknown size not counted`) : null,
    ),
    tile(
      `${hist.count}${data.partial ? "+" : ""}`,
      `devspaces started, last ${OPS_WINDOW_HOURS}h`,
      h(
        "div",
        { class: "sub" },
        o.failed ? h("span", { class: "bad" }, `${o.failed} failed`) : "none failed",
        outcomes.length ? ` · ${outcomes.join(" · ")}` : "",
      ),
    ),
  );
}

function section(title: string, ...children: (Node | string | null)[]): HTMLElement {
  return h("section", { class: "ops-sec" }, h("h2", {}, title), ...children);
}

function liveRow(d: Devspace, now: number): HTMLElement {
  const left = timeLeft(d, now);
  const since = Date.parse(d.startedAt ?? d.createdAt);
  const leftCell = left
    ? h(
        "span",
        { class: "left", title: left.bound === "max" ? "This run doesn't say its duration; this counts down the longest one devspace.yml allows." : `${d.durationMin} minutes asked for` },
        h("span", { class: TICK_LEFT, [ATTR_T]: String(now + left.ms), [ATTR_MAX]: left.bound === "max" ? "1" : "0" }, leftText(left.ms, left.bound === "max")),
        svg(
          "svg",
          { class: "bar", viewBox: "0 0 100 4", preserveAspectRatio: "none", "aria-hidden": "true" },
          svg("rect", { class: "track", x: "0", y: "0", width: "100", height: "4", rx: "2" }),
          svg("rect", { class: TICK_BAR, x: "0", y: "0", width: String((left.ms / left.totalMs) * 100), height: "4", rx: "2", [ATTR_T]: String(now + left.ms), [ATTR_TOTAL]: String(left.totalMs) }),
        ),
      )
    : h("span", { class: "left" }, d.phase === "queued" ? "waiting for a runner" : "");
  return h(
    "div",
    { class: `ds-row p-${d.phase}` },
    status(`s-${d.phase}`, PHASE_LABEL[d.phase], PHASE_TITLE[d.phase]),
    h("div", { class: "who" }, h("strong", {}, d.name), h("code", { class: "host" }, d.host)),
    h("span", { class: "cores", title: "runner cores" }, d.cores ? `${d.cores}c` : "?c"),
    h(
      "span",
      { class: "up", title: `started ${time(d.startedAt ?? d.createdAt)}` },
      `${clock(d.startedAt ?? d.createdAt)} · up `,
      h("span", { class: TICK_SINCE, [ATTR_T]: String(since) }, duration(now - since)),
    ),
    leftCell,
    link(d.url, "run ↗"),
  );
}

function pastRow(d: Devspace, now: number): HTMLElement {
  const outcome = d.outcome ?? "other";
  const start = Date.parse(d.startedAt ?? "");
  const end = Date.parse(d.endedAt ?? "");
  const ran = Number.isNaN(start) || Number.isNaN(end) ? "" : duration(end - start, false);
  return h(
    "li",
    { class: "past" },
    status(`o-${outcome}`, OUTCOME_LABEL[outcome], `${OUTCOME_TITLE[outcome]}${d.conclusion ? ` (${d.conclusion})` : ""}`),
    h("span", { class: "name" }, d.name),
    h("span", { class: "cores" }, d.cores ? `${d.cores}c` : "?c"),
    h("span", { class: "ran", title: "time on the runner" }, ran),
    h("span", { class: "age", title: `ended ${time(d.endedAt)}` }, `${age(d.endedAt ?? d.createdAt, now)} ago`),
    link(d.url, "run ↗"),
  );
}

/** A section with no data: its read failed, or, in a cached copy, it isn't cached. */
function unavailable(fromCache: boolean): string {
  return fromCache ? "Not cached; loading…" : "Not available; see the warning above.";
}

function devspacesSection(data: DevspaceData | undefined, now: number, fromCache = false): HTMLElement {
  const sec = section("Devspaces");
  if (!data) {
    sec.append(h("p", { class: "note" }, unavailable(fromCache)));
    return sec;
  }
  const live = data.devspaces.filter((d) => d.phase !== "done");
  if (live.length === 0) sec.append(h("p", { class: "note" }, "No devspace is running."));
  for (const d of live) sec.append(liveRow(d, now));
  const past = data.devspaces.filter((d) => d.phase === "done");
  if (past.length) {
    sec.append(
      h(
        "details",
        { class: "history" },
        h("summary", {}, `Finished in the last ${OPS_WINDOW_HOURS}h (${past.length}${data.partial ? ", maybe more" : ""})`),
        h("ul", { class: "past-list" }, ...past.map((d) => pastRow(d, now))),
      ),
    );
  }
  sec.append(h("p", { class: "fine" }, `Runs of ${DEVSPACE_REPO}'s ${DEVSPACE_WORKFLOW}; hosts are on the tailnet. Cancelled is how bot-devspace stop ends one, so it counts as stopped, not failed.`));
  return sec;
}

function agentRow(r: AgentRun, now: number): HTMLElement {
  const st = r.active
    ? status(`s-${r.status === "in_progress" ? "ready" : "queued"}`, r.status === "in_progress" ? "running" : r.status.replace(/_/g, " "), r.status)
    : status(`o-${r.outcome ?? "other"}`, r.conclusion ?? "done", r.conclusion ?? "");
  return h(
    "li",
    { class: "past" },
    st,
    h("span", { class: "name" }, link(r.url, r.title)),
    h("span", { class: "tag" }, r.actor ?? ""),
    h("span", { class: "age", title: `started ${time(r.startedAt)}` }, `${age(r.startedAt, now)} ago`),
  );
}

function agentsSection(data: AgentData | undefined, now: number, fromCache = false): HTMLElement {
  const sec = section("Agent runs");
  if (!data) sec.append(h("p", { class: "note" }, unavailable(fromCache)));
  else if (!data.deployed) {
    sec.append(h("p", { class: "note" }, `Not deployed yet: ${DEVSPACE_REPO} has no ${AGENT_WORKFLOW} on its default branch. Runs show here once it lands.`));
  } else if (data.runs.length === 0) sec.append(h("p", { class: "note" }, "No agent runs yet."));
  else sec.append(h("ul", { class: "past-list" }, ...data.runs.map((r) => agentRow(r, now))));
  return sec;
}

/** A local worker's status as a dot: busy, starting or waiting. */
export function workerStatus(s: string): HTMLElement {
  const cls = s === "starting" ? "s-starting" : s === "waiting" ? "s-queued" : /^(working|testing|reviewing|landing)$/.test(s) ? "s-ready" : "s-unknown";
  return status(cls, s, `the worker's last reported status: ${s}`);
}

function localRow(w: LocalWorker, live: ReadonlySet<string>, now: number): HTMLElement {
  const since = Date.parse(w.startedAt);
  return h(
    "li",
    { class: "lw" },
    workerStatus(w.status),
    h("span", { class: "name" }, h("strong", {}, w.name), " ", link(w.itemUrl, w.itemRef)),
    h(
      "span",
      { class: "ds", title: w.devspace ? (live.has(w.devspace) ? "its devspace, running (above)" : "its devspace, not among the running ones") : "no devspace" },
      w.devspace ? `⌁ ${w.devspace}` : "",
    ),
    h("span", { class: "up", title: `started ${time(w.startedAt)}` }, h("span", { class: TICK_SINCE, [ATTR_T]: String(since) }, duration(now - since))),
  );
}

const LOOP_TITLE: Record<string, string> = {
  polling: "reading notifications, the inbox and the watch sweep",
  working: "acting on what it found: dispatching, reviewing, promoting",
  sleeping: "waiting for its next poll, or for a worker to finish",
  stopped: "the session ended",
};

function localSection(hb: Heartbeat | null | undefined, devspaces: DevspaceData | undefined, now: number, fromCache = false): HTMLElement {
  const sec = section("Local agents");
  if (hb === undefined) {
    sec.append(h("p", { class: "note" }, unavailable(fromCache)));
    return sec;
  }
  if (hb === null) {
    sec.append(h("p", { class: "note" }, `No heartbeat published yet. The coordinator's workers run on its own machine, which this page can't see; they show here once it publishes them to ${TRACKER_REPO}#${HEARTBEAT_ISSUE}.`));
    return sec;
  }
  const stale = isStale(hb, now);
  const wake = hb.nextWakeAt && hb.loopState === "sleeping" && Date.parse(hb.nextWakeAt) > now ? ` · wakes at ${clock(hb.nextWakeAt)}` : "";
  sec.append(
    h(
      "p",
      { class: "coord" },
      "Coordinator ",
      h("code", { title: hb.session }, hb.session.slice(0, 8)),
      " ",
      h("span", { class: "loop", title: LOOP_TITLE[hb.loopState] ?? "" }, hb.loopState),
      ` · heartbeat ${age(hb.updatedAt, now)} ago${wake} · `,
      hb.commentUrl ? link(hb.commentUrl, "source ↗") : `${TRACKER_REPO}#${HEARTBEAT_ISSUE}`,
    ),
  );
  if (stale) {
    sec.append(h("p", { class: "warn" }, `Stale: no heartbeat since ${time(hb.updatedAt)} (${age(hb.updatedAt, now)} ago). The coordinator's session may have ended or be stuck, so this list may be out of date.`));
  }
  if (hb.workers.length === 0) sec.append(h("p", { class: "note" }, hb.loopState === "stopped" ? "The coordinator stopped." : "No local workers running."));
  else {
    const live = new Set((devspaces?.devspaces ?? []).filter((d) => d.phase !== "done").map((d) => d.name));
    sec.append(h("ul", { class: `past-list${stale ? " stale" : ""}` }, ...hb.workers.map((w) => localRow(w, live, now))));
  }
  if (hb.skipped) sec.append(h("p", { class: "fine" }, `${hb.skipped} malformed worker entr${hb.skipped === 1 ? "y" : "ies"} not shown.`));
  return sec;
}

const WINDOW_LABEL: Record<string, string> = { five_hour: "5-hour", seven_day: "7-day" };
/** Percent used from which a window's bar turns amber, then red. */
const PCT_WARN = 75;
const PCT_CRIT = 90;

const tokensTitle = (t: Tokens) =>
  `${tokensText(t.input)} input, ${tokensText(t.output)} output, ${tokensText(t.cacheRead)} cache read, ${tokensText(t.cacheWrite)} cache write`;

/** A reset time: the clock time, with the weekday if it isn't within a day. */
function resetText(iso: string, now: number): string {
  const t = Date.parse(iso);
  const d = new Date(t);
  const at = t - now < 20 * HOUR ? clock(iso) : d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return t > now ? `resets ${at}, in ${duration(t - now, false)}` : `reset at ${at}; the percent is from before`;
}

function windowRow(w: UsageWindow, now: number): HTMLElement {
  const label = WINDOW_LABEL[w.kind] ?? w.kind.replace(/_/g, " ");
  const tokens = h("span", { class: "tok", title: `since ${time(w.since)}: ${tokensTitle(w.tokens)}, in ${w.requests} requests` }, `${tokensText(tokenTotal(w.tokens))} tokens · ${tokensText(w.tokens.output)} out`);
  if (w.usedPercent === undefined || !w.resetsAt) {
    return h(
      "div",
      { class: "uw" },
      h("span", { class: "wl" }, label),
      h("span", { class: "pct unknown", title: "The status line hasn't reported this window; see bot-heartbeat statusline." }, "—"),
      h("span", { class: "reset" }, `since ${clock(w.since)}`),
      tokens,
    );
  }
  const pct = w.usedPercent;
  const level = pct >= PCT_CRIT ? "crit" : pct >= PCT_WARN ? "warn" : "ok";
  const past = Date.parse(w.resetsAt) <= now;
  return h(
    "div",
    { class: `uw u-${level}${past ? " past-reset" : ""}` },
    h("span", { class: "wl" }, label),
    h(
      "span",
      { class: "pct" },
      h("span", { class: "num" }, `${pct % 1 ? pct.toFixed(1) : String(pct)}%`),
      svg(
        "svg",
        { class: "bar", viewBox: "0 0 100 6", preserveAspectRatio: "none", role: "img", "aria-label": `${label} window: ${pct}% used` },
        svg("rect", { class: "track", x: "0", y: "0", width: "100", height: "6", rx: "3" }),
        svg("rect", { class: "fill", x: "0", y: "0", width: String(Math.min(100, pct)), height: "6", rx: "3" }),
      ),
    ),
    h("span", { class: "reset", title: time(w.resetsAt) }, resetText(w.resetsAt, now)),
    tokens,
  );
}

interface Consumer {
  label: Node | string;
  tokens: Tokens;
}

/** The subscription pools of bot-usage/v1, in the order shown. */
const POOLS = [["claude", "Claude"], ["openai", "OpenAI"]] as const;
/** Names a pool's expander, so a redraw can keep it open. */
export const POOL_ATTR = "data-pool";
/** The pool bar's box: a 6-unit track with the pace tick standing 2 units proud of it on each side. */
const POOL_BAR = { width: 100, height: 10, track: 6, tick: 1 };

/**
 * One pool as a compact row: its name, a thin bar of the percent used
 * with a tick where the pace allows, and a short label. The sentence it
 * replaces (exact percents, reset, observation time) is in its expander.
 */
function poolRow(name: string, label: string, pool: UsagePool | undefined, now: number): HTMLElement {
  if (!pool) return h("div", { class: "pool-sum none" }, h("span", { class: "pool-name" }, label), " ", h("span", { class: "pool-label" }, "Weekly usage not reported."));
  const used = pool.usedPercent.toFixed(1);
  const allowed = pool.allowedPercent.toFixed(1);
  const over = pool.usedPercent > pool.allowedPercent;
  const stale = now - Date.parse(pool.observedAt) > HEARTBEAT_STALE_MS;
  const flags = `${over ? " · over pace" : ""}${pool.hold ? " · held" : ""}`;
  const clamp = (n: number, max: number) => String(Math.max(0, Math.min(max, n)));
  const y = String((POOL_BAR.height - POOL_BAR.track) / 2);
  const track = { x: "0", y, height: String(POOL_BAR.track), rx: String(POOL_BAR.track / 2) };
  const bar = svg(
    "svg",
    {
      class: "bar",
      viewBox: `0 0 ${POOL_BAR.width} ${POOL_BAR.height}`,
      preserveAspectRatio: "none",
      role: "progressbar",
      "aria-label": `${label} weekly usage`,
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": clamp(pool.usedPercent, 100),
      "aria-valuetext": `${used}% used, ${allowed}% allowed by pace${flags.replaceAll(" ·", ",")}${stale ? ", stale" : ""}`,
    },
    svg("rect", { class: "track", ...track, width: String(POOL_BAR.width) }),
    svg("rect", { class: "fill", ...track, width: clamp(pool.usedPercent, POOL_BAR.width) }),
    svg("rect", { class: "tick", x: clamp(pool.allowedPercent - POOL_BAR.tick / 2, POOL_BAR.width - POOL_BAR.tick), y: "0", width: String(POOL_BAR.tick), height: String(POOL_BAR.height) }),
  );
  return h(
    "details",
    { class: `pool${pool.hold || over ? " over" : ""}`, [POOL_ATTR]: name },
    h(
      "summary",
      { class: "pool-sum" },
      h("span", { class: "pool-name" }, label),
      " ",
      bar,
      h("span", { class: "pool-label" }, `${Math.round(pool.usedPercent)}% · pace ${Math.round(pool.allowedPercent)}%`, pool.hold ? " · held" : "", stale && h("span", { class: "pool-stale" }, " · stale")),
    ),
    h(
      "div",
      { class: "pool-detail" },
      h("p", {}, `${used}% used / ${allowed}% allowed by pace · ${resetText(pool.resetsAt, now)}`, ` (${time(pool.resetsAt)})`, flags),
      h("p", {}, `Observed ${time(pool.observedAt)}${stale ? " · stale" : ""}.`),
    ),
  );
}

/** Mistral's row: counters only, since the broker started; no bar, as there is no plan window to measure against. */
function mistralRow(m: MistralUsage): HTMLElement {
  const n = (v: number) => v.toLocaleString("en-US");
  return h("div", { class: "pool-sum mistral" }, h("span", { class: "pool-name" }, "Mistral"), " ", h("span", { class: "pool-label" }, `${n(m.requests)} requests · ${n(m.tokens)} tokens since the broker started`));
}

/** Weekly pace uses the subscription's seven days, not the transcript accounting start. */
export function weeklyUsage(data: UsageData | undefined, now: number): HTMLElement {
  const sec = h("div", {}, h("h2", {}, "Weekly subscription usage"));
  if (!data || data.state !== "ok") {
    sec.append(h("p", { class: "note" }, !data ? "Reading usage…" : data.state === "unreadable" ? `Usage unavailable: this token cannot read ${USAGE_REPO}.` : "No usage published yet."));
    return sec;
  }
  const usage = data.usage;
  if (usage.pools) {
    sec.append(
      h(
        "div",
        { class: "pools" },
        ...POOLS.map(([name, label]) => poolRow(name, label, usage.pools?.[name], now)),
        ...(usage.mistral ? [mistralRow(usage.mistral)] : []),
        h("p", { class: "fine" }, usage.updatedAt ? `Published ${time(usage.updatedAt)}. ` : "Publication time unknown. ", usage.commentUrl ? link(usage.commentUrl, "Source ↗") : ""),
      ),
    );
    return sec;
  }
  const weekly = usage.windows.find((w) => w.kind === "seven_day");
  sec.append(h("h3", {}, "Claude"));
  if (weekly) {
    sec.append(windowRow(weekly, now));
    if (weekly.usedPercent !== undefined && weekly.resetsAt && Date.parse(weekly.resetsAt) > now) {
      const pace = Math.max(0, Math.min(100, 100 * (1 - (Date.parse(weekly.resetsAt) - now) / (7 * 24 * HOUR))));
      const delta = weekly.usedPercent - pace;
      sec.append(h("p", { class: "note" }, `${pace.toFixed(1)}% of weekly time elapsed · ${Math.abs(delta).toFixed(1)} percentage points ${delta > 0 ? "ahead of" : "below"} pace.`));
    }
  } else sec.append(h("p", { class: "note" }, "Weekly usage not reported."));
  sec.append(h("h3", {}, "OpenAI"), h("p", { class: "note" }, "Weekly usage not reported in the available bot-usage/v1 data."));
  const observed = usage.observedAt;
  sec.append(h("p", { class: observed && now - Date.parse(observed) <= HEARTBEAT_STALE_MS ? "fine" : "warn" }, observed ? `Observed ${time(observed)}${now - Date.parse(observed) > HEARTBEAT_STALE_MS ? " · stale" : ""}.` : "Observation time unknown; publication does not confirm a fresh subscription reading.", ` Published ${time(usage.updatedAt)}.`, usage.commentUrl ? link(usage.commentUrl, "Source ↗") : ""));
  return sec;
}

function consumerRow(c: Consumer, max: number): HTMLElement {
  const n = tokenTotal(c.tokens);
  return h(
    "li",
    { class: "uc" },
    h("span", { class: "name" }, c.label),
    svg(
      "svg",
      { class: "bar", viewBox: "0 0 100 4", preserveAspectRatio: "none", "aria-hidden": "true" },
      svg("rect", { class: "fill", x: "0", y: "0", width: String(max > 0 ? (n / max) * 100 : 0), height: "4", rx: "2" }),
    ),
    h("span", { class: "tok", title: tokensTitle(c.tokens) }, tokensText(n)),
  );
}

/**
 * The plan's usage: a bar per window, and who spent the most, their
 * items linked from the heartbeat's workers. Null when there is nothing
 * to say (not read yet, or its read failed: see the warnings).
 */
export function usageSection(data: UsageData | undefined, hb: Heartbeat | null | undefined, now: number): HTMLElement | null {
  if (!data) return null;
  const sec = h("div", { class: "usage-body" });
  if (data.state === "unreadable") {
    sec.append(h("p", { class: "note" }, `Private: it's in ${USAGE_REPO}, which this token can't read.`));
    return sec;
  }
  if (data.state === "none") {
    sec.append(h("p", { class: "note" }, `No usage published to ${USAGE_REPO} yet.`));
    return sec;
  }
  const usage = data.usage;
  // Published with the heartbeat but in a comment of its own: stale with
  // it, or when it fell behind it (its publishing failed); with no
  // heartbeat, by its own age.
  if (!usage.windows.length && usage.pools) return weeklyUsage(data, now);
  const behind = (since: number) => !usage.updatedAt || since - Date.parse(usage.updatedAt) > HEARTBEAT_STALE_MS;
  const stale = hb ? isStale(hb, now) || behind(Date.parse(hb.updatedAt)) : behind(now);
  sec.append(h("div", { class: `uw-list${stale ? " stale" : ""}` }, ...usage.windows.map((w) => windowRow(w, now))));
  const listed = new Map((hb?.workers ?? []).map((w) => [w.name, w]));
  const consumers: Consumer[] = usage.workers.map((w) => {
    const lw = listed.get(w.name);
    return { label: h("span", {}, h("strong", {}, w.name), ...(lw ? [" ", link(lw.itemUrl, lw.itemRef)] : [])), tokens: w.tokens };
  });
  if (usage.coordinatorTokens) consumers.push({ label: h("span", { title: "the coordinator's own session, in the 5-hour window" }, h("strong", {}, "coordinator"), " (5-hour window)"), tokens: usage.coordinatorTokens });
  consumers.sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens));
  if (consumers.length) {
    const max = consumers[0] ? tokenTotal(consumers[0].tokens) : 0;
    sec.append(h("h3", { class: "group-h" }, "Consumers"), h("ul", { class: `uc-list${stale ? " stale" : ""}` }, ...consumers.map((c) => consumerRow(c, max))));
  }
  sec.append(
    h(
      "p",
      { class: "fine" },
      usage.observedAt ? `Percent used: Claude Code's status line on the coordinator's machine, as of ${time(usage.observedAt)}. ` : "Percent used: not reported yet; it comes from the coordinator's status line (bot-heartbeat statusline). ",
      "Tokens: that machine's transcripts, cache reads included; a worker's are all of its subagents'. ",
      usage.updatedAt ? `Published at ${time(usage.updatedAt)} to ` : "Publication time unknown; source: ",
      usage.commentUrl ? link(usage.commentUrl, USAGE_REPO) : USAGE_REPO,
      ", private.",
    ),
  );
  return sec;
}

function refLabel(url: string): string {
  const ref: IssueRef | undefined = parseIssueUrl(url);
  if (ref) return `${ref.owner}/${ref.repo}#${ref.number}`;
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return url;
  }
}

function workItem(item: Item, now: number): HTMLElement {
  return h(
    "li",
    { class: "work" },
    h(
      "div",
      { class: "hdr" },
      pill(item.priority),
      h("span", { class: "title" }, item.url ? link(item.url, item.title) : item.title),
      h("span", { class: "age", title: `updated ${time(item.updatedAt)}` }, item.updatedAt ? `${age(item.updatedAt, now)} ago` : ""),
    ),
    item.branch.length ? h("div", { class: "links" }, ...item.branch.map((u) => link(u, refLabel(u)))) : null,
    item.why ? h("p", { class: "why" }, item.why) : null,
  );
}

const GROUP_LABEL: Record<WorkGroup["scope"], [string, string]> = {
  composefs: [PRESET_LABEL.composefs, PRESET_TITLE.composefs],
  infra: [PRESET_LABEL.infra, PRESET_TITLE.infra],
  none: ["No org", "items with no target organization"],
};

function workSection(items: Item[] | undefined, now: number, fromCache = false): HTMLElement {
  const sec = section("Active work");
  if (!items) {
    sec.append(h("p", { class: "note" }, unavailable(fromCache)));
    return sec;
  }
  const groups = workGroups(items);
  if (groups.length === 0) sec.append(h("p", { class: "note" }, "Nothing is In Progress on the board."));
  for (const g of groups) {
    const [label, title] = GROUP_LABEL[g.scope];
    sec.append(h("h3", { class: "group-h", title }, `${label} · ${g.items.length}`), h("ul", { class: "work-list" }, ...g.items.map((i) => workItem(i, now))));
  }
  return sec;
}

const EVENT_KIND_LABEL: Record<BotEvent["kind"], string> = { push: "push", pr: "PR", review: "review", comment: "comment", issue: "issue", branch: "branch" };

function eventRow(e: BotEvent, now: number): HTMLElement {
  return h(
    "li",
    { class: "ev" },
    h("span", { class: "age", title: time(e.at) }, age(e.at, now)),
    h("span", { class: `kind ev-${e.kind}` }, EVENT_KIND_LABEL[e.kind]),
    h(
      "span",
      { class: "what" },
      `${e.verb} `,
      link(e.url, e.target),
      e.count > 1 ? h("span", { class: "times" }, ` ×${e.count}`) : null,
      " ",
      h("span", { class: "tag" }, e.repo),
      e.title ? h("span", { class: "etitle" }, ` ${e.title}`) : null,
    ),
  );
}

function eventsSection(events: BotEvent[] | undefined, now: number, fromCache = false): HTMLElement {
  const sec = section(`${BOT_LOGIN} activity`);
  if (!events) sec.append(h("p", { class: "note" }, unavailable(fromCache)));
  else if (events.length === 0) sec.append(h("p", { class: "note" }, "No recent public activity."));
  else sec.append(h("ul", { class: "ev-list" }, ...events.slice(0, OPS_EVENTS_SHOWN).map((e) => eventRow(e, now))));
  return sec;
}

/** The usage section's header: the most used window, e.g. "5-hour 42%", or why there is none. */
export function usageSummary(data: UsageData | undefined): string {
  if (!data) return "…";
  if (data.state !== "ok") return data.state === "none" ? "none yet" : "private";
  const known = data.usage.windows.filter((w) => w.usedPercent !== undefined);
  const top = known.reduce<UsageWindow | undefined>((a, w) => (a && (a.usedPercent ?? 0) >= (w.usedPercent ?? 0) ? a : w), undefined);
  if (!top || top.usedPercent === undefined) return `${tokensText(data.usage.windows.reduce((n, w) => Math.max(n, tokenTotal(w.tokens)), 0))} tokens`;
  const pct = top.usedPercent;
  return `${WINDOW_LABEL[top.kind] ?? top.kind.replace(/_/g, " ")} ${pct % 1 ? pct.toFixed(1) : String(pct)}%`;
}

/**
 * The ops detail: devspaces, the coordinator's local agents, agent runs,
 * active work and the bot's activity. The changes feed and the usage
 * have sections of their own.
 */
export function opsDetail(ops: Ops | undefined, now: number = Date.now()): HTMLElement {
  const root = h("div", { class: "ops" });
  if (!ops) {
    root.append(h("p", { class: "empty" }, "Loading…"));
    return root;
  }
  for (const w of ops.warnings) root.append(h("p", { class: "warn" }, w));
  const t = tiles(ops.devspaces, now);
  if (t) root.append(t);
  root.append(
    devspacesSection(ops.devspaces, now, ops.fromCache),
    localSection(ops.local, ops.devspaces, now, ops.fromCache),
    agentsSection(ops.agents, now, ops.fromCache),
    workSection(ops.work, now, ops.fromCache),
    eventsSection(ops.events, now, ops.fromCache),
  );
  return root;
}

/** Move the live times in `root` to `now`. */
export function tickOps(root: ParentNode, now: number): void {
  for (const el of root.querySelectorAll(`.${TICK_SINCE}`)) {
    el.textContent = duration(now - Number(el.getAttribute(ATTR_T)));
  }
  for (const el of root.querySelectorAll(`.${TICK_LEFT}`)) {
    el.textContent = leftText(Number(el.getAttribute(ATTR_T)) - now, el.getAttribute(ATTR_MAX) === "1");
  }
  for (const el of root.querySelectorAll(`.${TICK_BAR}`)) {
    const left = Math.max(0, Number(el.getAttribute(ATTR_T)) - now);
    const total = Number(el.getAttribute(ATTR_TOTAL));
    if (total > 0) el.setAttribute("width", String((left / total) * 100));
  }
}
