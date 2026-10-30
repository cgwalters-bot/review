// Approve selected: the maintain digest's approvals, as the pass lists
// them in its needs-you list (holds.ts), approved as the operator one at a
// time at the head the digest assessed.

import type { GitHub } from "./api.ts";
import { refText, type PrRef } from "./reviewdrafts.ts";

export interface ApproveItem { pr: PrRef; head: string; reason: string; approved?: boolean }

export interface ApproveResult { pr: PrRef; status: "approved" | "skipped" | "failed"; note?: string; url?: string | undefined }

// Share in-flight and completed writes across single/digest cards, including
// uncertain failures. One authenticated client, at most 100 heads for five minutes.
const approvals = new WeakMap<GitHub, Map<string, { until: number; work: Promise<string | undefined> }>>();

/** Stop duplicate approvals after reload; one page at action time, never during polling. */
async function approveHead(gh: GitHub, it: ApproveItem): Promise<string | undefined> {
  const key = `${refText(it.pr).toLowerCase()}@${it.head}`;
  const recent = approvals.get(gh) ?? new Map();
  const previous = recent.get(key);
  if (previous && previous.until > Date.now()) { await previous.work; return undefined; }
  if (recent.size >= 100) {
    const [oldest, job] = recent.entries().next().value!;
    if (job.until > Date.now()) throw new Error("Approval receipts full; try later");
    recent.delete(oldest);
  }
  const path = `/repos/${refText(it.pr).replace("#", "/pulls/")}`;
  const work = (async () => {
    const { login } = await gh.send<{ login: string }>("GET", "/user");
    const reviews = await gh.send<{ user: { login: string }; state: string; commit_id: string }[]>("GET", `${path}/reviews?per_page=100`);
    if (reviews.some((r) => r.user?.login.toLowerCase() === login.toLowerCase() && r.state === "APPROVED" && r.commit_id === it.head)) return undefined;
    // A full page may hide an approval: refuse rather than guess from a partial read.
    if (reviews.length >= 100) throw new Error("Reviews exceed one page; check GitHub before approving");
    return (await gh.send<{ html_url: string }>("POST", `${path}/reviews`, { event: "APPROVE", commit_id: it.head })).html_url ?? `https://github.com/${refText(it.pr).replace("#", "/pull/")}`;
  })();
  const receipt = { until: Infinity, work: work.finally(() => { receipt.until = Date.now() + 5 * 60_000; }) };
  recent.set(key, receipt);
  approvals.set(gh, recent);
  return receipt.work;
}

/**
 * Approve each PR as the signed-in user at the head the digest assessed,
 * one at a time. A PR no longer open, or whose head moved since, is
 * skipped: the approval would be of a commit nobody assessed.
 */
export async function approveSelected(gh: GitHub, items: readonly ApproveItem[]): Promise<ApproveResult[]> {
  const out: ApproveResult[] = [];
  for (const it of items) {
    const path = `/repos/${refText(it.pr).replace("#", "/pulls/")}`;
    try {
      const now = await gh.send<{ state: string; head: { sha: string } }>("GET", path);
      if (now.state !== "open") out.push({ pr: it.pr, status: "skipped", note: `${refText(it.pr)} is no longer open` });
      else if (now.head.sha !== it.head) {
        out.push({ pr: it.pr, status: "skipped", note: `${refText(it.pr)}'s head moved to ${now.head.sha.slice(0, 12)}` });
      } else {
        const url = it.approved ? undefined : await approveHead(gh, it);
        it.approved = true;
        out.push({ pr: it.pr, status: url ? "approved" : "skipped", url, ...(!url ? { note: `${refText(it.pr)} already approved at HEAD` } : {}) });
      }
    } catch (e) {
      out.push({ pr: it.pr, status: "failed", note: `${refText(it.pr)}: ${String(e)}` });
    }
  }
  return out;
}
