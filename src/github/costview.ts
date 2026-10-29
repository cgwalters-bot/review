// The Usage view's daily spend (cost.ts): the reviews' share of the last
// week in one line, the charted days stacked by kind or by model, and the
// chosen day's costliest runs, each linked to its run.

import { h, link } from "../dom.ts";
import { type CostData, type CostEntry, type CostGroup, type CostRun, costSeries, reviewShare, SHARE_DAYS, seriesCell, topRuns } from "./cost.ts";
import { chart } from "./dashboardview.ts";
import { tokensText, usd } from "./opsview.ts";
import { ITEM_RE, USAGE_CONFIG } from "./usage.ts";

export type CostBy = "kind" | "model";

/** What he picked: the stacking, and the day whose runs are listed. */
export interface CostPick {
  by: CostBy;
  day?: string;
}

export interface CostHooks {
  pick(p: CostPick): void;
}

const runs = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`;

/** A group's dollars as published, or its tokens where nothing is priced: never $0 for an unpriced run. */
export function groupText(g: CostGroup): string {
  if (!g.runs) return "—";
  if (g.usd === null) return `unpriced, ${tokensText(g.tokens)} tokens`;
  return g.unpricedRuns ? `${usd(g.usd)} + ${g.unpricedRuns} unpriced` : usd(g.usd);
}

/** "Reviews: 41% of spend, 7 days", with what it leaves out. */
export function shareLine(days: readonly CostEntry[]): string {
  const s = reviewShare(days);
  if (!s.days) return `Reviews: no spend published for the last ${SHARE_DAYS} days.`;
  const span = s.days === SHARE_DAYS ? `${SHARE_DAYS} days` : `${s.days} of the last ${SHARE_DAYS} days published`;
  const head = s.share === undefined ? `Reviews: no priced spend, ${span}` : `Reviews: ${Math.round(100 * s.share)}% of spend, ${span}`;
  return s.unpricedRuns ? `${head}; plus ${runs(s.unpricedRuns)} unpriced, ${tokensText(s.unpricedTokens)} tokens.` : `${head}.`;
}

function runRow(r: CostRun): HTMLElement {
  // An item named OWNER/REPO#N is linked from its parts; other text is shown as it is.
  const item = r.item ? ITEM_RE.exec(r.item) : null;
  return h(
    "tr",
    {},
    h("td", {}, r.kind),
    h("td", {}, r.repo),
    h("td", {}, item ? link(`https://github.com/${item[1]}/issues/${item[2]}`, r.item!) : (r.item ?? "—")),
    h("td", {}, r.model),
    h("td", { class: "num" }, r.usd === null ? `unpriced, ${tokensText(r.tokens)} tokens` : usd(r.usd)),
    h("td", {}, link(r.url, "run ↗")),
  );
}

function select(label: string, value: string, options: readonly [string, string][], onChange: (v: string) => void): HTMLElement {
  const el = h("select", {}, ...options.map(([v, text]) => h("option", { value: v, ...(v === value ? { selected: "" } : {}) }, text)));
  el.addEventListener("change", () => onChange(el.value));
  return h("label", {}, `${label} `, el);
}

/** The section, or a line saying why there is nothing to chart. */
export function costSection(data: CostData | undefined, pick: CostPick, hooks: CostHooks): HTMLElement {
  const sec = h("section", { class: "usage-body cost", "aria-label": "Agent spend by day" }, h("h2", {}, "Agent spend by day"));
  const source = USAGE_CONFIG.cost;
  const where = source ? `cost/ on ${source.repo}'s ${source.ref} branch` : "cost/";
  if (!data || data.state === "none") {
    sec.append(h("p", { class: "note" }, data ? `Nothing published to ${where} yet.` : "Reading the daily cost…"));
    return sec;
  }
  const days = data.days;
  const published = days.filter((e) => e.day);
  const day = published.find((e) => e.date === pick.day) ?? published.at(-1);
  const series = costSeries(days, pick.by);
  const cell = (d: number, s: number) => (days[d]!.day ? seriesCell(days[d]!.day!, pick.by, series[s]!) : undefined);
  sec.append(
    h("p", { class: "cost-share" }, shareLine(days)),
    h(
      "p",
      { class: "cost-pick" },
      select("Stack by", pick.by, [["kind", "kind"], ["model", "model"]], (by) => hooks.pick({ ...pick, by: by as CostBy })),
      " ",
      published.length ? select("Runs of", day!.date, published.map((e) => [e.date, e.date]).reverse() as [string, string][], (d) => hooks.pick({ ...pick, day: d })) : null,
    ),
    chart(
      `Dollars by ${pick.by}, last ${days.length} days`,
      "cost",
      days.map((e) => e.date),
      series,
      (d, s) => {
        const g = cell(d, s);
        return g ? (g.usd ?? 0) : undefined;
      },
      undefined,
      (d, s) => {
        const g = cell(d, s);
        return g ? groupText(g) : days[d]!.unreadable ? "unreadable" : "not published";
      },
      days.at(-1)?.date ?? "",
    ),
  );
  if (day?.day) {
    const top = topRuns(day.day);
    sec.append(
      h("h3", { class: "group-h" }, `Costliest runs, ${day.date}: ${groupText(day.day.totals)} in ${runs(day.day.totals.runs)}`),
      top.length
        ? h("table", { class: "spend-runs" }, h("thead", {}, h("tr", {}, h("th", {}, "Kind"), h("th", {}, "Repository"), h("th", {}, "Item"), h("th", {}, "Model"), h("th", { class: "num" }, "Cost"), h("th", {}, "Run"))), h("tbody", {}, ...top.map(runRow)))
        : h("p", { class: "fine" }, "No runs listed that day."),
    );
  }
  sec.append(h("p", { class: "fine" }, "Dollars at list prices, as agent-board's cost report publishes them; a model without a price shows its tokens. From ", source ? link(`https://github.com/${source.repo}/tree/${encodeURIComponent(source.ref)}/cost`, where) : where, "."));
  return sec;
}
