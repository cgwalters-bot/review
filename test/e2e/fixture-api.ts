// The GitHub API the e2e renders answer from this checkout's fixtures,
// offline: render-needs-you.ts's jsdom fetch and the Playwright test's
// routes. Writes are refused; PR reads answer a draft with green CI.
//
// The data is `real` (the redacted 3 Nov capture), `661` (the published
// shape), `174` / `174-capped` / `174-grouped` (synthetic operator-path
// approval; see its fixture), or `group` (661 plus a #680 promote group
// with review buckets), or `approval` (the producer's compact evidence
// projection, with its observation clock rebased).

import { readFileSync } from "node:fs";
import { needsYou174 } from "../fixtures/needs-you-174.ts";
import { publishedTestHolds } from "../helpers.ts";

export const FIXTURE_DATA = ["real", "661", "group", "approval", "174", "174-capped", "174-grouped", "259"] as const;

export type FixtureData = (typeof FIXTURE_DATA)[number];

/** A stand-in token the app accepts at sign-in; nothing checks it. */
export const FIXTURE_TOKEN = ["ghp", "x".repeat(24)].join("_");

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

/** The pass's needs_you for `data`, confirmed at `at`. */
function needsYou(data: FixtureData, at: string): Record<string, unknown> {
  const variant = { "174": "full", "174-capped": "capped", "174-grouped": "grouped" } as const;
  if (Object.hasOwn(variant, data)) return { ...needsYou174(variant[data as keyof typeof variant]), validated_at: at, changed_at: at };
  if (data === "real") return { ...fixture("needs-you-real-2026-11-03.json").needs_you, validated_at: at, changed_at: at };
  const published = { ...fixture("needs-you-661.json"), validated_at: at, changed_at: at };
  if (data === "approval") {
    const evidence = fixture("approval-evidence-needs-you.json");
    const items = evidence.rows.map((row: { key: string; head: string }, i: number) => ({ key: row.key, item: row.key, source: "reviews", kind: i === 1 ? "review-withheld" : "review-approve", priority: null, waiting_since: at,
      ask: "Approve the published head", recommendation: null, action: { type: "approve_pull_request", repository: row.key.split("#")[0], number: Number(row.key.split("#")[1]), head: row.head }, carried: false, epic: "none", topEpic: "none" }));
    return { ...published, items, identities: undefined, requests: undefined, epics: {}, sources: { reviews: "complete" }, count: items.length, counts: { decisions: items.length, groups: 0, members: items.length }, details_omitted: 0,
      approval_evidence: { ...evidence.approval_evidence, observed_at: at } };
  }
  if (data === "661") return published;
  const bucketed = fixture("draft-review-needs-you.json");
  const key = "cgwalters-forge/bootc#1";
  const epic = "cgwalters-forge/tracker#976";
  const action = { type: "pull_request", repository: "cgwalters-forge/bootc", number: 1 };
  const request = published.requests.find((r: { key: string }) => r.key === "cgwalters-forge/tracker#1261");
  return {
    ...published, review_buckets: bucketed.review_buckets, count: published.count + 1, counts: { decisions: 9, groups: 1, members: 11 },
    items: [...published.items, { key, item: key, source: "reviews", kind: "review-promote", priority: null, waiting_since: "2026-11-04T19:00:00Z", ask: "3 draft PRs waiting for promotion",
      recommendation: null, target: `https://github.com/${key.replace("#", "/pull/")}`, head: null, action, source_ref: { type: "hold", repository: action.repository, number: 1 }, epic, topEpic: epic, group: bucketed.group }],
    identities: [...published.identities, { item: key, kind: "review-promote", source: "reviews", waiting_since: "2026-11-04T19:00:00Z", epic }],
    requests: [...published.requests, { ...request, key, identity: `github.com/${key}/promote`, question: "3 draft PRs waiting for promotion", target: action }],
  };
}

/** Whether the request would change something on the forge: anything but a read or a GraphQL query. */
export const isWrite = (method: string, pathname: string, body: string | undefined): boolean =>
  (method !== "GET" && !(method === "POST" && pathname === "/graphql")) || /\bmutation\b/.test(body ?? "");

/**
 * Answers the app's request for `pathname` from the fixtures, with the
 * holds comment carrying `data` confirmed a minute before `now`. Throws on
 * a write.
 */
export function fixtureResponse(data: FixtureData, method: string, pathname: string, body: string | undefined, now = Date.now()): unknown {
  if (isWrite(method, pathname, body)) throw new Error(`refusing ${method} ${pathname}`);
  if (pathname === "/user") return { login: "cgwalters" };
  if (/\/issues\/\d+\/comments$/.test(pathname)) {
    const at = new Date(now - 60_000).toISOString();
    const pass_view = fixture("pass-view.json").pass_view;
    // Synthetic capacity replay in the current observation/reset window.
    pass_view.observed_at = at;
    pass_view.complete = true;
    pass_view.omitted = 0;
    for (const [i, pass] of pass_view.passes.entries()) pass.at = new Date(now - (i * 5 + 1) * 60_000).toISOString();
    for (const flight of pass_view.in_flight) if (flight.state === "running") flight.started_at = new Date(now - 6 * 60_000).toISOString();
    for (const pool of pass_view.pools) if (pool.resets_at) pool.resets_at = new Date(now + 3_600_000).toISOString();
    if (data === "259") {
      const snapshot = fixture("needs-you-259.json");
      snapshot.at = snapshot.needs_you.validated_at = snapshot.needs_you.changed_at = at;
      snapshot.pass_view = pass_view;
      return [{ user: { login: "cgwalters-bot" }, body: `<!-- agent-board-holds v1 -->\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`` }];
    }
    const list = needsYou(data, at);
    const dispatchable_work = fixture("dispatchable-work.json");
    const today = fixture("today.json");
    today.day = at.slice(0, 10);
    today.observed_at = at;
    today.cost.day = new Date(Date.parse(`${today.day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const holds = JSON.stringify({ schema: "agent-board/holds/v1", at, truncated: 0, holds: publishedTestHolds(list), needs_you: list, pass_view, dispatchable_work, today });
    return [{ user: { login: "cgwalters-bot" }, body: `<!-- agent-board-holds v1 -->\n\n\`\`\`json\n${holds}\n\`\`\`\n` }];
  }
  if (pathname === "/repos/cgwalters-forge/tracker/actions/workflows/poll.yml/runs") return { total_count: 0, workflow_runs: [] };
  const pull = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(pathname);
  if (pull) return { html_url: `https://github.com/${pull[1]}/pull/${pull[2]}`, title: `Draft ${pull[2]}`, state: "open", draft: true, body: "", user: { login: "cgwalters-bot" }, head: { sha: (pull[2] === "2" ? "b" : "a").repeat(40) } };
  if (pathname.endsWith("/check-runs")) return { total_count: 1, check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] };
  if (pathname.endsWith("/status")) return { state: "success", statuses: [] };
  if (pathname.endsWith("/fields")) return fixture("fields.json");
  if (pathname === "/search/issues") return { items: [], total_count: 0 };
  return pathname === "/graphql" ? { data: {} } : [];
}
