import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { DECISIONS_CONFIG, answerDocument, documentView, parseDocument, refreshDocument, sendDocumentAnswer } from "../src/github/decisiondocument.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const body = "### D12 Enable scheduler? (P0, blocks example/work#3)\nContext.\n- [ ] A) Yes ← recommended: ready\n- [ ] B) Wait\n\nReply:\n\n### D13 Another?\n- [ ] A) Yes\n- [ ] B) No\nReply:\n\n## Done\n### D1 Old\nOutcome: kept\n";
const path = "/repos/example/private/issues/8";

test("site configuration enables a valid document and retains legacy questions", () => {
  assert.ok(DECISIONS_CONFIG.document);
  assert.match(DECISIONS_CONFIG.document.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.equal(DECISIONS_CONFIG.document.number, 1);
  assert.equal(DECISIONS_CONFIG.legacyQuestions, true);
});

test("render document and submit tick and reply through viewer client", async () => {
  const calls: string[] = [];
  let written = "";
  const gh = new GitHub(async () => "viewer-token", async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer viewer-token");
    calls.push(`${init?.method} ${url}`);
    if (init?.method === "PATCH") written = JSON.parse(String(init.body)).body;
    return new Response(JSON.stringify({ body }), { status: 200 });
  });
  const slot = document.createElement("div");
  await refreshDocument(gh, slot, { repo: "example/private", number: 8 });
  assert.equal(calls.length, 1);
  assert.match(slot.textContent!, /recommended: ready/);
  assert.equal(slot.querySelector("details")?.open, false);
  const form = slot.querySelector("form")!;
  form.querySelector<HTMLInputElement>('input[value="B"]')!.checked = true;
  form.querySelector<HTMLInputElement>('input[type="text"]')!.value = "Not today";
  form.dispatchEvent(new win.Event("submit", { cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(written, /\[x\] B\) Wait/);
  assert.match(written, /Reply: Not today/);
  assert.equal(written.slice(written.indexOf("### D13")), body.slice(body.indexOf("### D13")));
  assert.equal(calls.length, 3);
});

test("concurrent edit refuses PATCH", async () => {
  let calls = 0;
  const gh = new GitHub(async () => "token", async () => {
    calls++;
    return new Response(JSON.stringify({ body: body + "other edit" }));
  });
  await assert.rejects(sendDocumentAnswer(gh, path, body, "D12", "A", "yes"), /changed, reload/);
  assert.equal(calls, 1);
});

test("404 explains private repository access", async () => {
  const gh = new GitHub(async () => "token", async () => new Response("{}", { status: 404 }));
  const slot = document.createElement("div");
  await refreshDocument(gh, slot, { repo: "example/private", number: 8 });
  assert.match(slot.textContent!, /private.*viewer.*no access/);
});

test("reject ambiguous ids, answered entries, done edits and multiline replies", () => {
  assert.throws(() => parseDocument(body + "### D12 duplicate\n"), /Duplicate/);
  assert.throws(() => answerDocument(body, "D1", "A", ""));
  assert.throws(() => answerDocument(body, "D12", "C", ""));
  assert.throws(() => answerDocument(body, "D12", "A", "x\n### D9 Inject"));
  assert.throws(() => answerDocument(body.replace("[ ]", "[x]"), "D12", "A", ""));
  assert.equal(documentView(body, async () => {}).querySelectorAll("form").length, 2);
});

test("fenced examples stay untouched and duplicate option letters are refused", () => {
  const example = "```md\n### D99 Example\n- [ ] A) Example\nReply: example\n```\n";
  const source = body.replace("Context.\n", "Context.\n" + example);
  assert.equal(parseDocument(source)[0]!.options.length, 2);
  assert.ok(answerDocument(source, "D12", "A", "ok").includes(example));
  assert.throws(() => parseDocument(body.replace("B) Wait", "A) Wait")), /Duplicate option/);
});

test("sequential answers share the latest baseline and refresh preserves only unsent drafts", async () => {
  let server = body;
  let fail = false;
  const gh = new GitHub(async () => "token", async (_, init) => {
    if (fail) return new Response("{}", { status: 500 });
    if (init?.method === "PATCH") server = JSON.parse(String(init.body)).body;
    return new Response(JSON.stringify({ body: server }));
  });
  const slot = document.createElement("div");
  const target = { repo: "example/private", number: 8 };
  await refreshDocument(gh, slot, target);
  for (const form of slot.querySelectorAll("form")) {
    form.querySelector<HTMLInputElement>('input[type="radio"]')!.checked = true;
    form.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(form.textContent!, /Answered/);
  }
  await refreshDocument(gh, slot, target);
  assert.equal(slot.querySelectorAll("form").length, 0);
  fail = true;
  await refreshDocument(gh, slot, target);
  assert.match(slot.textContent!, /500/);
  fail = false;
  await refreshDocument(gh, slot, target);
  assert.doesNotMatch(slot.textContent!, /500/);
  server = body;
  await refreshDocument(gh, slot, target);
  slot.querySelector<HTMLInputElement>('input[type="text"]')!.value = "draft";
  server = body.replace("Context.", "Changed context.");
  await refreshDocument(gh, slot, target);
  assert.doesNotMatch(slot.textContent!, /Changed context/);
  await refreshDocument(gh, slot, target, true);
  assert.match(slot.textContent!, /Changed context/);
});

test("overlapping answers from different forms are serialized and both kept", async () => {
  let server = body;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  let gets = 0;
  const gh = new GitHub(async () => "token", async (_, init) => {
    if (init?.method === "PATCH") server = JSON.parse(String(init.body)).body;
    else if (++gets === 2) await barrier;
    return new Response(JSON.stringify({ body: server }));
  });
  const slot = document.createElement("div");
  await refreshDocument(gh, slot, { repo: "example/private", number: 8 });
  const forms = [...slot.querySelectorAll("form")];
  for (const form of forms) {
    form.querySelector<HTMLInputElement>('input[type="radio"]')!.checked = true;
    form.dispatchEvent(new win.Event("submit", { cancelable: true }));
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gets, 2);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const form of forms) assert.match(form.textContent!, /Answered/);
  assert.equal(parseDocument(server).filter((e) => e.options.some((o) => o.checked)).length, 2);
});
