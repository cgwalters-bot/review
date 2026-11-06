// Draws Needs you from any checkout of this repository against this
// checkout's fixtures, offline, and writes the page with that checkout's
// style.css inlined, for screenshots that compare commits on the same data:
//
//   git worktree add /tmp/before 4a8d672
//   node test/e2e/render-needs-you.ts /tmp/before group /tmp/before.html [CARD_KEY]
//   chromium --headless --screenshot=/tmp/before.png --window-size=1280,2400 file:///tmp/before.html
//
// The checkout needs node_modules (a symlink to this one's will do). The
// data is `real` (the redacted 3 Nov capture), `661` (the published
// shape), `174` / `174-capped` / `174-grouped` (synthetic operator-path
// approval; see its fixture), or
// `group` (661 plus a #680 promote group with review buckets).
// CARD_KEY opens that card's details and its first two members. Writes
// are refused; PR reads answer a draft with green CI.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { needsYou174 } from "../fixtures/needs-you-174.ts";

const [checkout, data, out, open] = process.argv.slice(2);
if (!checkout || !data || !out) throw new Error("usage: render-needs-you.ts CHECKOUT real|661|group|174|174-capped|174-grouped OUT.html [CARD_KEY]");
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const SETTLE_MS = 200;
const at = new Date(Date.now() - 60_000).toISOString();

/** The pass's needs_you for `data`, confirmed a minute ago. */
function needsYou(): Record<string, unknown> {
  const variant = { "174": "full", "174-capped": "capped", "174-grouped": "grouped" } as const;
  if (Object.hasOwn(variant, data!)) return { ...needsYou174(variant[data as keyof typeof variant]), validated_at: at, changed_at: at };
  if (data === "real") return { ...fixture("needs-you-real-2026-11-03.json").needs_you, validated_at: at, changed_at: at };
  const published = { ...fixture("needs-you-661.json"), validated_at: at, changed_at: at };
  if (data === "661") return published;
  if (data !== "group") throw new Error(`unknown data ${data}: real, 661 or group`);
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

const pass_view = fixture("pass-view.json").pass_view;
const comment = `<!-- agent-board-holds v1 -->\n\n\`\`\`json\n${JSON.stringify({ schema: "agent-board/holds/v1", at, truncated: 0, holds: [], needs_you: needsYou(), pass_view })}\n\`\`\`\n`;
const dom = new JSDOM(readFileSync(resolve(checkout, "static/index.html"), "utf8"), { url: "https://review.example/#inbox", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
const { window } = dom;
window.scrollTo = () => {};
Object.assign(globalThis, {
  window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement, localStorage: window.localStorage,
  ResizeObserver: class { observe() {} disconnect() {} },
  fetch: async (input: string, init?: RequestInit) => {
    const { pathname } = new URL(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    if (((init?.method ?? "GET") !== "GET" && pathname !== "/graphql") || /\bmutation\b/.test(String(init?.body ?? ""))) throw new Error(`refusing ${init?.method} ${pathname}`);
    if (pathname === "/user") return json({ login: "cgwalters" });
    if (/\/issues\/\d+\/comments$/.test(pathname)) return json([{ user: { login: "cgwalters-bot" }, body: comment }]);
    const pull = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(pathname);
    if (pull) return json({ html_url: `https://github.com/${pull[1]}/pull/${pull[2]}`, title: `Draft ${pull[2]}`, state: "open", draft: true, body: "", user: { login: "cgwalters-bot" }, head: { sha: (pull[2] === "2" ? "b" : "a").repeat(40) } });
    if (pathname.endsWith("/check-runs")) return json({ total_count: 1, check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] });
    if (pathname.endsWith("/status")) return json({ state: "success", statuses: [] });
    if (pathname.endsWith("/fields")) return json(fixture("fields.json"));
    if (pathname === "/search/issues") return json({ items: [], total_count: 0 });
    return json(pathname === "/graphql" ? { data: {} } : []);
  },
});

const doc = window.document;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300; i++, await sleep(10)) if (check()) return;
  throw new Error(`timed out waiting for ${what}`);
}
await import(pathToFileURL(resolve(checkout, "src/github/main.ts")).href);
await until(() => !!doc.querySelector(".signin"), "sign-in");
doc.querySelector<HTMLInputElement>(".signin input[type=password]")!.value = ["ghp", "x".repeat(24)].join("_");
doc.querySelector(".signin")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await until(() => !!doc.querySelector(".published") && !doc.querySelector(".published")!.textContent!.startsWith("Reading"), "the published list");
await sleep(SETTLE_MS);
if (open) {
  const card = doc.querySelector(`.inbox-cards > .card[data-key="${open}"]`);
  if (!card) throw new Error(`no card ${open}`);
  const opened = [card.querySelector<HTMLDetailsElement>(".card-full"), ...[...card.querySelectorAll<HTMLDetailsElement>("details.member")].slice(0, 2)];
  for (const d of opened) if (d) { d.open = true; d.dispatchEvent(new window.Event("toggle")); await sleep(SETTLE_MS); }
}
for (const el of doc.querySelectorAll('script, link[rel=stylesheet], meta[http-equiv="Content-Security-Policy"]')) el.remove();
doc.head.append(Object.assign(doc.createElement("style"), { textContent: readFileSync(resolve(checkout, "static/style.css"), "utf8") }));
writeFileSync(out, `<!doctype html>\n${doc.documentElement.outerHTML}`);
process.exit(0);
