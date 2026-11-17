import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findMaintainerReports, parseMaintainerReport, repositoriesView, REPORT_SCHEMA } from "../src/github/repositories.ts";
import { loadPassPublications } from "../src/github/holds.ts";
import { BOT_LOGIN } from "../src/github/config.ts";
import type { GitHub } from "../src/github/api.ts";
import { fixture, installDom } from "./helpers.ts";

installDom();
const snapshot = () => fixture<Record<string, any>>("maintainer-report.json");
const now = Date.parse("2026-11-05T12:00:00Z");
const comment = (raw: unknown = snapshot()) => ({ id: 42, user: { login: BOT_LOGIN }, body: `<!-- agent-board-maintainer-report -->\n\n\`\`\`${REPORT_SCHEMA}\n${JSON.stringify(raw)}\n\`\`\`` });

describe("maintainer report publication", () => {
  it("replays published-schema fixture through the existing comment read without a holds snapshot", async () => {
    let reads = 0;
    const gh = { get: async () => { reads++; return { data: [comment()] }; } } as unknown as GitHub;
    const result = await loadPassPublications(gh);
    assert.equal(reads, 1);
    assert.equal(result.holds, undefined);
    const el = repositoriesView(result.repositories, now);
    assert.equal(el.querySelectorAll("article").length, 2);
    for (const s of ["example/project", "2026-11-05T12:00:00Z", "preview", "wait: 1", "merge: 1", "Needs you: 1", "Please review", "Merge-queue depth: 2", "Merge-queue depth: unknown (repository undecided", "inventory unread/undecided"]) assert.ok(el.textContent?.includes(s), s);
    assert.ok(el.querySelector("a[href$='#issuecomment-42']"));
    assert.ok(el.querySelector("a[href='https://github.com/example/project/pull/12']"));
    assert.equal(el.querySelector("button, input"), null);
  });

  it("uses the newest run once per repository and marks the exact stale boundary", () => {
    const old = snapshot();
    old.generated_at = "2026-11-05T11:00:00Z";
    const fresh = snapshot();
    fresh.mode = "apply";
    const blocks = findMaintainerReports([comment(fresh), comment(old)]);
    assert.equal(repositoriesView(blocks, now).querySelectorAll("article").length, 2);
    assert.match(repositoriesView(blocks, now).textContent!, /apply/);
    assert.doesNotMatch(repositoriesView(blocks, now + 7_200_000).textContent!, /stale/);
    assert.match(repositoriesView(blocks, now + 7_200_001).textContent!, /stale/);
    assert.match(repositoriesView(blocks, now - 60_001).textContent!, /future/);
    assert.match(repositoriesView(blocks, now, "HTTP 503").textContent!, /last read, not current/);
  });

  it("ignores unknown fields and renders hostile prose only as text", () => {
    const raw = snapshot();
    raw.needs_human[0].reason = '<img src=x onerror="alert(1)">';
    raw.url = "https://invalid.example/";
    const el = repositoriesView(findMaintainerReports([comment(raw)]), now);
    assert.match(el.textContent!, /<img/);
    assert.equal(el.querySelector("img, script, [onerror], a[href*='invalid']"), null);
    assert.deepEqual(findMaintainerReports([{ ...comment(), user: { login: "stranger" } }]), []);
  });

  it("shows invalid blocks as errors alongside valid rows, not as missing reports", () => {
    for (const body of ["```agent-board/maintainer-report/v1\n{bad\n```", "no fence", "x".repeat(60_001)]) {
      const blocks = findMaintainerReports([comment(), { ...comment(), body: `<!-- agent-board-maintainer-report -->\n${body}` }]);
      const el = repositoriesView(blocks, now);
      assert.equal(el.querySelectorAll("article.warn").length, 1);
      assert.equal(el.querySelectorAll("article").length, 3);
    }
    assert.match(repositoriesView([], now).textContent!, /not published/);
  });

  it("shows queue depth only for a published queue of a decided repository", () => {
    const depth = (raw: Record<string, any>, repository = "example/project") => {
      const row = [...repositoriesView(findMaintainerReports([comment(raw)]), now).querySelectorAll("article")]
        .find((a) => a.querySelector("h3")?.textContent?.startsWith(repository));
      return [...row!.querySelectorAll("p")].map((p) => p.textContent!).find((t) => t.startsWith("Merge-queue depth: "))?.slice(19);
    };
    const cases: [string, (r: any) => void, string, string?][] = [
      ["populated, with nullable entry fields", () => {}, "2"],
      ["empty", (r) => { r.merge_queues["example/project"] = []; }, "0"],
      ["an older producer", (r) => { delete r.merge_queues; }, "unknown (not published by this producer)."],
      ["a missing repository key", (r) => { r.merge_queues = {}; }, "unknown (not published for this repository)."],
      ["an unread queue", (r) => { r.merge_queues["example/project"] = null; r.errors = 1; }, "unknown (queue unread; counted in poll errors)."],
      ["an undecided repository", (r) => { r.merge_queues["example/unread"] = []; }, "unknown (repository undecided this pass).", "example/unread"],
      ["queue removal events alone", (r) => { r.merge_queues = {}; r.merge_queue_events.push(r.merge_queue_events[0]); }, "unknown (not published for this repository)."],
    ];
    for (const [name, mutate, want, repository] of cases) {
      const raw = snapshot();
      mutate(raw);
      assert.equal(depth(raw, repository), want, name);
    }
    const unread = snapshot();
    unread.merge_queues["example/project"] = null;
    unread.errors = 1;
    const warned = repositoriesView(findMaintainerReports([comment(unread)]), now + 7_200_001, "HTTP 503").textContent!;
    for (const s of ["last read, not current", "stale (over two hours)", "Poll errors: 1"]) assert.ok(warned.includes(s), s);
  });

  it("renders hostile queue fields only as a count", () => {
    const raw = snapshot();
    raw.merge_queues["example/project"][0].state = '<img src=x onerror="alert(1)">';
    raw.merge_queues["example/project"][0].head = "https://invalid.example/";
    const el = repositoriesView(findMaintainerReports([comment(raw)]), now);
    assert.match(el.textContent!, /Merge-queue depth: 2/);
    assert.doesNotMatch(el.textContent!, /<img|invalid\.example/);
    assert.equal(el.querySelector("img, script, [onerror], a[href*='invalid']"), null);
  });

  it("rejects malformed required fields and bounded inventories", () => {
    const mutations = [
      (r: any) => { delete r.needs_human; },
      (r: any) => { r.mode = "execute"; },
      (r: any) => { r.generated_at = "yesterday"; },
      (r: any) => { r.repositories = ["../project"]; },
      (r: any) => { r.repositories.push(r.repositories[0]); },
      (r: any) => { r.repositories = Array(1001).fill("example/project"); },
      (r: any) => { r.pull_requests.wait[0].number = -1; },
      (r: any) => { r.pull_requests.wait[0].ran = "yes"; },
      (r: any) => { r.pull_requests.wait[0].reason = "x".repeat(4097); },
      (r: any) => { r.needs_human[0].repository = "elsewhere/project"; },
      (r: any) => { r.merge_queue_events[0].event.created_at = "invalid"; },
      (r: any) => { r.errors = -1; },
      (r: any) => { r.merge_queues = []; },
      (r: any) => { r.merge_queues = null; },
      (r: any) => { r.merge_queues["elsewhere/project"] = []; },
      (r: any) => { r.merge_queues["Example/Project"] = []; },
      (r: any) => { r.merge_queues["example/project"] = {}; },
      (r: any) => { r.merge_queues["example/project"][0].number = 0; },
      (r: any) => { r.merge_queues["example/project"][0].head = 1; },
      (r: any) => { r.merge_queues["example/project"][0].position = 1.5; },
      (r: any) => { r.merge_queues["example/project"][0].state = "x".repeat(4097); },
      (r: any) => { r.merge_queues["example/project"][0] = null; },
      (r: any) => { r.merge_queues["example/project"] = Array(1001).fill(r.merge_queues["example/project"][0]); },
      (r: any) => {
        r.repositories.push("example/other");
        r.merge_queues["example/unread"] = Array(600).fill(r.merge_queues["example/project"][0]);
        r.merge_queues["example/other"] = Array(401).fill(r.merge_queues["example/project"][0]);
      },
    ];
    for (const mutate of mutations) {
      const raw = snapshot();
      mutate(raw);
      assert.equal(typeof parseMaintainerReport(raw), "string");
    }
  });
});
