// Approve selected: the maintain digest's approvals, as the pass lists
// them in its needs-you list (holds.ts), approved as the operator one at a
// time at the head the digest assessed.

import type { GitHub } from "./api.ts";
import { refText, type PrRef } from "./reviewdrafts.ts";

export interface ApproveItem { pr: PrRef; head: string; reason: string; approved?: boolean }

/** Approvals remembered per client. */
const MAX_ITEMS = 100;

// Bridge GitHub's read-after-write lag across redraws. Per client, at most
// MAX_ITEMS heads for five minutes.
const recentApprovals = new WeakMap<GitHub, Map<string, number>>();
const approvalKey = (it: ApproveItem): string => `${refText(it.pr).toLowerCase()}@${it.head}`;
const APPROVAL_LAG_MS = 5 * 60_000;

export interface ApproveResult { pr: PrRef; status: "approved" | "skipped" | "failed"; note?: string }

/**
 * Approve each PR as the signed-in user at the head the digest assessed,
 * one at a time. A PR no longer open, or whose head moved since, is
 * skipped: the approval would be of a commit nobody assessed.
 */
export async function approveSelected(gh: GitHub, items: readonly ApproveItem[]): Promise<ApproveResult[]> {
  const out: ApproveResult[] = [];
  for (const it of items) {
    if (it.approved || (recentApprovals.get(gh)?.get(approvalKey(it)) ?? 0) > Date.now()) {
      out.push({ pr: it.pr, status: "skipped", note: `${refText(it.pr)} is already approved at the assessed head` });
      continue;
    }
    const path = `/repos/${it.pr.owner}/${it.pr.repo}/pulls/${it.pr.number}`;
    try {
      const now = await gh.send<{ state: string; head: { sha: string } }>("GET", path);
      if (now.state !== "open") out.push({ pr: it.pr, status: "skipped", note: `${refText(it.pr)} is no longer open` });
      else if (now.head.sha !== it.head) {
        out.push({ pr: it.pr, status: "skipped", note: `${refText(it.pr)}'s head moved to ${now.head.sha.slice(0, 12)} since the digest assessed ${it.head.slice(0, 12)}` });
      } else {
        await gh.send("POST", `${path}/reviews`, { event: "APPROVE", commit_id: it.head });
        it.approved = true;
        const recent = recentApprovals.get(gh) ?? new Map<string, number>();
        recent.set(approvalKey(it), Date.now() + APPROVAL_LAG_MS);
        if (recent.size > MAX_ITEMS) recent.delete(recent.keys().next().value!);
        recentApprovals.set(gh, recent);
        out.push({ pr: it.pr, status: "approved" });
      }
    } catch (e) {
      out.push({ pr: it.pr, status: "failed", note: `${refText(it.pr)}: ${String(e)}` });
    }
  }
  return out;
}
