import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import { activityEntries, type ActivityData } from "./activity.ts";
import { feedRow } from "./boardfeedview.ts";
import { agoLabel } from "./view.ts";

export function activityList(data: ActivityData, urgentOnly: boolean, render: Renderer, now: number): HTMLElement {
  const root = h("div", { class: "activity" });
  for (const warning of [...data.news?.warnings ?? [], ...data.dispatch?.warnings ?? [], ...data.eventsError ? [data.eventsError] : []]) {
    root.append(h("p", { class: "warn" }, warning));
  }
  if (!data.news || !data.events || !data.dispatch) root.append(h("p", { class: "note" }, "Reading activity sources…"));
  const list = h("ul", { class: "feed-list" });
  const entries = activityEntries(data, urgentOnly);
  for (const entry of entries) {
    if (entry.kind === "board") {
      const row = feedRow(entry.item, now);
      row.classList.add("activity-item");
      list.append(row);
      continue;
    }
    const item = entry.item;
    const row = h("li", { class: "activity-item news-item" }, h("span", { class: "kind" }, entry.kind), " ", agoLabel(entry.at, now));
    switch (entry.kind) {
      case "merge":
        row.classList.toggle("harness", entry.item.harness);
        row.append(h("h3", {}, link(item.url, `Merged ${entry.item.repo}#${entry.item.number}: ${entry.item.title}`)));
        if (entry.item.summary) row.append(h("div", { class: "md" }, render(entry.item.summary)));
        break;
      case "event":
        row.append(h("p", {}, link(item.url, `${entry.item.repo} ${entry.item.verb} ${entry.item.target}${entry.item.title ? `: ${entry.item.title}` : ""}${entry.item.count > 1 ? ` (×${entry.item.count})` : ""}`)));
        break;
      case "run":
        row.append(h("p", {}, link(item.url, `Finished ${entry.item.title} · ${entry.item.conclusion ?? "unknown result"}`)));
        if (entry.item.result) row.append(h("p", {}, entry.item.result.url ? link(entry.item.result.url, entry.item.result.text) : entry.item.result.text));
        break;
    }
    list.append(row);
  }
  if (!entries.length) root.append(h("p", { class: "empty" }, "No activity to show."));
  root.append(list);
  return root;
}
