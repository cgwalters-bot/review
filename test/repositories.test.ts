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
    for (const s of ["example/project", "2026-11-05T12:00:00Z", "preview", "wait: 1", "merge: 1", "Needs you: 1", "Please review", "Merge-queue depth: unknown", "inventory unread/undecided"]) assert.ok(el.textContent?.includes(s), s);
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
    ];
    for (const mutate of mutations) {
      const raw = snapshot();
      mutate(raw);
      assert.equal(typeof parseMaintainerReport(raw), "string");
    }
  });
});
