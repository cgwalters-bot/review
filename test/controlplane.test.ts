import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run } from "../src/cli/controlplane.ts";
import type { Io } from "../src/cli/queue.ts";
import { usagePath } from "../src/github/usage.ts";
import { fixture, publishedTestHolds, scriptedFetch } from "./helpers.ts";

const API = "https://api.github.com";
// A few minutes after the Act now fixture's validation; the pass view is a day older.
const NOW = new Date("2026-11-06T12:05:00Z");

/** The pass's holds comment, carrying the Act now, pass view and repository board fixtures. */
function holdsComment(over: Record<string, unknown> = {}) {
  const needs_you = fixture<{ needs_you: unknown }>("act-now-needs-you.json").needs_you;
  const snapshot = {
    schema: "agent-board/holds/v1", at: "2026-11-06T12:00:00Z", holds: publishedTestHolds(needs_you), needs_you,
    pass_view: fixture<{ pass_view: unknown }>("pass-view.json").pass_view, dispatchable_work: fixture("dispatchable-work.json"), ...over,
  };
  return [{ user: { login: "cgwalters-bot" }, body: `<!-- agent-board-holds v1 -->\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`` }];
}

async function cli(argv: string[], comments: unknown = holdsComment()) {
  const { fetchImpl, calls } = scriptedFetch((method, url) => method === "GET" && url === `${API}${usagePath}` ? { body: comments } : undefined);
  let stdout = "";
  let stderr = "";
  const io: Io = { fetch: fetchImpl, token: async () => "t", stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), isTty: false, now: () => NOW };
  const status = await run(argv, io);
  return { status, stdout, stderr, calls, json: () => JSON.parse(stdout) };
}

describe("control-plane", () => {
  it("status: live agents, capacity and the last passes with no-start reasons", async () => {
    const r = await cli(["status"]);
    assert.equal(r.status, 0, r.stderr);
    const doc = r.json();
    assert.equal(doc.schema, "control-plane/v1");
    assert.equal(doc.command, "status");
    assert.equal(doc.stale, true);
    assert.deepEqual(doc.live[0], { state: "running", item: "example/work#11", kind: "implement", pool: "claude", startedAt: "2026-11-05T11:55:00Z", url: "https://github.com/example/work/issues/11", run: "https://github.com/example/runner/actions/runs/42" });
    assert.deepEqual(doc.live.slice(1).map((f: { url: string }) => f.url), ["https://github.com/example/work/pull/14", "https://github.com/example/work/pull/15"]);
    assert.deepEqual(doc.pools.map((p: { name: string }) => p.name), ["openai", "claude", "other"]);
    assert.deepEqual(doc.passes[0].noStart.map((n: { kind: string }) => n.kind), ["no-ready-work", "replan-delay", "capped", "held"]);
    assert.equal(doc.passes[1].started.length, 2);
    // Every request was a read of the one publication.
    assert.deepEqual(r.calls.map((c) => c.method), ["GET"]);
  });

  it("act-now: Home's shortlist, ranked by what it unblocks, with links", async () => {
    const r = await cli(["act-now"]);
    assert.equal(r.status, 0, r.stderr);
    const rows = r.json().rows as { key: string; unblocks: number; url: string; mergeRefusal: string | null }[];
    assert.deepEqual(rows.map((x) => [x.key, x.unblocks]), [["o/t#20", 63], ["o/t#30", 3], ["o/t#10", 1], ["o/a#1", 1]]);
    assert.ok(rows.every((x) => x.url.startsWith("https://github.com/o/")));
  });

  it("act-now: nothing from a list past its age bound", async () => {
    const needs_you = { ...fixture<{ needs_you: Record<string, unknown> }>("act-now-needs-you.json").needs_you, validated_at: "2026-11-06T09:00:00Z" };
    const r = await cli(["act-now"], holdsComment({ needs_you }));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json().rows, []);
  });

  it("repo: one repository's work, live runs and asks, case-insensitively", async () => {
    const r = await cli(["repo", "Example/Work"]);
    assert.equal(r.status, 0, r.stderr);
    const doc = r.json();
    assert.equal(doc.repository, "example/work");
    assert.equal(doc.work.count, 5);
    assert.equal(doc.work.items[0].url, "https://github.com/example/work/issues/8");
    assert.equal(doc.live.length, 3);
    assert.deepEqual(doc.asks, []);
    const unknown = (await cli(["repo", "o/t"])).json();
    assert.equal(unknown.work, null);
    assert.ok(unknown.asks.length > 0);
  });

  it("changes: passes and asks after --since", async () => {
    const r = await cli(["changes", "--since", "2026-11-05T11:52:00Z"]);
    assert.equal(r.status, 0, r.stderr);
    const doc = r.json();
    assert.deepEqual(doc.passes.map((p: { at: string }) => p.at), ["2026-11-05T12:00:00Z", "2026-11-05T11:55:00Z"]);
    assert.equal(doc.passesCovered, true);
    assert.ok(doc.asks.every((a: { waitingSince: string }) => a.waitingSince > "2026-11-05T11:52:00Z"));
    assert.equal((await cli(["changes", "--since=2026-01-01T00:00:00Z"])).json().passesCovered, false);
  });

  for (const [argv, why] of [[[], /a command is needed/], [["dispatch"], /unknown command/], [["repo"], /OWNER\/REPO/], [["repo", "a/b", "c"], /OWNER\/REPO/],
    [["changes"], /--since/], [["changes", "--since", "yesterday"], /--since/], [["status", "x"], /no arguments/]] as const) {
    it(`refuses ${JSON.stringify(argv)} as usage`, async () => {
      const r = await cli([...argv]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, why);
      assert.equal(r.calls.length, 0);
    });
  }

  it("fails, naming why, without a usable publication", async () => {
    const none = await cli(["status"], []);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no hold snapshot/);
    const bad = await cli(["status"], holdsComment({ pass_view: { schema: "nope" } }));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /pass view can't be used/);
  });

  it("hands queue to review-queue", async () => {
    const r = await cli(["queue", "--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage: review-queue/);
  });
});
