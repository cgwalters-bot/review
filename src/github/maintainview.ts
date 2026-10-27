import { h, link } from "../dom.ts";
import type { GitHub } from "./api.ts";
import { approveSelected, closerMinutes, DAY_MINUTES, digestIsStale, fileUrl, type Found } from "./maintain.ts";
import { refText, type PrRef } from "./reviewdrafts.ts";
import { prRoute } from "./view.ts";

/** A PR as a link into the existing PR pane. */
const prLink = (pr: PrRef): HTMLElement => h("a", { href: prRoute(pr) }, refText(pr));

/** The newest digest in its four sections, or why there is none to show. */
export function maintainView(gh: GitHub, found: Found | undefined, error: string | undefined): HTMLElement[] {
  if (error) return [h("p", { class: "note" }, `Can't read the digest: ${error}`)];
  if (!found) return [h("p", { class: "note" }, "No digest posted yet.")];
  const d = found.digest;
  if (!d) return [h("p", { class: "note" }, "The newest ", link(found.url, "digest"), ` can't be read: ${found.error}.`)];

  const boxes = d.approve.map((it) => h("input", { type: "checkbox", ...(it.approved ? { disabled: "" } : { checked: "" }), "aria-label": `Approve ${refText(it.pr)}` }));
  const labels = d.approve.map((it) => h("span", {}, it.approved ? " — Already approved at the assessed head" : ""));
  const approve = h("button", { type: "button" }, "Approve selected");
  const results = h("ul", { class: "maintain-results", role: "status" });
  approve.disabled = d.approve.every((it) => it.approved);
  approve.addEventListener("click", () => {
    const picked = d.approve.filter((it, i) => !it.approved && boxes[i]!.checked);
    if (approve.disabled || !picked.length || !window.confirm(`Approve as you, at the heads the digest assessed: ${picked.map((it) => refText(it.pr)).join(", ")}?`)) return;
    approve.disabled = true;
    results.replaceChildren(h("li", {}, "Approving…"));
    void approveSelected(gh, picked).then((rs) => {
      results.replaceChildren(...rs.map((r) => h("li", { class: r.status }, r.status === "approved" ? `Approved ${refText(r.pr)}.` : `${r.status === "skipped" ? "Skipped" : "Failed"}: ${r.note}.`)));
      rs.forEach((r) => {
        if (r.status !== "approved") return;
        const i = d.approve.findIndex((it) => it.pr === r.pr);
        boxes[i]!.checked = false;
        boxes[i]!.disabled = true;
        labels[i]!.textContent = " — Already approved at the assessed head";
      });
    }).finally(() => { approve.disabled = d.approve.every((it) => it.approved); });
  });

  const minutes = closerMinutes(d);
  const copy = (text: string) => {
    const b = h("button", { type: "button" }, "Copy");
    b.addEventListener("click", () => void navigator.clipboard.writeText(text).then(() => { b.textContent = "Copied"; }));
    return b;
  };
  const sec = (title: string, ...body: (HTMLElement | null)[]) => h("section", { class: "maintain-sec", "aria-label": title }, h("h3", {}, title), ...body);
  return [
    h("p", { class: "note" }, link(found.url, `Digest of ${d.date}`), ". Each PR opens in the PR pane; Approve selected approves as you."),
    ...((found.stale ?? digestIsStale(d.date)) ? [h("p", { class: "maintain-over", role: "alert" }, "Warning: this digest is more than a day old (neither today nor yesterday, UTC). Its assessments may be stale; check before approving.")] : []),
    sec("Approve as a group",
      h("ul", {}, ...d.approve.map((it, i) => h("li", {}, h("label", {}, boxes[i]!, " ", prLink(it.pr), ` ${it.reason}`, labels[i]!)))),
      approve, results),
    sec("Needs a closer look",
      h("p", { class: minutes > DAY_MINUTES ? "maintain-over" : "note" }, `${minutes} of ${DAY_MINUTES} minutes`),
      h("ul", {}, ...d.closer.map((it) => h("li", {}, prLink(it.pr), ` (${it.minutes} min) ${it.concern} `,
        ...it.links.map((l) => h("span", {}, " ", link(fileUrl(it, l), `${l.path}:${l.start}${l.end ? `-${l.end}` : ""}`))))))),
    sec("Waiting on the author",
      h("ul", {}, ...d.waiting.map((it) => h("li", {}, prLink(it.pr), " ", copy(it.reply), h("pre", { class: "maintain-reply" }, it.reply))))),
    sec("Stale", h("ul", {}, ...d.stale.map((it) => h("li", {}, prLink(it.pr), ` ${it.reason}`)))),
  ];
}
