import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import rawConfig from "../src/github/maintain-config.json" with { type: "json" };
import { GitHub } from "../src/github/api.ts";
import {
  approveSelected, closerMinutes, DAY_MINUTES, DIGEST_SCHEMA, fileUrl, loadDigest, MAINTAIN_CONFIG, maintainConfig, newestDigest, parseDigest, type MaintainConfig,
} from "../src/github/maintain.ts";
import { maintainView } from "../src/github/maintainview.ts";
import type { RawComment, RawIssue } from "../src/github/reviewdrafts.ts";
import { isView } from "../src/github/shell.ts";
import { installDom, scriptedFetch } from "./helpers.ts";

const c: MaintainConfig = { issue: "example/ops#4", authors: ["bot"] };
const TEXT = readFileSync(new URL("fixtures/maintain-digest.md", import.meta.url), "utf8");
const issue = (body: string, user = "bot"): RawIssue =>
  ({ number: 4, title: "Maintain digest", html_url: "https://github.com/example/ops/issues/4", body, comments: 0, user: { login: user } });
const comment = (id: number, body: string, user = "bot"): RawComment => ({ id, html_url: `https://github.com/example/ops/issues/4#issuecomment-${id}`, body, user: { login: user } });
const block = (o: unknown) => `\`\`\`agent-board-maintain-digest\n${JSON.stringify(o)}\n\`\`\`\n`;

test("the shipped configuration is off, so is the view, and an invalid one is refused", () => {
  assert.equal(MAINTAIN_CONFIG, undefined);
  assert.equal(maintainConfig(rawConfig), undefined);
  assert.equal(isView("maintain"), false);
  assert.deepEqual(maintainConfig(c), c);
  for (const bad of [{ ...c, issue: "" }, { ...c, issue: "x" }, { ...c, authors: [] }, { ...c, authors: ["a b"] }]) {
    assert.throws(() => maintainConfig(bad), /Invalid maintain configuration/);
  }
});

test("the fixture parses into its four sections, and the closer-look minutes add up", () => {
  const found = newestDigest(issue(TEXT), [], c);
  const d = found?.digest;
  assert.ok(d, found?.error);
  assert.equal(d.date, "2026-10-27");
  assert.deepEqual(d.approve.map((a) => [a.pr.number, a.reason]), [[7, "Dependency bump; CI green."], [8, "Typo fix in docs."]]);
  assert.deepEqual(d.waiting, [{ pr: { owner: "up", repo: "proj", number: 10 }, reply: "Thanks! Could you rebase on main and add a test?" }]);
  assert.deepEqual(d.stale.map((s) => s.reason), ["No activity in 90 days."]);
  assert.equal(closerMinutes(d), 65);
  assert.equal(DAY_MINUTES, 60);
  assert.equal(fileUrl(d.closer[0]!, d.closer[0]!.links[0]!), `https://github.com/up/proj/blob/${"3".repeat(40)}/src/lock.rs#L12-L30`);
  assert.equal(fileUrl(d.closer[1]!, d.closer[1]!.links[0]!), `https://github.com/other/lib/blob/${"4".repeat(40)}/src/lib.rs#L5`);
});

test("a malformed digest is refused with what is wrong", () => {
  const ok = { schema: DIGEST_SCHEMA, date: "2026-10-27" };
  assert.deepEqual(parseDigest(JSON.stringify(ok)), { date: "2026-10-27", approve: [], closer: [], waiting: [], stale: [] });
  for (const [bad, why] of [
    [{ ...ok, schema: "agent-board/maintain-digest/v2" }, /schema must be/],
    [{ ...ok, approve: [{ pr: "up/proj#7", head: "abc", reason: "r" }] }, /approve\[0\]: head must be/],
    [{ ...ok, approve: [{ pr: "proj#7", head: "1".repeat(40), reason: "r" }] }, /approve\[0\]: pr must be/],
    [{ ...ok, closer: [{ pr: "up/proj#7", head: "1".repeat(40), concern: "c", minutes: 0, links: [] }] }, /minutes must be/],
    [{ ...ok, closer: [{ pr: "up/proj#7", head: "1".repeat(40), concern: "c", minutes: 5, links: [{ path: "../x", start: 1 }] }] }, /path must be/],
    [{ ...ok, closer: [{ pr: "up/proj#7", head: "1".repeat(40), concern: "c", minutes: 5, links: [{ path: "a", start: 9, end: 2 }] }] }, /end must not be before start/],
  ] as const) {
    assert.throws(() => parseDigest(JSON.stringify(bad)), why);
  }
});

test("the newest digest by a configured author wins, and a broken newest one is not replaced by an older one", () => {
  const older = block({ schema: DIGEST_SCHEMA, date: "2026-10-26" });
  const newer = block({ schema: DIGEST_SCHEMA, date: "2026-10-27" });
  assert.equal(newestDigest(issue(older), [comment(1, newer)], c)?.digest?.date, "2026-10-27");
  // A stranger's comment is not read.
  assert.equal(newestDigest(issue(older), [comment(1, newer, "mallory")], c)?.digest?.date, "2026-10-26");
  const broken = newestDigest(issue(older), [comment(2, "```agent-board-maintain-digest\n{\n```\n")], c);
  assert.equal(broken?.digest, undefined);
  assert.match(broken?.error ?? "", /JSON/);
  assert.equal(newestDigest(issue("no digest"), [], c), undefined);
});

test("the digest is read from the issue and a bounded week of comments", async () => {
  const f = scriptedFetch((_m, url) => {
    if (url.endsWith("/repos/example/ops/issues/4")) return { body: issue("") };
    if (url.includes("/issues/4/comments?since=2026-10-20T00:00:00Z&per_page=100")) return { body: [comment(1, TEXT)] };
    return undefined;
  });
  const found = await loadDigest(new GitHub(async () => "t", f.fetchImpl), c, Date.parse("2026-10-27T15:00:00Z"));
  assert.equal(found?.digest?.approve.length, 2);
  const full = scriptedFetch((_m, url) => url.includes("/comments") ? { body: Array.from({ length: 100 }, (_, i) => comment(i, "")) } : { body: issue("") });
  await assert.rejects(loadDigest(new GitHub(async () => "t", full.fetchImpl), c), /100 or more comments/);
});

test("Approve selected approves at the assessed head, and skips a PR whose head moved or that closed", async () => {
  const d = newestDigest(issue(TEXT), [], c)!.digest!;
  const closed = { ...d.approve[0]!, pr: { ...d.approve[0]!.pr, number: 70 } };
  const f = scriptedFetch((m, url) => {
    if (m === "GET" && url.endsWith("/pulls/7")) return { body: { state: "open", head: { sha: "1".repeat(40) } } };
    if (m === "GET" && url.endsWith("/pulls/8")) return { body: { state: "open", head: { sha: "9".repeat(40) } } };
    if (m === "GET" && url.endsWith("/pulls/70")) return { body: { state: "closed", head: { sha: "1".repeat(40) } } };
    if (m === "POST" && url.endsWith("/pulls/7/reviews")) return { body: {} };
    return undefined;
  });
  const rs = await approveSelected(new GitHub(async () => "t", f.fetchImpl), [...d.approve, closed]);
  assert.deepEqual(rs.map((r) => [r.pr.number, r.status]), [[7, "approved"], [8, "skipped"], [70, "skipped"]]);
  assert.match(rs[1]!.note!, /head moved to 999999999999 since the digest assessed 222222222222/);
  const posts = f.calls.filter((call) => call.method === "POST");
  assert.deepEqual(posts.map((p) => [p.url, p.body]), [["https://api.github.com/repos/up/proj/pulls/7/reviews", { event: "APPROVE", commit_id: "1".repeat(40) }]]);
});

test("the view shows the four sections, links each PR into the PR pane, and totals the time", () => {
  installDom();
  const gh = new GitHub(async () => "t", scriptedFetch(() => undefined).fetchImpl);
  const el = document.createElement("div");
  el.append(...maintainView(gh, newestDigest(issue(TEXT), [], c), undefined));
  assert.deepEqual([...el.querySelectorAll("h3")].map((x) => x.textContent), ["Approve as a group", "Needs a closer look", "Waiting on the author", "Stale"]);
  assert.equal(el.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked").length, 2);
  assert.ok(el.querySelector("a[href='#pr/up/proj/9']"));
  assert.match(el.textContent ?? "", /65 of 60 minutes/);
  assert.ok(el.querySelector(".maintain-over"));
  assert.equal(el.querySelector(".maintain-reply")?.textContent, "Thanks! Could you rebase on main and add a test?");
});
