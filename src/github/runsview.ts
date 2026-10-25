import { h } from "../dom.ts";
import type { PageState } from "./state.ts";
import { ageLabel, agoLabel } from "./view.ts";

export function runsPanel(state: PageState): HTMLElement {
  const now = Date.now();
  const box = h("section", { class: "dashboard-runs", "aria-label": "Live Actions runs" }, h("h2", {}, "Live Actions runs · agent.yml"));
  const data = state.runs;
  const source = state.sources.runs;
  box.append(h("p", { class: "note" }, ...(source?.checkedAt ? ["Checked ", agoLabel(new Date(source.checkedAt).toISOString(), now), ` · ${source.state} · refreshes every 60 s while visible`] : ["Reading Actions independently of the heartbeat…"])));
  if (source?.error) box.append(h("p", { class: "note" }, `${source.error}${data?.state === "ok" ? " Showing last known rows." : ""}`));
  if (!data || data.state === "unavailable") {
    box.append(h("p", { class: "note" }, data?.warnings.join(" ") ?? "Actions not fetched yet."));
    return box;
  }
  const t = data.totals;
  if (source?.state === "unavailable") box.append(h("p", { class: "note" }, "Totals from ", agoLabel(new Date(data.at).toISOString(), now), "; active status and runner time have not been revalidated."));
  box.append(h("p", {}, `Last 24 h: ${t.count} runs created · ${t.active} currently active · ${t.completed} completed · ${t.failed} failed · ${t.coreHours === null ? "core-hours unknown" : `${t.coreHours.toFixed(2)} known core-hours`}${t.partial ? " (partial/lower bound)" : ""}`),
    h("p", { class: "note" }, `Title readings for runs created in the last 24 h: tokens: ${t.tokens === null ? "unavailable" : `${t.tokens.toLocaleString("en-US")} known`} (${t.tokensKnownRuns}/${t.count} runs${t.tokensPartial ? "; partial" : ""}) · cost: ${t.cost === null ? "unavailable" : `$${t.cost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USD known`} (${t.costKnownRuns}/${t.count} runs${t.costPartial ? "; partial" : ""}). These are reported readings, not time-clipped consumption; plan windows are shown under Usage.`));
  const spark = h("div", { class: "runs-spark", role: "img", "aria-label": `Known core-hours per hour, oldest first: ${t.buckets.map((n) => n.toFixed(2)).join(", ")}` });
  const max = Math.max(...t.buckets, 1);
  t.buckets.forEach((value, i) => {
    const bar = h("span", { title: `${24 - i}–${23 - i} h ago: ${value.toFixed(2)} core-hours` });
    bar.style.height = `${Math.max(2, value / max * 100)}%`;
    spark.append(bar);
  });
  box.append(spark);
  for (const warning of data.warnings) box.append(h("p", { class: "note" }, warning));
  const live = data.runs.filter((r) => r.active);
  if (!live.length) box.append(h("p", { class: "note" }, "No active agent.yml runs."));
  const rows = [...live, ...data.runs.filter((r) => !r.active).slice(0, 5)];
  for (const run of rows) {
    const details = h("details", { class: "action-run", "data-run-id": String(run.id) }, h("summary", {}, h("a", { href: run.url }, run.title), ` · ${run.conclusion ?? run.status}`));
    details.append(h("p", {}, `Run ${run.id} · attempt ${run.attempt} · ${run.actor ?? "actor unknown"} · started `, agoLabel(run.startedAt, now), run.updatedAt ? h("span", {}, " · updated ", agoLabel(run.updatedAt, now)) : null));
    if (run.jobsError) details.append(h("p", { class: "note" }, `Jobs unavailable/partial: ${run.jobsError}`));
    if (!run.jobs.length && !run.jobsError) details.append(h("p", { class: "note" }, "No jobs reported yet."));
    for (const job of run.jobs) details.append(h("p", {}, `${job.name ?? "Job"} · ${job.conclusion ?? job.status ?? "unknown"} · runner ${job.runner_name ?? "unknown"} · labels ${(job.labels ?? []).join(", ") || "unknown"} · `, job.started_at ? ageLabel(job.started_at, now) : "not started", " → ", job.completed_at ? ageLabel(job.completed_at, now) : "not finished"));
    box.append(details);
  }
  return box;
}
