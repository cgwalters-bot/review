import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DIFF_COLLAPSE_LINES } from "../src/github/config.ts";
import { displayItems, parseHunks } from "../src/github/diff.ts";
import { FILE_CLASS, rowSegments } from "../src/github/diffview.ts";
import { fileDiff, fileViewFixture } from "./fixtures/fileview.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const rows = (root: Element) => [...root.querySelectorAll("tr")].map((tr) => [
  tr.className, [...tr.querySelectorAll("td.ln")].map((td) => td.textContent),
  [...tr.querySelectorAll("td.code")].map((td) => td.textContent),
]);

describe("rowSegments", () => {
  for (const lang of [undefined, "rust", "unknown-language"]) {
    it(`preserves row text and marks paired word changes (${lang ?? "plain"})`, () => {
      const items = displayItems(parseHunks('@@ -1,2 +1,3 @@\n fn main() {}\n-let value = "old";\n+let value = "new";\n+extra\n@@ -10 +11 @@\n last'), [], undefined);
      const segs = rowSegments(items, lang);
      items.forEach((item, i) => {
        if (item.t === "gap") assert.equal(segs.has(i), false);
        else assert.equal(segs.get(i)?.map((s) => s.text).join(""), item.row.text);
      });
      assert.deepEqual([...segs.values()].flat().filter((s) => s.changed).map((s) => s.text), ["old", "new"]);
      assert.equal([...segs.values()].flat().some((s) => s.cls.includes("hljs-keyword")), lang === "rust");
    });
  }

  it("handles empty input and resets syntax state across gaps", () => {
    assert.equal(rowSegments([], "rust").size, 0);
    const items = displayItems(parseHunks("@@ -1 +1 @@\n /* open\n@@ -10 +10 @@\n let x = 1;"), [], undefined);
    const segs = rowSegments(items, "rust");
    const last = [...segs.values()].at(-1) ?? [];
    assert.ok(last.some((s) => s.cls.includes("hljs-keyword") && s.text === "let"));
    assert.ok(!last.some((s) => s.cls.includes("hljs-comment")));
  });
});

describe("FileView", () => {
  for (const layout of ["unified", "split"] as const) {
    it(`renders hunks, numbers, signs and classes in ${layout} layout`, () => {
      const { view } = fileViewFixture({}, { layout: () => layout });
      assert.equal(view.el.className, FILE_CLASS);
      assert.equal(view.el.dataset.path, "a.txt");
      assert.equal(view.el.querySelector("table")?.className, `diff ${layout}`);
      assert.deepEqual([...view.el.querySelectorAll(".section")].map((e) => e.textContent), ["@@ -2,3 +2,4 @@ section", "@@ -10,1 +11,1 @@ last"]);
      const expected = layout === "unified" ? [
        ["ctx", ["2", "2"], [" context"]], ["del", ["3", ""], ["-value old"]],
        ["add", ["", "3"], ["+value new"]], ["add", ["", "4"], ["+extra"]],
        ["ctx", ["4", "5"], [" tail"]],
      ] : [
        ["split", ["2", "2"], [" context", " context"]],
        ["split", ["3", "3"], ["-value old", "+value new"]],
        ["split", ["", "4"], ["", "+extra"]],
        ["split", ["4", "5"], [" tail", " tail"]],
      ];
      assert.deepEqual(rows(view.el).slice(1, 1 + expected.length), expected);
      assert.deepEqual([...view.el.querySelectorAll(".wd")].map((s) => s.textContent), ["old", "new"]);
      if (layout === "split") {
        const pair = view.el.querySelectorAll("tr.split")[1];
        assert.ok(pair);
        assert.deepEqual([...pair.querySelectorAll("td")].map((td) => td.className), ["ln del can-comment", "code del", "ln add can-comment", "code add"]);
      }
      assert.equal(view.hunkStarts().length, 2);
    });
  }

  it("shows syntax, no-newline and bidi markers without interpreting code as HTML", () => {
    const { view } = fileViewFixture({ file: fileDiff({ filename: "a.rs", patch: '@@ -0,0 +1,2 @@\n+let x = "<img src=x onerror=alert(1)>";\n+// \u202e\n\\ No newline at end of file' }) });
    assert.equal(view.el.querySelector(".hljs-keyword")?.textContent, "let");
    assert.equal(view.el.querySelectorAll(".bidi").length, 1);
    assert.equal(view.el.querySelectorAll(".nonl").length, 1);
    const markedRow = view.el.querySelectorAll("tr.add")[1];
    assert.ok(markedRow);
    assert.equal(markedRow.querySelectorAll("td.ln")[1]?.textContent, "2");
    assert.equal(view.el.querySelector(".bidi")?.parentElement, markedRow.querySelector("td.code"));
    assert.equal(view.el.querySelector(".nonl")?.parentElement, markedRow.querySelector("td.code"));
    assert.equal(view.el.querySelectorAll("img, script").length, 0);
    assert.ok(view.el.textContent?.includes("<img src=x onerror=alert(1)>"));
  });

  for (const [name, file] of [
    ["rename", fileDiff({ filename: "new.txt", previous: "old.txt", status: "renamed", patch: "" })],
    ["binary", { filename: "image.bin", status: "added", additions: 0, deletions: 0 }],
  ] as const) {
    it(`shows a ${name} entry without a diff`, () => {
      const { view } = fileViewFixture({ file });
      assert.equal(view.hasDiff, false);
      assert.equal(view.el.querySelectorAll("table").length, 0);
      assert.match(view.el.querySelector(".nodiff")?.textContent ?? "", /No diff to show/);
      assert.equal(view.el.querySelector(".fname")?.textContent, name === "rename" ? "old.txt → new.txt" : "image.bin");
      assert.equal(view.el.querySelector(".fstatus")?.className, `fstatus s-${view.file.status}`);
    });
  }

  for (const reason of ["large", "generated", "viewed"] as const) {
    it(`defers a ${reason} file until it is opened`, () => {
      const n = reason === "large" ? DIFF_COLLAPSE_LINES + 1 : 1;
      const { view } = fileViewFixture({ viewed: reason === "viewed", file: fileDiff({ filename: reason === "generated" ? "Cargo.lock" : "big.txt", status: "added", patch: `@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+line ${i}`).join("\n")}` }) });
      assert.equal(view.el.open, false);
      assert.equal(view.built, false);
      view.render();
      assert.equal(view.el.querySelectorAll("tr").length, 0);
      view.el.open = true;
      view.el.dispatchEvent(new win.Event("toggle"));
      assert.equal(view.seen(), true);
      assert.equal(view.el.querySelectorAll("tr").length, n);
      const table = view.el.querySelector("table");
      view.want();
      view.build();
      assert.equal(view.el.querySelector("table"), table);
    });
  }

  it("waits for the lazy observer, then builds only when open and near", () => {
    const observed: Element[] = [], unobserved: Element[] = [];
    const lazy: IntersectionObserver = {
      root: null, rootMargin: "1500px 0px", thresholds: [0],
      observe: (el) => { observed.push(el); },
      unobserve: (el) => { unobserved.push(el); },
      disconnect: () => {},
      takeRecords: () => [],
    };
    const { view } = fileViewFixture({ lazy });
    assert.deepEqual(observed, [view.el]);
    view.el.open = false;
    view.near();
    assert.equal(view.built, false);
    view.el.open = true;
    view.near();
    assert.equal(view.built, true);
    assert.deepEqual(unobserved, [view.el]);
    assert.equal(view.el.querySelector<HTMLElement>(".fbody")?.style.minHeight, "");
  });

  for (const layout of ["unified", "split"] as const) {
    it(`places, saves, edits and deletes inline comments in ${layout}`, () => {
      const { view, state, calls, hooks } = fileViewFixture({}, { layout: () => layout });
      const item = view.items.findIndex((it) => it.t === "row" && it.row.kind === "add");
      assert.equal(view.openComposer(0, "RIGHT"), false, "gap cannot take a comment");
      const cell = view.rowEl(item)?.querySelectorAll<HTMLElement>("td.ln")[1];
      assert.ok(cell);
      cell.click();
      assert.deepEqual(calls.focused, [[view, item, "RIGHT", false]]);
      assert.equal(view.el.querySelector("tr.composer")?.previousElementSibling, view.rowEl(item));
      assert.equal(view.el.querySelector<HTMLTableCellElement>("tr.composer td")?.colSpan, layout === "unified" ? 3 : 4);
      const text = view.el.querySelector<HTMLTextAreaElement>("textarea");
      assert.ok(text);
      assert.equal(document.activeElement, text);
      view.el.querySelector<HTMLButtonElement>("button.primary")?.click();
      assert.match(view.el.querySelector(".status")?.textContent ?? "", /Write something first/);
      text.value = "<img> thought";
      text.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      const draft = { path: "a.txt", line: 3, side: "RIGHT", body: "<img> thought", commit: hooks.commit, base: hooks.base };
      assert.deepEqual(calls.saved, [[draft, undefined]]);
      assert.equal(view.el.querySelector("tr.draft")?.previousElementSibling, view.rowEl(item));
      assert.equal(view.el.querySelectorAll("img").length, 0);
      view.el.querySelector<HTMLButtonElement>("tr.draft button")?.click();
      const edit = view.el.querySelector<HTMLTextAreaElement>("textarea");
      assert.ok(edit);
      assert.equal(edit.value, draft.body);
      edit.value = "updated";
      view.el.querySelector<HTMLButtonElement>("button.primary")?.click();
      assert.deepEqual(calls.saved[1], [{ ...draft, body: "updated" }, draft]);
      view.el.querySelectorAll<HTMLButtonElement>("tr.draft button")[1]?.click();
      assert.deepEqual(calls.deleted, [{ ...draft, body: "updated" }]);
      assert.deepEqual(state.drafts, []);
      view.render();
      assert.equal(view.el.querySelector("tr.draft"), null);
    });
  }

  it("keeps left and right drafts after their own rows", () => {
    const { view, state, hooks } = fileViewFixture();
    state.drafts = (["LEFT", "RIGHT"] as const).map((side) => ({ path: "a.txt", line: 3, side, body: side, commit: hooks.commit }));
    view.render();
    assert.deepEqual([...view.el.querySelectorAll("tr.draft")].map((tr) => [tr.previousElementSibling?.className, tr.querySelector("pre")?.textContent]), [["del", "LEFT"], ["add", "RIGHT"]]);
  });

  it("records viewed changes and preserves focus/composer across context expansion and layout changes", async () => {
    const { view, state, calls } = fileViewFixture();
    view.setViewedBox(true);
    assert.equal(view.viewed, true);
    assert.deepEqual(calls.viewed, []);
    view.el.querySelector<HTMLInputElement>("input.viewed")?.dispatchEvent(new win.Event("change"));
    assert.deepEqual(calls.viewed, [[view, true]]);
    const item = view.hunkStarts()[0];
    assert.ok(item !== undefined);
    assert.equal(view.setFocus(item), view.rowEl(item));
    assert.equal(view.openComposer(item, "RIGHT"), true);
    await view.expand([1, 1]);
    assert.equal(view.el.querySelector("tr.focus td.code")?.textContent, " context");
    assert.match(view.el.querySelector("tr.composer .tag")?.textContent ?? "", /new line 2/);
    assert.equal(view.el.querySelector("tr.expanded td.code")?.textContent, " line 1");
    assert.equal(view.el.querySelectorAll("tr.expanded .can-comment").length, 0);
    state.layout = "split";
    view.render();
    const focused = view.el.querySelector("table.split tr.focus");
    assert.ok(focused);
    const composer = view.el.querySelector("table.split tr.composer");
    assert.ok(composer);
    assert.match(composer.querySelector(".tag")?.textContent ?? "", /new line 2/);
    assert.equal(composer.previousElementSibling, focused);
    assert.deepEqual([...focused.querySelectorAll("td.code")].map((td) => td.textContent), [" context", " context"]);
    const revealed = await view.reveal([6, 7]);
    assert.ok(revealed?.textContent?.includes("line 6"));
    assert.equal(state.loads, 1, "context is cached");
    view.setFocus(undefined);
    assert.equal(view.focus, undefined);
    assert.equal(view.el.querySelector("tr.focus"), null);
  });

  it("reports a context load failure and permits retry", async () => {
    let loads = 0;
    const { view } = fileViewFixture({}, { loadLines: async () => { if (++loads === 1) throw new Error("offline"); return ["line 1"]; } });
    await view.expand([1, 1]);
    assert.match(view.el.textContent ?? "", /Context unavailable: offline/);
    await view.expand([1, 1]);
    assert.doesNotMatch(view.el.textContent ?? "", /Context unavailable/);
    assert.equal(view.el.querySelector("tr.expanded td.code")?.textContent, " line 1");
  });
});
