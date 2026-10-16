import config from "./decisions-config.json" with { type: "json" };
import { h } from "../dom.ts";
import { GitHub, GitHubError } from "./api.ts";
import type { Renderer } from "../markdown.ts";

export const DECISIONS_CONFIG = config as { document: { repo: string; number: number } | null; legacyQuestions: boolean };

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

export async function sendDocumentAnswer(gh: GitHub, path: string, shown: string, id: string, letter: string, reply: string): Promise<string> {
  const body = answerDocument(shown, id, letter, reply);
  // Stops a stale form overwriting edits made since its refresh. GitHub has
  // no issue-body CAS: an edit after this GET can still race the PATCH.
  const fresh = await gh.send<{ body: string }>("GET", path);
  if (fresh.body !== shown) throw new Error("changed, reload");
  await gh.send("PATCH", path, { body });
  return body;
}

/** The document, with each entry's text as GitHub-flavored markdown (sanitized by `render`), and a form for each one still open. */
export function documentView(body: string, send: (id: string, letter: string, reply: string) => Promise<void>, render: Renderer, repository?: string): HTMLElement {
  const root = h("div", { class: "decision-document" });
  const done = h("details", {}, h("summary", {}, "Done"));
  for (const entry of parseDocument(body)) {
    const row = h("section", {}, h("h3", {}, `${entry.id} ${entry.title}`), h("div", { class: "md" }, render(entry.text, repository)));
    if (!entry.done && !entry.options.some((o) => o.checked)) {
      const form = h("form", {});
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

const readers = new WeakMap<HTMLElement, { running: boolean; body?: string }>();

export async function refreshDocument(gh: GitHub, slot: HTMLElement, render: Renderer, target = DECISIONS_CONFIG.document, force = false): Promise<void> {
  if (!target) return;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.repo) || !Number.isSafeInteger(target.number) || target.number < 1) throw new Error("Invalid decisions configuration");
  const state = readers.get(slot) ?? { running: false };
  readers.set(slot, state);
  if (state.running) return;
  state.running = true;
  const path = `/repos/${target.repo}/issues/${target.number}`;
  try {
    const { data } = await gh.get<{ body: string }>(path);
    slot.querySelector(":scope > p[role=status]")?.remove();
    if (!force && state.body === data.body) return;
    if (!force && [...slot.querySelectorAll<HTMLFormElement>("form:not([data-sent])")].some((form) => form.querySelector("input:checked") || form.querySelector<HTMLInputElement>('input[type="text"]')?.value)) return;
    let baseline = data.body;
    // Every form patches the same body: run each read/compare/PATCH after the
    // previous one settles so a second answer builds on the first instead of
    // overwriting it with the same stale baseline.
    let queue = Promise.resolve();
    slot.replaceChildren(documentView(data.body, (id, letter, reply) => {
      const run = queue.then(async () => {
        baseline = await sendDocumentAnswer(gh, path, baseline, id, letter, reply);
      });
      queue = run.catch(() => {});
      return run;
    }, render, target.repo));
    state.body = data.body;
  } catch (e) {
    const note = h("p", { role: "status" }, e instanceof GitHubError && e.status === 404 ? "Cannot read the decisions issue: it may be private and this viewer's token has no access, or the issue does not exist." : String(e));
    slot.querySelector(":scope > p[role=status]")?.remove();
    slot.prepend(note);
  } finally {
    state.running = false;
  }
}
