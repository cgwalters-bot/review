// The Dashboard view: four tiles, each a link to the view that has the
// detail (runs in flight against the cap, approvals waiting, PRs in merge
// queues, pools held), the pool bars, and three 14-day charts (runs by
// result, items done by priority, success rate) as SVG bars with a table
// of the same numbers.

import { h, svg } from "../dom.ts";
import {
  APPROVED_URL,
  approvedNotQueued,
  DASHBOARD_CONFIG,
  type DashboardData,
  type DayRuns,
  DONE_PRIORITIES,
  type DoneDay,
  type HistoryDay,
  RUN_RESULTS,
  successRate,
} from "./dashboard.ts";
import type { DispatchData } from "./dispatch.ts";
import { poolRows } from "./opsview.ts";
import { viewHash } from "./shell.ts";
import type { UsageData } from "./usage.ts";

/** What the view shows beyond its own reads: the other views' data. */
export interface DashboardInputs {
  data: DashboardData | undefined;
  dispatch: DispatchData | undefined;
  /** Approve cards the inbox would show; undefined before the queue loaded. */
  approvals: number | undefined;
  usage: UsageData | undefined;
  /** Undefined while the board isn't read. */
  done: DoneDay[] | undefined;
  now: number;
}

const POOL_NAMES = { claude: "Claude", openai: "OpenAI" } as const;
const RESULT_LABEL: Record<keyof DayRuns, string> = { success: "succeeded", failure: "failed", cancelled: "cancelled", other: "ended otherwise", running: "running" };
const CHART = { bar: 10, gap: 3, height: 60 };

function tile(href: string, value: string, label: string, sub: string): HTMLElement {
  const external = !href.startsWith("#");
  return h("a", { class: "tile dash-tile", href, ...(external ? { target: "_blank", rel: "noopener" } : {}) }, h("div", { class: "big" }, value), h("div", { class: "label" }, label), h("div", { class: "sub" }, sub));
}

function tiles(i: DashboardInputs): HTMLElement {
  const live = i.dispatch?.state === "ok" ? i.dispatch.live : undefined;
  const running = live?.filter((r) => r.status === "in_progress").length;
  const queued = live ? live.length - running! : 0;
  const queues = i.data?.queues;
  const inQueue = queues?.queues.reduce((n, q) => n + q.count, 0);
  const waiting = i.data?.approved ? approvedNotQueued(i.data.approved, queues).length : undefined;
  const pools = i.usage?.state === "ok" ? i.usage.usage.pools : undefined;
  const held = pools ? (Object.keys(POOL_NAMES) as (keyof typeof POOL_NAMES)[]).filter((p) => pools[p]?.hold) : undefined;
  const n = (v: number | undefined) => (v === undefined ? "…" : String(v));
  return h(
    "div",
    { class: "tiles dash-tiles" },
    tile(viewHash("agents"), `${n(running)}/${DASHBOARD_CONFIG.runCap}`, "runs in flight / cap", live ? `${queued} queued` : "reading dispatch runs…"),
    tile(viewHash("inbox"), n(i.approvals), "approvals waiting", "PRs waiting on your review"),
    tile(APPROVED_URL, n(inQueue), "PRs in merge queues", waiting === undefined ? "reading approved PRs…" : `${waiting} approved, not queued`),
    tile(viewHash("usage"), n(held?.length), "pools held", held === undefined ? (i.usage?.state === "unreadable" ? "usage unreadable with this token" : "reading usage…") : held.length ? held.map((p) => POOL_NAMES[p]).join(", ") : "none: new runs can start"),
  );
}

interface Series {
  key: string;
  label: string;
}

/**
 * Stacked bars, a day each, oldest first; `value` undefined for a day
 * not known. Each bar's title, and a table under the chart, give the
 * numbers, so nothing is told by color alone.
 */
function chart(title: string, cls: string, days: readonly string[], series: readonly Series[], value: (day: number, s: number) => number | undefined, max?: number, unit = ""): HTMLElement {
  const totals = days.map((_, d) => series.reduce((n, _s, s) => n + (value(d, s) ?? 0), 0));
  const top = max ?? Math.max(1, ...totals);
  const width = days.length * (CHART.bar + CHART.gap) - CHART.gap;
  const plot = svg("svg", { class: `chart ${cls}`, viewBox: `0 0 ${width} ${CHART.height}`, preserveAspectRatio: "none", role: "img", "aria-label": `${title}, last ${days.length} days; the table below has the numbers` });
  days.forEach((day, d) => {
    const x = String(d * (CHART.bar + CHART.gap));
    const known = series.map((_, s) => value(d, s));
    if (known.every((v) => v === undefined)) {
      plot.append(svg("rect", { class: "missing", x, y: String(CHART.height - 1), width: String(CHART.bar), height: "1" }, svg("title", {}, `${day}: not known`)));
      return;
    }
    let y = CHART.height;
    const words = series.map((s, i) => `${known[i] ?? 0}${unit} ${s.label}`).join(", ");
    series.forEach((s, i) => {
      const v = known[i] ?? 0;
      if (v <= 0) return;
      const hgt = (v / top) * CHART.height;
      y -= hgt;
      plot.append(svg("rect", { class: `s-${s.key}`, x, y: String(y), width: String(CHART.bar), height: String(hgt) }, svg("title", {}, `${day}: ${words}`)));
    });
  });
  const legend = series.length > 1 ? h("p", { class: "chart-legend" }, ...series.map((s) => h("span", { class: `key s-${s.key}` }, h("span", { class: "swatch", "aria-hidden": "true" }), s.label))) : null;
  const table = h(
    "details",
    { class: "chart-table" },
    h("summary", {}, "Numbers"),
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", {}, "Day (UTC)"), ...series.map((s) => h("th", {}, s.label)))),
      h("tbody", {}, ...days.map((day, d) => h("tr", {}, h("td", {}, day), ...series.map((_, s) => h("td", {}, String(value(d, s) ?? "—")))))),
    ),
  );
  return h("section", { class: "dash-chart", "aria-label": title }, h("h3", {}, title), plot, h("p", { class: "chart-axis" }, h("span", {}, days[0] ?? ""), h("span", {}, "today")), legend, table);
}

function runsChart(history: readonly HistoryDay[]): HTMLElement {
  const series = RUN_RESULTS.map((key) => ({ key, label: RESULT_LABEL[key] }));
  return chart("Dispatch runs by result", "runs", history.map((d) => d.day), series, (d, s) => history[d]!.runs?.[RUN_RESULTS[s]!]);
}

function rateChart(history: readonly HistoryDay[]): HTMLElement {
  const sum = history.reduce((n, d) => ({ success: n.success + (d.runs?.success ?? 0), failure: n.failure + (d.runs?.failure ?? 0) }), { success: 0, failure: 0 });
  const all = sum.success + sum.failure ? `: ${Math.round((100 * sum.success) / (sum.success + sum.failure))}% over ${history.length} days` : "";
  return chart(`Success rate${all}`, "rate", history.map((d) => d.day), [{ key: "rate", label: "% of finished runs that succeeded (cancelled left out)" }], (d) => {
    const runs = history[d]!.runs;
    const rate = runs && successRate(runs);
    return rate === undefined ? undefined : Math.round(rate);
  }, 100);
}

function doneChart(done: readonly DoneDay[]): HTMLElement {
  const series = DONE_PRIORITIES.map((p) => ({ key: p.toLowerCase(), label: p === "none" ? "no priority" : p }));
  return chart("Board items done by priority", "done", done.map((d) => d.day), series, (d, s) => done[d]!.byPriority[DONE_PRIORITIES[s]!]);
}

export function dashboardView(i: DashboardInputs): HTMLElement {
  const usage = i.usage?.state === "ok" ? i.usage.usage : undefined;
  const history = i.data?.history;
  return h(
    "div",
    { class: "dashboard-body" },
    tiles(i),
    h("section", { class: "dash-pools", "aria-label": "Pools" }, h("h3", {}, "Pools"), usage?.pools ? h("div", { class: "pools" }, ...poolRows(usage, i.now)) : h("p", { class: "note" }, i.usage?.state === "unreadable" ? "Usage unreadable with this token." : usage ? "No pools in the usage snapshot." : "Reading usage…")),
    h(
      "div",
      { class: "dash-charts" },
      history ? runsChart(history) : h("p", { class: "note" }, "Reading the run history…"),
      history ? rateChart(history) : null,
      i.done ? doneChart(i.done) : h("p", { class: "note" }, "Reading the board…"),
    ),
    i.data?.warnings.length ? h("p", { class: "note warn" }, i.data.warnings.join(" ")) : null,
  );
}
