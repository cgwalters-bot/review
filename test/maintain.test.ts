import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import rawConfig from "../src/github/maintain-config.json" with { type: "json" };
import { GitHub } from "../src/github/api.ts";
import {
  approveSelected, closerMinutes, DAY_MINUTES, DIGEST_SCHEMA, digestIsStale, fileUrl, loadDigest, MAINTAIN_CONFIG, maintainConfig, newestDigest, parseDigest, type MaintainConfig,
} from "../src/github/maintain.ts";
import { approveGroup, maintainView } from "../src/github/maintainview.ts";
import type { RawComment, RawIssue } from "../src/github/reviewdrafts.ts";
import { isView } from "../src/github/shell.ts";
import { installDom, scriptedFetch } from "./helpers.ts";

const c: MaintainConfig = { issue: "example/ops#4", authors: ["bot"] };
const TEXT = readFileSync(new URL("fixtures/maintain-digest.md", import.meta.url), "utf8");
const issue = (body: string, user = "bot"): RawIssue =>
  ({ number: 4, title: "Maintain digest", html_url: "https://github.com/example/ops/issues/4", body, comments: 0, user: { login: user } });
const comment = (id: number, body: string, user = "bot"): RawComment => ({ id, html_url: `https://github.com/example/ops/issues/4#issuecomment-${id}`, body, user: { login: user } });
const block = (o: unknown) => `\`\`\`agent-board-maintain-digest\n${JSON.stringify(o)}\n\`\`\`\n`;

test("the shipped configuration reads tracker#965, an empty one is off, and an invalid one is refused", () => {
  assert.deepEqual(MAINTAIN_CONFIG, { issue: "cgwalters-forge/tracker#965", authors: ["cgwalters-bot"] });
  assert.deepEqual(maintainConfig(rawConfig), MAINTAIN_CONFIG);
  assert.equal(isView("maintain"), true);
  assert.equal(maintainConfig({ issue: "", authors: [] }), undefined);
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
    [{ ...ok, date: "2026-02-30" }, /calendar date/],
    [{ ...ok, date: "2026-13-01" }, /calendar date/],
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
    if (url.endsWith("/user")) return { body: { login: "operator" } };
    if (url.includes("/reviews?per_page=100")) return { body: [] };
    if (url.endsWith("/repos/example/ops/issues/4")) return { body: issue("") };
    if (url.includes("/issues/4/comments?since=2026-10-20T00:00:00Z&per_page=100")) return { body: [comment(1, TEXT)] };
    return undefined;
  });
  const found = await loadDigest(new GitHub(async () => "t", f.fetchImpl), c, Date.parse("2026-10-27T15:00:00Z"));
  assert.equal(found?.digest?.approve.length, 2);
  const full = scriptedFetch((_m, url) => url.includes("/comments") ? { body: Array.from({ length: 100 }, (_, i) => comment(i, "")) } : { body: issue("") });
  await assert.rejects(loadDigest(new GitHub(async () => "t", full.fetchImpl), c), /100 or more comments/);
});

test("digest date outranks text order, with newer comments and later blocks breaking ties", () => {
  const dated = (date: string) => block({ schema: DIGEST_SCHEMA, date });
  const today = dated("2026-10-27");
  const yesterday = dated("2026-10-26");
  const found = newestDigest(issue(today), [comment(1, yesterday)], c)!;
  assert.equal(found.digest?.date, "2026-10-27");
  assert.equal(found.url, issue("").html_url);
  assert.equal(newestDigest(issue(yesterday + today + yesterday), [], c)?.digest?.date, "2026-10-27");
  const tied = newestDigest(issue(today), [comment(3, today), comment(2, today)], c)!;
  assert.equal(tied.url, comment(3, "").html_url);
  const first = { schema: DIGEST_SCHEMA, date: "2026-10-27", stale: [{ pr: "up/proj#1", reason: "first" }] };
  const last = { ...first, stale: [{ pr: "up/proj#1", reason: "last" }] };
  assert.equal(newestDigest(issue(block(first) + block(last)), [], c)?.digest?.stale[0]?.reason, "last");
  assert.equal(newestDigest(issue(today), [comment(4, dated("2099-01-01"), "mallory")], c)?.digest?.date, "2026-10-27");
});

test("today and yesterday are current UTC days; older digests visibly warn with their date", () => {
  installDom();
  const now = Date.parse("2026-10-27T23:59:00Z");
  for (const [date, stale] of [["2026-10-27", false], ["2026-10-26", false], ["2026-10-25", true]] as const) {
    assert.equal(digestIsStale(date, now), stale);
    const found = newestDigest(issue(block({ schema: DIGEST_SCHEMA, date })), [], c)!;
    found.stale = digestIsStale(date, now);
    const el = document.createElement("div");
    el.append(...maintainView(found, undefined));
    assert.match(el.textContent!, new RegExp(`Digest of ${date}`));
    assert.equal(!!el.querySelector("[role=alert]"), stale);
    if (stale) assert.match(el.textContent!, /Warning: this digest is more than a day old/);
  }
  assert.equal(digestIsStale("2026-10-25", Date.parse("2026-10-27T00:00:00Z")), true);
});

test("loading reviews leaves only the signed-in viewer's approvals at the assessed head unticked", async () => {
  installDom();
  const f = scriptedFetch((m, url) => {
    assert.equal(m, "GET");
    if (url.endsWith("/repos/example/ops/issues/4")) return { body: issue(TEXT) };
    if (url.includes("/issues/4/comments?")) return { body: [] };
    if (url.endsWith("/user")) return { body: { login: "Operator" } };
    if (url.includes("/pulls/7/reviews?per_page=100")) return { body: [
      { user: { login: "operator" }, state: "APPROVED", commit_id: "1".repeat(40) },
      { user: { login: "operator" }, state: "COMMENTED", commit_id: "1".repeat(40) },
    ] };
    if (url.includes("/pulls/8/reviews?per_page=100")) return { body: [
      { user: { login: "someone-else" }, state: "APPROVED", commit_id: "2".repeat(40) },
      { user: { login: "operator" }, state: "APPROVED", commit_id: "9".repeat(40) },
    ] };
    return undefined;
  });
  const gh = new GitHub(async () => "t", f.fetchImpl);
  for (let reload = 0; reload < 2; reload++) {
    const found = await loadDigest(gh, c);
    assert.deepEqual(found!.digest!.approve.map((it) => it.approved), [true, false]);
    const el = approveGroup(found!.digest!, (items) => approveSelected(gh, items));
    const boxes = [...el.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    assert.deepEqual(boxes.map((b) => [b.checked, b.disabled]), [[false, true], [true, false]]);
    assert.match(el.textContent!, /Already approved at the assessed head/);
    const before = f.calls.length;
    assert.equal((await approveSelected(gh, [found!.digest!.approve[0]!]))[0]!.status, "skipped");
    assert.equal(f.calls.length, before);
  }
});

test("dismissed or superseded approvals do not count; incomplete review reads are refused", async () => {
  for (const state of ["DISMISSED", "CHANGES_REQUESTED", "FULL", "ERROR"]) {
    const f = scriptedFetch((m, url) => {
      assert.equal(m, "GET");
      if (url.endsWith("/repos/example/ops/issues/4")) return { body: issue(TEXT) };
      if (url.includes("/issues/4/comments?")) return { body: [] };
      if (url.endsWith("/user")) return { body: { login: "operator" } };
      if (url.includes("/reviews?")) {
        if (state === "ERROR") return { status: 403, body: {} };
        const review = { user: { login: "operator" }, state: "APPROVED", commit_id: "1".repeat(40) };
        return { body: state === "FULL" ? Array(100).fill(review) : [review, { ...review, state }] };
      }
      return undefined;
    });
    const read = loadDigest(new GitHub(async () => "t", f.fetchImpl), c);
    if (state === "FULL" || state === "ERROR") await assert.rejects(read, state === "FULL" ? /100 or more reviews/ : /403/);
    else assert.equal((await read)!.digest!.approve[0]!.approved, false);
  }
});

test("a successful approval stays unticked across source refreshes while GitHub's reviews lag", async () => {
  installDom();
  const f = scriptedFetch((m, url) => {
    if (url.endsWith("/repos/example/ops/issues/4")) return { body: issue(TEXT) };
    if (url.includes("/issues/4/comments?")) return { body: [] };
    if (url.endsWith("/user")) return { body: { login: "operator" } };
    if (url.includes("/reviews?per_page=100")) return { body: [] };
    if (m === "GET" && url.endsWith("/pulls/7")) return { body: { state: "open", head: { sha: "1".repeat(40) } } };
    if (m === "POST" && url.endsWith("/pulls/7/reviews")) return { body: {} };
    return undefined;
  });
  const gh = new GitHub(async () => "t", f.fetchImpl);
  const first = await loadDigest(gh, c);
  assert.equal((await approveSelected(gh, [first!.digest!.approve[0]!]))[0]!.status, "approved");
  const refreshed = await loadDigest(gh, c);
  assert.equal(refreshed!.digest!.approve[0]!.approved, true);
  const el = approveGroup(refreshed!.digest!, (items) => approveSelected(gh, items));
  assert.equal(el.querySelector<HTMLInputElement>("input")!.checked, false);
  const before = f.calls.length;
  const copy = { ...first!.digest!.approve[0]!, approved: false };
  assert.equal((await approveSelected(gh, [copy]))[0]!.status, "skipped");
  assert.equal(f.calls.length, before);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
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
  const before = f.calls.length;
  const again = await approveSelected(new GitHub(async () => "t", f.fetchImpl), [d.approve[0]!]);
  assert.equal(again[0]!.status, "skipped");
  assert.equal(f.calls.length, before);
  installDom();
  const el = approveGroup(d, (items) => approveSelected(new GitHub(async () => "t", f.fetchImpl), items));
  assert.equal(el.querySelector<HTMLInputElement>("input")!.checked, false);
  assert.match(el.textContent!, /Already approved at the assessed head/);
});

test("the view shows three sections, leaves Approve as a group to the Inbox, links each PR into the PR pane, and totals the time", () => {
  installDom();
  const found = newestDigest(issue(TEXT), [], c)!;
  const el = document.createElement("div");
  el.append(...maintainView(found, undefined));
  assert.deepEqual([...el.querySelectorAll("h3")].map((x) => x.textContent), ["Needs a closer look", "Waiting on the author", "Stale"]);
  assert.equal(el.querySelectorAll("input").length, 0);
  assert.match(el.textContent!, /2 to approve as a group are on the Inbox/);
  assert.equal(approveGroup(found.digest!, async () => []).querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked").length, 2);
  assert.ok(el.querySelector("a[href='#pr/up/proj/9']"));
  assert.match(el.textContent ?? "", /65 of 60 minutes/);
  assert.ok(el.querySelector(".maintain-over"));
  assert.equal(el.querySelector(".maintain-reply")?.textContent, "Thanks! Could you rebase on main and add a test?");
});

test("the shipped issue without a digest yet shows the empty state, not an error", async () => {
  installDom();
  const f = scriptedFetch((_m, url) => {
    if (url.endsWith("/repos/cgwalters-forge/tracker/issues/965")) return { body: { ...issue("A daily digest of incoming PRs.", "cgwalters-bot"), number: 965 } };
    if (url.includes("/repos/cgwalters-forge/tracker/issues/965/comments?")) return { body: [] };
    return undefined;
  });
  const gh = new GitHub(async () => "t", f.fetchImpl);
  const found = await loadDigest(gh, MAINTAIN_CONFIG!);
  assert.equal(found, undefined);
  const el = document.createElement("div");
  el.append(...maintainView(found, undefined));
  assert.equal(el.textContent, "No digest posted yet.");
});
