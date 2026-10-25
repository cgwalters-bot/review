// The Agents view's dispatch runs (dispatch.ts): a card per live run
// with its kind, item, pool, elapsed time and current step, then the
// runs that finished in the last few hours with their result.

import { h, link } from "../dom.ts";
import { chatButton, chatItem } from "./chatitem.ts";
import { FINISHED_MS, type DispatchData, type DispatchRun } from "./dispatch.ts";
import { age, time } from "./view.ts";

/** The class of a run's card. */
export const DISPATCH_CARD_CLASS = "dispatch-run";

const itemUrl = (run: DispatchRun): string | undefined =>
  run.target ? `https://github.com/${run.target.owner}/${run.target.repo}/issues/${run.target.number}` : undefined;

/** Kind, item link and pool chip, or the bare title when it isn't of the dispatch form. */
function heading(run: DispatchRun): (Node | string)[] {
  const t = run.target;
  if (!t) return [h("span", { class: "dr-title" }, run.title)];
  return [h("span", { class: "kind" }, t.kind), " ", link(itemUrl(run), `${t.owner}/${t.repo}#${t.number}`), " ", h("span", { class: "dr-pool" }, t.pool)];
}

function stepLine(run: DispatchRun, now: number): HTMLElement {
  if (run.jobsError) return h("p", { class: "dr-step note" }, `Jobs unavailable: ${run.jobsError}`);
  if (!run.step) return h("p", { class: "dr-step note" }, run.status === "queued" ? "Waiting for a runner." : "No step has started yet.");
  const since = run.step.since ? ` (since ${age(run.step.since, now)})` : "";
  return h("p", { class: "dr-step", title: `${run.step.job}${run.step.since ? `, step started ${time(run.step.since)}` : ""}` }, `${run.step.name}${since}`);
}

/** What a finished run handed back: a PR, a comment, else its conclusion. */
function resultChip(run: DispatchRun): string {
  const url = run.result?.url;
  if (url && /\/pull\/\d+/.test(url)) return "PR";
  if (url?.includes("#issuecomment-")) return "comment";
  return run.conclusion ?? run.status;
}

function liveCard(run: DispatchRun, now: number): HTMLElement {
  return h(
    "li",
    { class: `${DISPATCH_CARD_CLASS} live`, "data-run-id": String(run.id) },
    h("div", { class: "dr-head" }, h("span", { class: "dr-dot", "aria-hidden": "true" }), ...heading(run),
      h("span", { class: "age", title: `started ${time(run.startedAt)}` }, age(run.startedAt, now))),
    stepLine(run, now),
    h("p", { class: "dr-links" }, `${run.status} · `, link(run.url, "run ↗"), chatButton(chatItem(itemUrl(run), run.target ? `${run.target.owner}/${run.target.repo}#${run.target.number}` : run.title, run.target?.pool))),
  );
}

function finishedCard(run: DispatchRun, now: number): HTMLElement {
  const failed = run.conclusion !== "success";
  let result: Node | string;
  if (run.resultError) result = h("span", { class: "note" }, `Status comment unavailable: ${run.resultError}`);
  else if (run.result) result = h("span", {}, run.result.text);
  else result = h("span", { class: "note" }, run.target ? "No status comment on the item." : "No item in the title.");
  return h(
    "li",
    { class: `${DISPATCH_CARD_CLASS} finished`, "data-run-id": String(run.id) },
    h("div", { class: "dr-head" }, h("span", { class: `dr-result${failed ? " failed" : ""}` }, resultChip(run)), " ", ...heading(run),
      h("span", { class: "age", title: `finished ${time(run.updatedAt)}` }, `finished ${age(run.updatedAt, now)} ago`)),
    h("p", { class: "dr-step" }, result),
    h("p", { class: "dr-links" }, run.result?.url ? link(run.result.url, "result ↗") : null, run.result?.url ? " · " : null, link(run.url, "run ↗"), chatButton(chatItem(itemUrl(run), run.target ? `${run.target.owner}/${run.target.repo}#${run.target.number}` : run.title, run.target?.pool))),
  );
}

export function dispatchPanel(data: DispatchData | undefined, now: number): HTMLElement {
  const box = h("section", { class: "dispatch-runs", "aria-label": "Dispatch runs" });
  const count = data?.state === "ok" ? `${data.live.length} live` : "…";
  box.append(h("h2", {}, "Dispatch runs ", h("span", { class: "dr-count" }, count)));
  if (!data) {
    box.append(h("p", { class: "note" }, "Reading dispatch runs…"));
    return box;
  }
  for (const w of data.warnings) box.append(h("p", { class: "note" }, w));
  if (data.state !== "ok") return box;
  if (data.live.length) box.append(h("ul", { class: "dr-list" }, ...data.live.map((r) => liveCard(r, now))));
  else box.append(h("p", { class: "note" }, "No dispatch run is in progress or queued."));
  if (data.finished.length) {
    box.append(h("h3", {}, `Finished in the last ${FINISHED_MS / 3600_000} h`), h("ul", { class: "dr-list" }, ...data.finished.map((r) => finishedCard(r, now))));
  }
  return box;
}
