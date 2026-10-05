// Capture rendering: empty and saved drafts, resolved titles and replacement DOM.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureBar, type CaptureHooks, loadDraft, type SavedDraft } from "../src/github/captureview.ts";
import { CAPTURE_DRAFT_KEY } from "../src/github/config.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const EVIL = "<img src=x onerror=alert(1)><script>alert(2)</script>\u202eRTL\u202c\u2066isolate\u2069\u0001";
const SAVED: SavedDraft = {
  title: "Review the widget", body: "Why this matters\n\n**Keep this note**", url: "https://github.com/o/r/pull/7",
  suggested: "", priority: "P1", epic: 12, labels: ["dispatch", "bug"], repo: "o/r",
};

function hooks(saved?: SavedDraft): CaptureHooks {
  const mem = new Map<string, string>();
  if (saved) mem.set(CAPTURE_DRAFT_KEY, JSON.stringify(saved));
  const storage = {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => { mem.set(key, value); },
    removeItem: (key: string) => { mem.delete(key); },
  } as Storage;
  return {
    storage, file: async () => ({ number: 42, url: "https://github.com/cgwalters-forge/tracker/issues/42" }),
    linkTitle: async () => EVIL, labels: async () => ["bug", "dispatch"], epics: async () => [{ number: 12, title: "Widget epic" }],
  };
}

async function mount(h: CaptureHooks) {
  const bar = captureBar(h);
  document.body.replaceChildren(bar.el);
  bar.mounted();
  // Let the stub option/title promises and their handlers resolve.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return bar;
}

function values(el: HTMLElement) {
  return [...el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")].map((field) => [field.className, field.value, field instanceof win.HTMLInputElement ? field.checked : undefined]);
}

describe("captureBar", () => {
  it("shows empty fields with the note collapsed", async () => {
    const bar = await mount(hooks());
    assert.equal(bar.el.querySelector<HTMLTextAreaElement>(".capture-title")?.value, "");
    assert.equal(bar.el.querySelector<HTMLTextAreaElement>(".capture-body")?.value, "");
    assert.equal(bar.el.querySelector<HTMLInputElement>(".capture-url")?.value, "");
    assert.equal(bar.el.querySelector<HTMLElement>(".capture-extra")?.hidden, true);
    assert.equal(bar.el.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded"), "false");
    assert.equal(bar.el.querySelector(".capture-status")?.textContent, "");
  });

  it("restores the inline saved draft with resolved options and the note open", async () => {
    const bar = await mount(hooks(SAVED));
    assert.equal(bar.el.querySelector<HTMLTextAreaElement>(".capture-title")?.value, SAVED.title);
    assert.equal(bar.el.querySelector<HTMLTextAreaElement>(".capture-body")?.value, SAVED.body);
    assert.equal(bar.el.querySelector<HTMLInputElement>(".capture-url")?.value, SAVED.url);
    assert.equal(bar.el.querySelector<HTMLSelectElement>(".capture-priority")?.value, "P1");
    assert.equal(bar.el.querySelector<HTMLSelectElement>(".capture-epic")?.value, "12");
    assert.equal(bar.el.querySelector('option[value="12"]')?.textContent, "#12: Widget epic");
    assert.equal(bar.el.querySelector<HTMLInputElement>(".capture-repo")?.value, "o/r");
    assert.equal(bar.el.querySelector<HTMLInputElement>(".capture-repo")?.required, true);
    assert.deepEqual([...bar.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')].map((input) => input.value), ["dispatch", "bug"]);
    assert.equal(bar.el.querySelector<HTMLElement>(".capture-extra")?.hidden, false);
  });

  it("preserves saved and promise-resolved untrusted titles as inert literal text", async () => {
    const saved = await mount(hooks({ ...SAVED, title: EVIL }));
    assert.equal(saved.el.querySelector<HTMLTextAreaElement>(".capture-title")?.value, EVIL);
    const h = hooks();
    const bar = await mount(h);
    const url = bar.el.querySelector<HTMLInputElement>(".capture-url")!;
    url.value = SAVED.url;
    url.dispatchEvent(new win.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(bar.el.querySelector<HTMLTextAreaElement>(".capture-title")?.value, `o/r#7: ${EVIL}`);
    assert.equal(loadDraft(h.storage).title, `o/r#7: ${EVIL}`);
    for (const el of [saved.el, bar.el]) {
      assert.equal(el.querySelectorAll("script, img, iframe, svg, style").length, 0, el.outerHTML);
      for (const node of el.querySelectorAll("*")) {
        for (const attr of node.getAttributeNames()) assert.ok(!/^on/i.test(attr), attr);
      }
    }
  });

  it("renders equivalent saved fields and resolved options on fresh replacement DOM", async () => {
    const h = hooks(SAVED);
    const first = await mount(h);
    const replacement = await mount(h);
    assert.notEqual(replacement.el, first.el);
    assert.equal(first.el.isConnected, false);
    assert.equal(document.body.firstElementChild, replacement.el);
    assert.equal(replacement.el.outerHTML, first.el.outerHTML);
    assert.deepEqual(values(replacement.el), values(first.el));
  });
});
