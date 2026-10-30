import { h } from "../dom.ts";
import type { ApproveItem, ApproveResult } from "./maintain.ts";
import { refText, type PrRef } from "./reviewdrafts.ts";
import { prRoute } from "./view.ts";

/** A PR as a link into the existing PR pane. */
const prLink = (pr: PrRef): HTMLElement => h("a", { href: prRoute(pr) }, refText(pr));

const APPROVED = " — Done at HEAD";

/**
 * On a card's part that must not be redrawn (inboxview's fillInbox): a
 * report he hasn't read, until r; and, set to KEEP_BUSY, writes still
 * going out, not even on r.
 */
export const KEEP_ATTR = "data-keep";
export const KEEP_BUSY = "busy";

/**
 * The digest's Approve as a group, on its Inbox card: `approve` sends the
 * picked ones (approveSelected), each reported on its own; nothing is
 * retried, and a PR approved is unticked and disabled. The report stays
 * until r: the pass lists the approved PRs until its next digest.
 */
export function approveGroup(items: readonly ApproveItem[], approve: (items: readonly ApproveItem[]) => Promise<ApproveResult[]>): HTMLElement {
  const boxes = items.map((it) => h("input", { type: "checkbox", ...(it.approved ? { disabled: "" } : { checked: "" }), "aria-label": `Approve ${refText(it.pr)}` }));
  const labels = items.map((it) => h("span", {}, it.approved ? APPROVED : ""));
  const button = h("button", { type: "button", class: "primary" }, "Approve selected");
  const results = h("ul", { class: "maintain-results", role: "status" });
  button.disabled = items.every((it) => it.approved);
  button.addEventListener("click", () => {
    const picked = items.filter((it, i) => !it.approved && boxes[i]!.checked);
    if (button.disabled || !picked.length || !window.confirm(`Approve as you, at the heads the digest assessed: ${picked.map((it) => refText(it.pr)).join(", ")}?`)) return;
    button.disabled = true;
    results.setAttribute(KEEP_ATTR, KEEP_BUSY);
    results.replaceChildren(h("li", {}, "Approving…"));
    void approve(picked).then((rs) => {
      results.setAttribute(KEEP_ATTR, "");
      results.replaceChildren(...rs.map((r) => h("li", { class: r.status }, r.status === "approved" ? `Approved ${refText(r.pr)}.` : `${r.status === "skipped" ? "Skipped" : "Failed or uncertain"}: ${r.note}.`)));
      for (const r of rs) {
        const i = items.findIndex((it) => it.pr === r.pr);
        if (i < 0 || !items[i]!.approved) continue;
        boxes[i]!.checked = false;
        boxes[i]!.disabled = true;
        labels[i]!.textContent = APPROVED;
      }
    }, (e: unknown) => {
      results.setAttribute(KEEP_ATTR, "");
      results.replaceChildren(h("li", { class: "failed" }, `Not sent: ${e instanceof Error ? e.message : String(e)}`));
    }).finally(() => { button.disabled = items.every((it) => it.approved); });
  });
  return h("div", { class: "maintain-sec" }, h("ul", {}, ...items.map((it, i) => h("li", {}, h("label", {}, boxes[i]!, " ", prLink(it.pr), ` ${it.reason}`, labels[i]!)))), button, results);
}
