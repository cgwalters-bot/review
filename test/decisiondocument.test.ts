import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { DECISIONS_CONFIG, answerDocument, documentView, parseDocument, refreshDocument, sendDocumentAnswer, toggleDocument } from "../src/github/decisiondocument.ts";
import { createRenderer } from "../src/markdown.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
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
  await refreshDocument(gh, slot, render, { repo: "example/private", number: 8 });
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
  await refreshDocument(gh, slot, render, { repo: "example/private", number: 8 });
  assert.match(slot.textContent!, /private.*viewer.*no access/);
});

test("reject ambiguous ids, answered entries, done edits and multiline replies", () => {
  assert.throws(() => parseDocument(body + "### D12 duplicate\n"), /Duplicate/);
  assert.throws(() => answerDocument(body, "D1", "A", ""));
  assert.throws(() => answerDocument(body, "D12", "C", ""));
  assert.throws(() => answerDocument(body, "D12", "A", "x\n### D9 Inject"));
  assert.throws(() => answerDocument(body.replace("[ ]", "[x]"), "D12", "A", ""));
  assert.equal(documentView(body, async () => {}, render).querySelectorAll("form").length, 2);
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
  await refreshDocument(gh, slot, render, target);
  for (const form of slot.querySelectorAll("form")) {
    form.querySelector<HTMLInputElement>('input[type="radio"]')!.checked = true;
    form.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(form.textContent!, /Answered/);
  }
  await refreshDocument(gh, slot, render, target);
  assert.equal(slot.querySelectorAll("form").length, 0);
  fail = true;
  await refreshDocument(gh, slot, render, target);
  assert.match(slot.textContent!, /500/);
  fail = false;
  await refreshDocument(gh, slot, render, target);
  assert.doesNotMatch(slot.textContent!, /500/);
  server = body;
  await refreshDocument(gh, slot, render, target);
  slot.querySelector<HTMLInputElement>('input[type="text"]')!.value = "draft";
  server = body.replace("Context.", "Changed context.");
  await refreshDocument(gh, slot, render, target);
  assert.doesNotMatch(slot.textContent!, /Changed context/);
  await refreshDocument(gh, slot, render, target, true);
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
  await refreshDocument(gh, slot, render, { repo: "example/private", number: 8 });
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

test("an entry's text renders as GitHub-flavored markdown: a task list right after a paragraph line, and inline code", () => {
  // The shape of cgwalters-forge/operator#1 that came out as one run-on paragraph.
  const source = "### D2 Ruleset\nThe check allows no ignore for it.\n- [x] A) An org ruleset on `main`\n- [ ] B) Per-repository <script>alert(1)</script>\n\nReply:\n";
  const view = documentView(source, async () => {}, render, "example/private");
  const md = view.querySelector("section .md")!;
  assert.equal(md.querySelector("p")!.textContent, "The check allows no ignore for it.");
  assert.deepEqual([...md.querySelectorAll("ul > li")].map((li) => li.textContent), ["☑ A) An org ruleset on main", "☐ B) Per-repository <script>alert(1)</script>"]);
  assert.equal(md.querySelector("li code")!.textContent, "main");
  assert.equal(md.querySelectorAll("script, input").length, 0);
});

const tasks = "### D20 Checks\nTick what applies.\n- [ ] Rotate the key\n  - [x] Tell people\n- [ ] A) Ship it\n\n> - [ ] Quoted\n\n- [ ] Loose one\n\n- [ ] Loose two\n\n```md\n- [ ] Example\n```\nReply:\n\n## Done\n### D3 Old\n- [ ] Never\n";
const target = { repo: "example/private", number: 8, checkboxes: true };

function changedLines(before: string, after: string): string[] {
  const a = before.split(/\r?\n/);
  return after.split(/\r?\n/).filter((line, i) => line !== a[i]);
}

function tap(box: HTMLInputElement): Promise<void> {
  box.checked = !box.checked;
  box.dispatchEvent(new win.Event("change"));
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("tapping a checkbox toggles only that item's line in the document", async () => {
  let server = tasks;
  const gh = new GitHub(async () => "token", async (_, init) => {
    if (init?.method === "PATCH") server = JSON.parse(String(init.body)).body;
    return new Response(JSON.stringify({ body: server }));
  });
  const slot = document.createElement("div");
  await refreshDocument(gh, slot, render, target);
  const boxes = [...slot.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  // None for the lettered option (the form answers it), the fenced example or the done entry.
  assert.deepEqual(boxes.map((b) => [b.checked, b.closest("li")!.textContent!.trim().split("\n")[0]]), [
    [false, "Rotate the key"], [true, "Tell people"], [false, "Quoted"], [false, "Loose one"], [false, "Loose two"],
  ]);
  await tap(boxes[0]!);
  assert.deepEqual(changedLines(tasks, server), ["- [x] Rotate the key"]);
  for (const [i, line] of [[1, "  - [ ] Tell people"], [2, "> - [x] Quoted"], [4, "- [x] Loose two"]] as const) {
    const before = server;
    await tap(boxes[i]!);
    assert.deepEqual(changedLines(before, server), [line]);
  }
});

test("a checkbox refuses to write over a document changed since it was read, and says so", async () => {
  let server = tasks;
  let patches = 0;
  const gh = new GitHub(async () => "token", async (_, init) => {
    if (init?.method === "PATCH") patches++;
    return new Response(JSON.stringify({ body: server }));
  });
  const slot = document.createElement("div");
  await refreshDocument(gh, slot, render, target);
  server = tasks.replace("Tick what", "Edited: tick what");
  const box = slot.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await tap(box);
  assert.equal(patches, 0);
  assert.equal(box.checked, false);
  assert.match(slot.querySelector("section p[role=status]")!.textContent!, /changed, reload/);
});

test("a refresh waits for a tap still writing", async () => {
  let server = tasks;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const gh = new GitHub(async () => "token", async (_, init) => {
    if (init?.method === "PATCH") {
      await barrier;
      server = JSON.parse(String(init.body)).body;
    }
    return new Response(JSON.stringify({ body: server }));
  });
  const slot = document.createElement("div");
  await refreshDocument(gh, slot, render, target);
  const box = slot.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const tapped = tap(box);
  server = tasks.replace("Tick what", "Edited: tick what");
  await refreshDocument(gh, slot, render, target);
  assert.ok(slot.contains(box));
  release();
  await tapped;
});

test("each checkbox ticks the line it is shown on, even where source and rendering disagree", () => {
  for (const [doc, count] of [
    ["### D1 X\n> - [ ] Quoted harmless\n\nPara\n2. [ ] Delete prod\nReply:\n", 1],
    // A list item that merely starts with a glyph: none are tappable.
    ["### D1 X\nIntro\n2. [ ] Delete prod\n- ☐ Harmless\nReply:\n", 0],
    ["### D1 X\n- [ ] \n> - [ ] q\nReply:\n", 1],
    ["### D1 X\r\n1. [ ] First\r\n2) [x] Second\r\n> > - [ ] Deep\r\nReply:\r\n", 3],
    // A lone \r is a line break to markdown-it.
    ["### D1 X\nIntro\r- [ ] Harmless\n- [ ] Delete prod\nReply:\n", 2],
    ["### D1 X\nA\rB\r- [ ] Harmless\n```\n- [ ] code\n```\nReply:\n", 1],
  ] as const) {
    const lines: number[] = [];
    const view = documentView(doc, async () => {}, render, undefined, async (_, line) => void lines.push(line));
    const boxes = view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    assert.equal(boxes.length, count, JSON.stringify(doc));
    for (const box of boxes) {
      box.checked = !box.checked;
      box.dispatchEvent(new win.Event("change"));
      const changed = changedLines(doc, toggleDocument(doc, "D1", lines.at(-1)!, box.checked));
      assert.equal(changed.length, 1);
      assert.ok(changed[0]!.endsWith(box.closest("li")!.textContent!.trim().split("\n")[0]!), `${JSON.stringify(doc)}: ${changed[0]}`);
    }
  }
});

test("checkboxes are off unless configured, and toggles refuse stale, option or done items", async () => {
  const gh = new GitHub(async () => "token", async () => new Response(JSON.stringify({ body: tasks })));
  const slot = document.createElement("div");
  await refreshDocument(gh, slot, render, { repo: "example/private", number: 8 });
  assert.equal(slot.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.throws(() => toggleDocument(tasks, "D3", 0, true), /no longer/);
  assert.throws(() => toggleDocument(tasks, "D20", 2, true), /no longer/);
  assert.throws(() => toggleDocument(tasks, "D20", 3, true), /no longer/);
  assert.throws(() => toggleDocument(tasks, "D20", 0, true), /no longer/);
  assert.throws(() => toggleDocument(tasks, "D20", 99, true), /no longer/);
});

