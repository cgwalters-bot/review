import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { mergeOrEnqueue } from "../src/github/merge.ts";
import { scriptedFetch } from "./helpers.ts";

const HEAD = "a".repeat(40);
const ref = { owner: "o", repo: "r", number: 1 };
const URL = "https://github.com/o/r/pull/1";
const ready = () => ({
  id: "PR_1", url: URL, headRefOid: HEAD, state: "OPEN", isDraft: false,
  viewerCanUpdate: true, mergeStateStatus: "CLEAN", isMergeQueueEnabled: false, mergeQueueEntry: null,
});

function client(over = {}, login = "cgwalters", mutation: "ok" | "error" | "network" | "http" = "ok", repository = {}) {
  const f = scriptedFetch((method, url) => {
    const body = f.calls.at(-1)!.body;
    if (url.endsWith("/user")) return { body: { login } };
    if (url.endsWith("/graphql") && (body as { query: string }).query.startsWith("query")) return { body: { data: { repository: {
      squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true, pullRequest: { ...ready(), ...over }, ...repository,
    } } } };
    if (mutation === "network") throw new Error("connection lost");
    if (mutation === "http") return { status: 403, body: { message: "Policy refused" } };
    if (url.endsWith("/graphql")) return { body: mutation === "error" ? { errors: [{ message: "head moved" }] } : { data: { enqueuePullRequest: { mergeQueueEntry: { id: "MQ_1" } } } } };
    if (method === "PUT" && url.endsWith("/merge")) return { body: { merged: mutation !== "error", message: "refused" } };
    return undefined;
  });
  return { gh: new GitHub(async () => "t", f.fetchImpl), calls: f.calls };
}

describe("head-bound Merge / enqueue", () => {
  it("reads policy fresh and merges with sha and a permitted method as the viewer", async () => {
    const { gh, calls } = client();
    let checks = 0;
    assert.deepEqual(await mergeOrEnqueue(gh, ref, HEAD, () => { checks++; }), { state: "merged", url: URL });
    assert.equal(checks, 2);
    assert.deepEqual(calls.map((c) => c.method), ["GET", "POST", "PUT"]);
    assert.deepEqual(calls.at(-1)!.body, { sha: HEAD, merge_method: "squash" });
  });

  it("enqueues with expectedHeadOid, including queues installed through rulesets", async () => {
    const { gh, calls } = client({ isMergeQueueEnabled: true, mergeStateStatus: "BLOCKED" });
    assert.deepEqual(await mergeOrEnqueue(gh, ref, HEAD, () => {}), { state: "enqueued", url: URL });
    assert.deepEqual(calls.at(-1)!.body && (calls.at(-1)!.body as { variables: unknown }).variables, { id: "PR_1", head: HEAD });
    assert.match((calls.at(-1)!.body as { query: string }).query, /expectedHeadOid:\$head/);
    assert.equal(calls.some((c) => c.method === "PUT"), false);
  });

  for (const over of [{ headRefOid: "b".repeat(40) }, { state: "CLOSED" }, { isDraft: true }, { viewerCanUpdate: false },
    { mergeStateStatus: "UNKNOWN" }, { mergeStateStatus: "UNSTABLE" }, { mergeStateStatus: "DIRTY" }, { mergeStateStatus: "BLOCKED" }]) {
    it(`sends no mutation for ${JSON.stringify(over)}`, async () => {
      const { gh, calls } = client(over);
      await assert.rejects(mergeOrEnqueue(gh, ref, HEAD, () => {}));
      assert.equal(calls.length, 2);
    });
  }

  it("refuses a different viewer before reading or writing the target", async () => {
    const { gh, calls } = client({}, "someone-else");
    await assert.rejects(mergeOrEnqueue(gh, ref, HEAD, () => {}));
    assert.equal(calls.length, 1);
  });

  it("rechecks publication policy after the preflight", async () => {
    const { gh, calls } = client();
    let checks = 0;
    await assert.rejects(mergeOrEnqueue(gh, ref, HEAD, () => { if (++checks === 2) throw new Error("ask changed"); }), /ask changed/);
    assert.equal(calls.length, 2);
  });

  it("does not write again when the confirmed head is already queued", async () => {
    const { gh, calls } = client({ isMergeQueueEnabled: true, mergeQueueEntry: { id: "MQ_1" } });
    assert.equal((await mergeOrEnqueue(gh, ref, HEAD, () => {})).state, "enqueued");
    assert.equal(calls.length, 2);
  });

  for (const queue of [false, true]) for (const failure of ["error", "network", "http"] as const) {
    it(`never retries a ${failure} ${queue ? "enqueue" : "merge"}`, async () => {
      const { gh, calls } = client({ isMergeQueueEnabled: queue }, "cgwalters", failure);
      await assert.rejects(mergeOrEnqueue(gh, ref, HEAD, () => {}), (e: Error) => {
        assert.equal(e.name === "MaybeSentError", failure === "network" || queue && failure === "error");
        return true;
      });
      assert.equal(calls.length, 3);
    });
  }
});
