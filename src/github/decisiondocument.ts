import config from "./decisions-config.json" with { type: "json" };
import { h } from "../dom.ts";
import { GitHub, GitHubError } from "./api.ts";
import { taskItemLines, type Renderer } from "../markdown.ts";

// `checkboxes: true` makes an open entry's task-list items tappable; off
// unless set, so a document not written for one-tap edits stays read-only.
export const DECISIONS_CONFIG = config as { document: { repo: string; number: number; checkboxes?: boolean } | null; legacyQuestions: boolean };

function proseLines(text: string): { text: string; start: number }[] {
  const lines: { text: string; start: number }[] = [];
  let fence = "";
  let start = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
    } else if (!fence) lines.push({ text: line.replace(/\r?\n$/, ""), start });
    start += line.length;
  }
  return lines;
}

export interface DocumentEntry {
  id: string;
  title: string;
  start: number;
  end: number;
  text: string;
  done: boolean;
  options: { letter: string; text: string; checked: boolean }[];
}

export function parseDocument(body: string): DocumentEntry[] {
  if (body.length > 65536) throw new Error("Decisions document exceeds 64 KiB");
  const headings: { start: number; end: number; id: string | undefined; title: string; done: boolean }[] = [];
  let fence = "";
  let done = false;
  let offset = 0;
  for (const line of body.split(/(?<=\n)/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
    } else if (!fence) {
      if (/^##\s+Done\s*$/.test(line.trimEnd())) done = true;
      if (/^#{1,3} /.test(line)) {
        const m = /^### (D\d+) (.+)/.exec(line);
        headings.push({ start: offset, end: offset + line.length, id: m?.[1], title: m?.[2] ?? "", done });
      }
    }
    offset += line.length;
  }
  const entries = headings.flatMap((heading, i) => {
    if (!heading.id) return [];
    const end = headings[i + 1]?.start ?? body.length;
    const text = body.slice(heading.end, end);
    const options = proseLines(text).flatMap((line) => {
      const m = /^- \[([ xX])\] ([A-Z])\) (.+)$/.exec(line.text);
      return m ? [{ letter: m[2]!, text: m[3]!, checked: m[1] !== " " }] : [];
    });
    if (new Set(options.map((o) => o.letter)).size !== options.length) throw new Error("Duplicate option letters");
    return [{ ...heading, id: heading.id, end, text, options }];
  });
  if (new Set(entries.map((e) => e.id)).size !== entries.length) throw new Error("Duplicate decision ids");
  return entries;
}

export function answerDocument(body: string, id: string, letter: string, reply: string): string {
  const entry = parseDocument(body).find((e) => e.id === id && !e.done);
  if (!entry || !entry.options.some((o) => o.letter === letter) || entry.options.some((o) => o.checked)) throw new Error("Decision is no longer answerable");
  // A reply is one plain line: it cannot introduce headings or checklist options.
  if (/[\r\n]/.test(reply)) throw new Error("Reply must be one line");
  const original = body.slice(entry.start, entry.end);
  const lines = proseLines(original);
  if (lines.filter((l) => /^Reply:/.test(l.text)).length !== 1) throw new Error("Expected one Reply: line");
  let replacement = original;
  for (const line of lines.reverse()) {
    const option = /^- \[[ xX]\] ([A-Z])\)/.exec(line.text);
    const updated = option ? line.text.replace(/^(- \[)[ xX]/, `$1${option[1] === letter ? "x" : " "}`) : /^Reply:/.test(line.text) ? `Reply: ${reply}` : line.text;
    replacement = replacement.slice(0, line.start) + updated + replacement.slice(line.start + line.text.length);
  }
  return body.slice(0, entry.start) + replacement + body.slice(entry.end);
}

// The start of a line markdown-it reads as a task list item: optional
// blockquote markers, a bullet or ordered marker, then "[ ]" or "[x]". The
// line comes from markdown-it's map (taskItemLines); this only finds the box
// on it, and refuses a line it does not recognise rather than guess.
const TASK_LINE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(?=\][ \t])/;
// Lettered options are answered through the form, with its Reply line.
const OPTION_LINE = /^- \[[ xX]\] [A-Z]\) /;

/** Line `line` (0-based) of `text`, without its line ending, and where it starts. */
function lineAt(text: string, line: number): { text: string; start: number } | undefined {
  let start = 0;
  // Line breaks as markdown-it counts them, a lone \r included, so its line
  // numbers name the same lines here.
  const lines = text.split(/(?<=\r\n|\r(?!\n)|\n)/);
  for (const before of lines.slice(0, line)) start += before.length;
  const found = lines[line];
  return found === undefined ? undefined : { text: found.replace(/\r?\n$|\r$/, ""), start };
}

/** Tick or untick the task-list item on line `line` of open entry `id`'s text, changing only that line's box. */
export function toggleDocument(body: string, id: string, line: number, checked: boolean): string {
  const entry = parseDocument(body).find((e) => e.id === id && !e.done);
  const found = entry && lineAt(entry.text, line);
  const box = found && !OPTION_LINE.test(found.text) ? TASK_LINE.exec(found.text) : null;
  // The box must still be in the state the checkbox was showing.
  if (!entry || !found || !box || (box[2] !== " ") === checked) throw new Error("Item is no longer there to toggle");
  // entry.text is the body up to entry.end, from just after its heading.
  const at = entry.end - entry.text.length + found.start + box[1]!.length;
  return body.slice(0, at) + (checked ? "x" : " ") + body.slice(at + 1);
}

/** A write refused because the document is no longer `shown`; `body` is what it is now. */
export class DocumentChanged extends Error {
  readonly body: string;
  constructor(body: string) {
    super("changed, reload");
    this.body = body;
  }
}

/** Write `edit(shown)` to the document at `path`, unless it changed since `shown` was read. */
export async function sendDocumentEdit(gh: GitHub, path: string, shown: string, edit: (body: string) => string): Promise<string> {
  const body = edit(shown);
  // Stops a stale form overwriting edits made since its refresh. GitHub has
  // no issue-body CAS: an edit after this GET can still race the PATCH.
  const fresh = await gh.send<{ body: string }>("GET", path);
  if (fresh.body !== shown) throw new DocumentChanged(fresh.body);
  await gh.send("PATCH", path, { body });
  return body;
}

export function sendDocumentAnswer(gh: GitHub, path: string, shown: string, id: string, letter: string, reply: string): Promise<string> {
  return sendDocumentEdit(gh, path, shown, (body) => answerDocument(body, id, letter, reply));
}

/**
 * Swap the ☐/☑ glyphs `render` put on an open entry's task items for
 * checkboxes calling `toggle` with each item's source line. Glyphs pair with
 * markdown-it's task items in document order; if any list item's text
 * merely starts with a glyph, the counts differ and all stay glyphs, since
 * a tap could then tick a different line than the one shown.
 */
function tappableTasks(md: HTMLElement, entry: DocumentEntry, toggle: (id: string, line: number, checked: boolean) => Promise<void>, status: HTMLElement): boolean {
  const glyphs = [...md.querySelectorAll("li")].flatMap((li) => {
    // 4 is NodeFilter.SHOW_TEXT, which jsdom's window has but node's global
    // does not. A loose list item's first text is the newline before its <p>.
    const walker = document.createTreeWalker(li, 4);
    let node = walker.nextNode() as Text | null;
    while (node && !node.data.trim()) node = walker.nextNode() as Text | null;
    return node && /^[☐☑] /.test(node.data) ? [node] : [];
  });
  const lines = taskItemLines(entry.text);
  if (glyphs.length !== lines.length) return false;
  let any = false;
  glyphs.forEach((node, i) => {
    const line = lines[i]!;
    const source = lineAt(entry.text, line);
    const box = source && !OPTION_LINE.test(source.text) ? TASK_LINE.exec(source.text) : null;
    const checked = node.data[0] === "☑";
    if (!box || (box[2] !== " ") !== checked) return;
    any = true;
    const input = h("input", { type: "checkbox", "aria-label": `${entry.id}: ${node.data.slice(2, 82)}` });
    input.checked = checked;
    input.addEventListener("change", async () => {
      input.disabled = true;
      try {
        await toggle(entry.id, line, input.checked);
        status.textContent = "";
      } catch (e) {
        input.checked = !input.checked;
        status.textContent = e instanceof Error ? e.message : String(e);
      } finally {
        input.disabled = false;
      }
    });
    node.data = node.data.slice(1);
    node.before(input);
  });
  return any;
}

/**
 * The document, with each entry's text as GitHub-flavored markdown (sanitized by `render`), and a form for each one still open.
 * With `toggle`, an open entry's task-list items are checkboxes; done entries stay read-only.
 */
export function documentView(body: string, send: (id: string, letter: string, reply: string) => Promise<void>, render: Renderer, repository?: string, toggle?: (id: string, line: number, checked: boolean) => Promise<void>): HTMLElement {
  const root = h("div", { class: "decision-document" });
  const done = h("details", {}, h("summary", {}, "Done"));
  for (const entry of parseDocument(body)) {
    const md = h("div", { class: "md" }, render(entry.text, repository));
    const row = h("section", {}, h("h3", {}, `${entry.id} ${entry.title}`), md);
    if (toggle && !entry.done) {
      const status = h("p", { role: "status" });
      if (tappableTasks(md, entry, toggle, status)) row.append(status);
    }
    if (!entry.done && !entry.options.some((o) => o.checked)) {
      const form = h("form", { "data-id": entry.id });
      for (const option of entry.options) {
        form.append(h("label", {}, h("input", { type: "radio", name: entry.id, value: option.letter, required: "" }), `${option.letter}) ${option.text}`));
      }
      const reply = h("input", { type: "text", "aria-label": `Reply for ${entry.id}`, maxlength: "4096" });
      const button = h("button", { type: "submit" }, "Send");
      const status = h("p", { role: "status" });
      form.append(reply, button, status);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const picked = form.querySelector<HTMLInputElement>("input:checked")?.value;
        if (!picked || button.disabled) return;
        button.disabled = true;
        try {
          await send(entry.id, picked, reply.value);
          status.textContent = "Answered";
          form.dataset.sent = "true";
          for (const input of form.querySelectorAll("input")) input.disabled = true;
        } catch (e) {
          status.textContent = e instanceof Error ? e.message : String(e);
          button.disabled = false;
        }
      });
      row.append(form);
    }
    (entry.done ? done : root).append(row);
  }
  root.append(done);
  return root;
}

export const DOCUMENT_CHANGED_NOTE = "The decisions document changed; press r to reload it (unsent answers are kept).";
export const DOCUMENT_KEPT = "The document changed; your answer is kept, check it and send again";

/** The unsent forms' picks (by their label, "B) Wait") and replies, by entry id. */
function drafts(slot: HTMLElement): Map<string, { pick: string | undefined; reply: string }> {
  const found = new Map<string, { pick: string | undefined; reply: string }>();
  for (const form of slot.querySelectorAll<HTMLFormElement>("form[data-id]:not([data-sent])")) {
    const pick = form.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.parentElement?.textContent ?? undefined;
    const reply = form.querySelector<HTMLInputElement>('input[type="text"]')?.value ?? "";
    if (pick || reply) found.set(form.dataset.id!, { pick, reply });
  }
  return found;
}

function slotNote(slot: HTMLElement, text: string): void {
  slot.querySelector(":scope > p[role=status]")?.remove();
  slot.prepend(h("p", { role: "status" }, text));
}

// `body` is the one shown, `written` the last this view itself wrote.
const readers = new WeakMap<HTMLElement, { running: boolean; body?: string; written?: string }>();

export async function refreshDocument(gh: GitHub, slot: HTMLElement, render: Renderer, target = DECISIONS_CONFIG.document, force = false): Promise<void> {
  if (!target) return;
  const checkboxes = target.checkboxes === true;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.repo) || !Number.isSafeInteger(target.number) || target.number < 1) throw new Error("Invalid decisions configuration");
  const state = readers.get(slot) ?? { running: false };
  readers.set(slot, state);
  if (state.running) return;
  state.running = true;
  const path = `/repos/${target.repo}/issues/${target.number}`;
  // Show `body`, carrying each unsent pick and reply over to the same entry's
  // new form, so neither a reload nor a refused send loses what was typed. An
  // entry answered or moved to Done meanwhile has no form, and its draft goes.
  const mount = (body: string) => {
    const kept = drafts(slot);
    let baseline = body;
    // Every form patches the same body: run each read/compare/PATCH after the
    // previous one settles so a second answer builds on the first instead of
    // overwriting it with the same stale baseline.
    let queue = Promise.resolve();
    const write = (edit: (body: string) => string) => {
      const run = queue.then(async () => {
        baseline = await sendDocumentEdit(gh, path, baseline, edit);
        // Our own write is not a change for the poll to report.
        if (slot.contains(view)) state.written = baseline;
      });
      queue = run.catch(() => {});
      return run;
    };
    const answer = async (id: string, letter: string, reply: string) => {
      try {
        await write((body) => answerDocument(body, id, letter, reply));
      } catch (e) {
        // Refused as stale: show the document as it is now, with this answer
        // still filled in, rather than leave a form every retry refuses. Not
        // while a tap is writing (redrawing would hide its outcome) or once
        // this view is gone (a newer one is already showing).
        if (!(e instanceof DocumentChanged) || !slot.contains(view) || slot.querySelector('.md input[type="checkbox"]:disabled')) throw e;
        mount(e.body);
        state.body = e.body;
        const status = slot.querySelector<HTMLFormElement>(`form[data-id="${id}"]`)?.querySelector("p[role=status]");
        if (status) status.textContent = DOCUMENT_KEPT;
        else slotNote(slot, `The document changed; ${id} is no longer open to answer.`);
        throw e;
      }
    };
    const view = documentView(body, answer, render, target.repo, checkboxes ? (id, index, checked) => write((body) => toggleDocument(body, id, index, checked)) : undefined);
    for (const [id, draft] of kept) {
      const form = view.querySelector<HTMLFormElement>(`form[data-id="${id}"]`);
      if (!form) continue;
      // A pick whose option was reworded or relettered is dropped, not moved
      // onto whatever that letter says now; the reply is kept either way.
      for (const radio of form.querySelectorAll<HTMLInputElement>('input[type="radio"]')) radio.checked = radio.parentElement?.textContent === draft.pick;
      form.querySelector<HTMLInputElement>('input[type="text"]')!.value = draft.reply;
    }
    slot.replaceChildren(view);
  };
  try {
    const { data } = await gh.get<{ body: string }>(path);
    slot.querySelector(":scope > p[role=status]")?.remove();
    if (!force && state.body === data.body) return;
    // Redrawing under a half-written answer would move it as it is typed:
    // say the document changed, and leave the reload to r.
    if (!force && drafts(slot).size) return data.body === state.written ? undefined : slotNote(slot, DOCUMENT_CHANGED_NOTE);
    // A tap still writing: re-rendering now would show a body without it.
    // A forced reload goes ahead; the re-read before each write then refuses
    // the next tap with "changed, reload" rather than undo this one.
    if (!force && slot.querySelector('.md input[type="checkbox"]:disabled')) return;
    mount(data.body);
    state.body = data.body;
  } catch (e) {
    slotNote(slot, e instanceof GitHubError && e.status === 404 ? "Cannot read the decisions issue: it may be private and this viewer's token has no access, or the issue does not exist." : String(e));
  } finally {
    state.running = false;
  }
}
