// Synthetic producer contract: operator-path approval survives a cap of 12
// other rows. No live publication or operatorPaths policy is inferred by the app.
export function needsYou174(capped = false) {
  const at = "2026-10-30T12:00:00Z";
  const epic = "cgwalters-forge/tracker#976";
  const inactive = "cgwalters-forge/tracker#900";
  const items = Array.from({ length: 174 }, (_, i) => {
    const approve = i === 173;
    const number = approve ? 1367 : 2000 + i;
    const item = `cgwalters-forge/tracker#${number}`;
    const action = { type: approve ? "approve_pull_request" : "issue", repository: "cgwalters-forge/tracker", number, ...(approve ? { head: "a".repeat(40) } : {}) };
    return { key: item, item, source: approve ? "reviews" : "items", kind: approve ? "review-approve" : "needs-human", priority: approve ? "P2" : "P1",
      waiting_since: at, ask: approve ? "Approve the operator-path PR to release 21 stale holds" : `Choose the next step for item ${number}`,
      recommendation: null, target: `https://github.com/cgwalters-forge/tracker/${approve ? "pull" : "issues"}/${number}`, head: approve ? "a".repeat(40) : null,
      action, source_ref: { ...action, type: approve ? "pull_request" : "hold" }, epic: approve ? inactive : epic, topEpic: approve ? inactive : epic };
  });
  const published = capped ? [...items.slice(0, 12), items[173]!] : items;
  return { schema: "agent-board/needs-you/v2", complete: !capped, validated_at: at, changed_at: at,
    sources: { epics: "complete", items: "complete", reviews: "complete" }, summaries: "complete", omitted: capped ? 161 : 0,
    count: 174, counts: { decisions: 174, groups: 0, members: 174 }, details_omitted: 0,
    items: published, identities: published.map((a) => ({ item: a.item, kind: a.kind, source: a.source, waiting_since: at, priority: a.priority, epic: a.epic, topEpic: a.topEpic })),
    epics: { [epic]: { active: true, activeWhy: ["focus"], complete: true }, [inactive]: { active: false, activeWhy: [], complete: true } } };
}
