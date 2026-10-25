// The inbox's cards (inbox.ts) on the page. Cards are kept by key across
// polls: an unchanged card is left alone, a changed one redrawn, a gone one
// removed. A card holding an unsent form (a pick, a reply, a half-written
// answer) is never redrawn, moved or removed under him: it stays as it is,
// marked as changed, until he sends or clears it, or reloads with r.

import type { Answer } from "../answer.ts";
import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import { questionOf } from "./board.ts";
import type { DocumentEntry } from "./decisiondocument.ts";
import { type Card, CARD_LABEL, type DispatchRun } from "./inbox.ts";
import { ACTION_LABEL, ACTION_TITLE, type Need } from "./needs.ts";
import { age, answerForm, pill, ROW_CLASS, ROW_HREF_ATTR, ROW_KEY_ATTR, ROW_SECTION_ATTR, SINCE_ATTR } from "./view.ts";

export const CARD_CLASS = "card";
export const CARD_DONE_CLASS = "card-done";
/** On a card kept for its unsent form though what it shows changed or left. */
export const CARD_STALE_CLASS = "card-stale";
const SIG_ATTR = "data-sig";
/** Rows of a card's answer box: a short note. */
const NOTE_ROWS = 2;

export const CARD_CHANGED_NOTE = "This changed since it was drawn; send or clear your text, or press r to reload it (unsent text is lost).";
export const CARD_GONE_NOTE = "This has left the inbox; your unsent text is kept until you clear it or press r.";

export interface InboxHooks {
  now: number;
  render: Renderer;
  /** Whether the signed-in token may act (the operator's, or not yet named). */
  mayAct: boolean;
  /** Post the answer to an Answer card's question; resolves to the comment's URL. */
  sendNeed(n: Need, a: Answer): Promise<string>;
  /** Tick option `letter` of document entry `entry` (as the card shows it) and fill its reply. */
  answerEntry(entry: DocumentEntry, letter: string, reply: string): Promise<void>;
  /** Rerun a Rerun card's failed jobs; resolves to the run's URL. */
  rerun(run: DispatchRun): Promise<string>;
  /** The body of a Send card: the draft as its review will look, with Send. */
  draftBody?(card: Card & { kind: "send" }): Promise<HTMLElement>;
  /** The body of a Do card: the proposal's facts, with Execute. */
  offerBody?(card: Card & { kind: "do" }): Promise<HTMLElement>;
}

/** What a card shows, so an unchanged card is not redrawn. Its age is left out: the ticker moves it in place. */
export function cardSignature(c: Card): string {
  const base = [c.kind, c.key, c.title, c.where, c.url, c.since, c.answered === true, c.note];
  switch (c.kind) {
    case "answer":
    case "approve": return JSON.stringify([...base, c.need.action, c.need.href, c.need.inPlace, c.need.priority, c.need.decision?.item.body, c.need.entry?.item?.body]);
    case "send": return JSON.stringify([...base, c.draft.issue.body, c.draft.box, c.draft.found?.raw, c.draft.refused]);
    case "rerun": return JSON.stringify([...base, c.run.id, c.run.status, c.run.conclusion]);
    case "do": return JSON.stringify([...base, c.offer.comment.updatedAt, c.plan.states]);
    case "document": return JSON.stringify([...base, c.entry.text, c.mark]);
  }
}

/**
 * Whether a card holds something he typed or picked and hasn't sent, or
 * he is in one of its fields: redrawing or moving it would take the focus
 * (and a phone's keyboard) away.
 */
export function holdsDraft(card: Element): boolean {
  const active = card.ownerDocument.activeElement;
  if (active && card.contains(active) && active.matches("input, textarea, select")) return true;
  return [...card.querySelectorAll("form:not([data-sent])")].some((form) =>
    [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input[type=text]")].some((t) => t.value.trim() !== "") ||
    form.querySelector("input[type=radio]:checked") !== null);
}

/** A document entry's options and reply, sent through `answerEntry`. */
function entryForm(c: Card & { kind: "document" }, hooks: InboxHooks): HTMLElement {
  const form = h("form", { class: "answer entry-answer", "data-id": c.entry.id });
  for (const o of c.entry.options) form.append(h("label", { class: "opt" }, h("input", { type: "radio", name: `entry-${c.entry.id}`, value: o.letter }), `${o.letter}) ${o.text}`));
  const reply = h("input", { type: "text", "aria-label": `Reply for ${c.entry.id}`, maxlength: "4096", placeholder: "Reply (optional)" });
  const button = h("button", { type: "submit", class: "primary" }, "Send");
  const status = h("p", { class: "status", role: "status" });
  form.append(reply, h("div", { class: "actions" }, button), status);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const picked = form.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value;
    if (button.disabled) return;
    if (!picked) {
      status.textContent = "Pick an option.";
      return;
    }
    button.disabled = true;
    status.textContent = "Sending…";
    hooks.answerEntry(c.entry, picked, reply.value).then(() => {
      form.dataset.sent = "true";
      status.textContent = "Answered.";
      for (const input of form.querySelectorAll("input")) input.disabled = true;
    }, (e: unknown) => {
      status.textContent = `Not sent: ${e instanceof Error ? e.message : String(e)}`;
      button.disabled = false;
    });
  });
  return form;
}

function rerunButton(c: Card & { kind: "rerun" }, hooks: InboxHooks): HTMLElement {
  const button = h("button", { type: "button", class: "primary" }, "Rerun failed jobs");
  const status = h("p", { class: "status", role: "status" });
  button.addEventListener("click", () => {
    if (button.disabled || !window.confirm(`Rerun the failed jobs of ${c.run.title}? It runs again as it did, with your token.`)) return;
    button.disabled = true;
    status.textContent = "Asking GitHub to rerun…";
    hooks.rerun(c.run).then(() => {
      status.textContent = "Rerun requested: the card leaves once the run is live again.";
    }, (e: unknown) => {
      status.textContent = `Not rerun: ${e instanceof Error ? e.message : String(e)}`;
      button.disabled = false;
    });
  });
  return h("div", { class: "actions" }, button, status);
}

/** The card's one action: in place where the page can do it, else a link to where it is done. */
function action(c: Card, hooks: InboxHooks): Node | null {
  if (c.answered) return null;
  switch (c.kind) {
    case "answer": {
      const item = c.need.decision?.item ?? c.need.entry?.item;
      if (c.need.inPlace && item?.ref && hooks.mayAct) return answerForm(item.ref, c.need.decision?.question ?? questionOf(item), false, (a) => hooks.sendNeed(c.need, a), `card-${item.ref.owner}-${item.ref.repo}-${item.ref.number}-`, NOTE_ROWS);
      return h("a", { class: `action a-${c.need.action}`, href: c.need.href, title: ACTION_TITLE[c.need.action] }, ACTION_LABEL[c.need.action]);
    }
    case "approve": return h("a", { class: `action a-${c.need.action}`, href: c.need.href, title: ACTION_TITLE[c.need.action] }, ACTION_LABEL[c.need.action]);
    case "document": return hooks.mayAct && c.entry.options.length ? entryForm(c, hooks) : null;
    case "rerun": return hooks.mayAct ? rerunButton(c, hooks) : null;
    case "send":
    case "do": return null;
  }
}

export function cardEl(c: Card, hooks: InboxHooks): HTMLElement {
  const priority = c.kind === "answer" || c.kind === "approve" ? c.need.priority : undefined;
  const head = h("div", { class: "card-head" },
    h("span", { class: `kind c-${c.kind}` }, CARD_LABEL[c.kind]),
    priority ? pill(priority) : null,
    h("span", { class: "title" }, c.url ? link(c.url, c.title) : c.title),
    h("span", { class: "age", ...(c.since ? { [SINCE_ATTR]: c.since, title: c.since } : {}) }, age(c.since, hooks.now)));
  const el = h("article", {
    class: `${ROW_CLASS} ${CARD_CLASS} c-${c.kind}${c.answered ? ` ${CARD_DONE_CLASS}` : ""}`,
    tabindex: "-1",
    [ROW_KEY_ATTR]: c.key,
    [ROW_SECTION_ATTR]: "inbox",
    [ROW_HREF_ATTR]: c.kind === "answer" || c.kind === "approve" ? c.need.href : "#",
    [SIG_ATTR]: cardSignature(c),
  }, head, h("p", { class: "card-where" }, c.where), c.note ? h("p", { class: "card-note" }, c.note) : null);
  if (c.kind === "document" && c.entry.text.trim()) el.append(h("details", { class: "dec-body" }, h("summary", {}, "The whole entry"), h("div", { class: "md" }, hooks.render(c.entry.text, c.entry.about?.repo))));
  const body = c.kind === "send" ? hooks.draftBody?.(c) : c.kind === "do" ? hooks.offerBody?.(c) : undefined;
  if (body) {
    // Read on drawing (the draft's PR, the proposal's targets): filled in when it arrives.
    const slot = h("div", { class: "card-body" }, h("p", { class: "note" }, "Reading…"));
    el.append(slot);
    body.then((b) => slot.replaceChildren(b), (e: unknown) => slot.replaceChildren(h("p", { class: "warn" }, String(e))));
  }
  const act = action(c, hooks);
  if (act) el.append(act);
  return el;
}

function staleNote(el: Element, text: string): void {
  el.classList.add(CARD_STALE_CLASS);
  const note = el.querySelector(":scope > .card-stale-note") ?? el.querySelector(":scope > .card-head")!.insertAdjacentElement("afterend", h("p", { class: "card-stale-note warn", role: "status" }))!;
  note.textContent = text;
}

/**
 * Show `cards` in `list`, in order, keeping each card that didn't change
 * (or, unless `force`, holds an unsent form) as the node it is. A kept
 * draft is never moved either, since moving a node takes the focus out of
 * it: the other cards are placed around it.
 */
export function fillInbox(list: HTMLElement, cards: readonly Card[], hooks: InboxHooks, force = false): void {
  const shown = new Map([...list.querySelectorAll<HTMLElement>(`:scope > .${CARD_CLASS}`)].map((el) => [el.getAttribute(ROW_KEY_ATTR)!, el]));
  const keep = (el: HTMLElement): boolean => !force && holdsDraft(el);
  const wanted = cards.map((c) => {
    const el = shown.get(c.key);
    shown.delete(c.key);
    if (el && el.getAttribute(SIG_ATTR) === cardSignature(c) && !el.classList.contains(CARD_STALE_CLASS)) return el;
    if (el && keep(el)) {
      staleNote(el, CARD_CHANGED_NOTE);
      return el;
    }
    const fresh = cardEl(c, hooks);
    el?.replaceWith(fresh);
    return fresh;
  });
  for (const el of shown.values()) {
    if (keep(el)) staleNote(el, CARD_GONE_NOTE);
    else el.remove();
  }
  let cursor: HTMLElement | undefined;
  for (const el of wanted) {
    if (!(keep(el) && el.isConnected)) {
      const at = cursor ? cursor.nextElementSibling : list.firstElementChild;
      if (at !== el) {
        if (cursor) cursor.after(el);
        else list.prepend(el);
      }
    }
    cursor = el;
  }
}
