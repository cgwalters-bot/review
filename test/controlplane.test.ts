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

type Route = Parameters<typeof scriptedFetch>[0];

async function cli(argv: string[], comments: unknown = holdsComment(), route: Route = () => undefined) {
  const { fetchImpl, calls } = scriptedFetch((method, url, headers) => method === "GET" && url === `${API}${usagePath}` ? { body: comments } : route(method, url, headers));
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

  for (const [argv, why] of [[[], /a command is needed/], [["fold"], /unknown command/], [["repo"], /OWNER\/REPO/], [["repo", "a/b", "c"], /OWNER\/REPO/],
    [["changes"], /--since/], [["changes", "--since", "yesterday"], /--since/], [["status", "x"], /no arguments/],
    [["cancel", "42"], /--dry-run or --yes/], [["cancel", "42", "--dry-run", "--yes"], /--dry-run or --yes/], [["cancel", "--dry-run"], /needs one RUN/],
    [["retry", "x", "--yes"], /needs one RUN/], [["run-pass", "--yes", "now"], /no arguments/], [["run-pass", "--yes", "--kind", "fix"], /takes no --kind/],
    [["dispatch", "o/r", "--kind", "fix", "--brief", "b", "--yes"], /OWNER\/REPO#N/], [["dispatch", "o/r#1", "--brief", "b", "--yes"], /needs --kind/],
    [["dispatch", "o/r#1", "--kind", "fix", "--kind", "fix", "--brief", "b", "--yes"], /given twice/],
    [["file", "--title", "t", "--yes"], /--epic N/], [["file", "--epic", "3", "--yes"], /needs --title/]] as const) {
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

  describe("act commands", () => {
    const RUN = `${API}/repos/example/runner/actions/runs/42`;
    const operator: Route = (method, url) => method === "GET" && url === `${API}/user` ? { body: { login: "cgwalters" } } : undefined;
    const liveRun: Route = (method, url) => operator(method, url, {}) ?? (method === "GET" && url === RUN
      ? { body: { id: 42, html_url: "https://github.com/example/runner/actions/runs/42", repository: { full_name: "example/runner" }, status: "in_progress" } }
      : method === "POST" && url === `${RUN}/cancel` ? { status: 202 } : undefined);
    const posts = (calls: { method: string }[]) => calls.filter((c) => c.method !== "GET");

    it("cancel --dry-run reads the run fresh and sends nothing", async () => {
      const r = await cli(["cancel", "https://github.com/example/runner/actions/runs/42", "--dry-run"], holdsComment(), liveRun);
      assert.equal(r.status, 0, r.stderr);
      const doc = r.json();
      assert.equal(doc.dryRun, true);
      assert.equal(doc.item, "example/work#11");
      assert.deepEqual(doc.wouldSend, [{ method: "POST", url: `${RUN}/cancel` }]);
      assert.deepEqual(posts(r.calls), []);
    });

    it("cancel --yes sends the cancel", async () => {
      const r = await cli(["cancel", "42", "--yes"], holdsComment(), liveRun);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.json().sent, [{ method: "POST", url: `${RUN}/cancel` }]);
      assert.deepEqual(posts(r.calls).map((c) => c.method), ["POST"]);
    });

    it("refuses a run the pass view doesn't list, before any request but the snapshot's", async () => {
      const r = await cli(["retry", "43", "--yes"], holdsComment(), liveRun);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /lists no run 43/);
      assert.equal(r.calls.length, 1);
    });

    it("dispatch comments a job plan on an open item", async () => {
      const route: Route = (method, url) => operator(method, url, {})
        ?? (method === "GET" && url === `${API}/repos/example/work/issues/8` ? { body: { state: "open", html_url: "https://github.com/example/work/issues/8" } } : undefined);
      const r = await cli(["dispatch", "example/work#8", "--kind", "implement", "--pool=claude", "--brief", "Fix it.", "--dry-run"], holdsComment(), route);
      assert.equal(r.status, 0, r.stderr);
      const [write] = r.json().wouldSend;
      assert.equal(write.url, `${API}/repos/example/work/issues/8/comments`);
      const plan = JSON.parse(/```agent-board-plan\n([\s\S]*)\n```/.exec(write.body.body)![1]!);
      assert.deepEqual(plan, { schema: "agent-board/job-plan/v1", repo: "example/work", item: 8, kind: "implement", runner: "hosted", pool: "claude", brief: "Fix it." });
      assert.deepEqual(posts(r.calls), []);
      for (const [argv, why] of [[["example/work#11", "--kind", "fix"], /lists example\/work#11 running/], [["example/work#8", "--kind", "deploy"], /not a valid/]] as const) {
        const refused = await cli(["dispatch", ...argv, "--brief", "b", "--yes"], holdsComment(), route);
        assert.equal(refused.status, 1);
        assert.match(refused.stderr, why);
        assert.deepEqual(posts(refused.calls), []);
      }
    });

    it("run-pass --dry-run checks for an active pass and shows the dispatch", async () => {
      const resets = new Date(Date.now() + 3_600_000).toISOString();
      const pass_view = { ...fixture<{ pass_view: Record<string, unknown> }>("pass-view.json").pass_view, observed_at: new Date().toISOString(),
        pools: [{ name: "openai", used_percent: 10, allowed_percent: 60, resets_at: resets, ready: 0, under_pace: true }] };
      const tracker = `${API}/repos/cgwalters-forge/tracker`;
      const route: Route = (method, url) => operator(method, url, {}) ?? (method !== "GET" ? undefined
        : url === tracker ? { body: { default_branch: "main", permissions: { push: true } } }
          : url.startsWith(`${tracker}/actions/workflows/poll.yml/runs?`) ? { body: { total_count: 0, workflow_runs: [] } } : undefined);
      const r = await cli(["run-pass", "--dry-run"], holdsComment({ pass_view }), route);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.json().wouldSend, [{ method: "POST", url: `${tracker}/actions/workflows/poll.yml/dispatches`, body: { ref: "main", inputs: { apply: "true" }, return_run_details: true } }]);
      const refused = await cli(["run-pass", "--yes"], holdsComment(), route);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /stale/);
    });

    it("file searches for duplicates, then files under the epic", async () => {
      const tracker = `${API}/repos/cgwalters-forge/tracker`;
      const route = (found: string): Route => (method, url) => method !== "GET" ? undefined
        : url.startsWith(`${API}/search/issues?`) ? { body: { items: [{ title: found, html_url: "https://github.com/cgwalters-forge/tracker/issues/5" }] } }
          : url === `${tracker}/issues/3` ? { body: { state: "open", labels: [{ name: "epic" }] } } : undefined;
      const argv = ["file", "--epic", "3", "--title", "Add fold", "--label", "infra", "--dry-run"];
      const r = await cli(argv, holdsComment(), route("Add fold to the CLI"));
      assert.equal(r.status, 0, r.stderr);
      const doc = r.json();
      assert.deepEqual(doc.similar, [{ title: "Add fold to the CLI", url: "https://github.com/cgwalters-forge/tracker/issues/5" }]);
      assert.equal(doc.url, null);
      assert.deepEqual(doc.wouldSend[0], { method: "POST", url: `${tracker}/issues`, body: { title: "Add fold", body: "", labels: ["needs-triage", "infra"] } });
      assert.equal(doc.wouldSend[1].url, `${tracker}/issues/3/sub_issues`);
      assert.match(decodeURIComponent(r.calls.find((c) => c.url.includes("/search/"))!.url), /repo:cgwalters-forge\/tracker is:issue is:open in:title "Add fold"/);
      const dup = await cli(argv, holdsComment(), route("add fold"));
      assert.equal(dup.status, 1);
      assert.match(dup.stderr, /issues\/5 is open with this title/);
    });
  });

  it("hands queue to review-queue", async () => {
    const r = await cli(["queue", "--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage: review-queue/);
  });
});
