// The inbox's cards (inbox.ts) on the page. Cards are kept by key across
// polls: an unchanged card is left alone, a changed one redrawn, a gone one
// removed. A card holding an unsent form (a pick, a reply, a half-written
// answer) is never redrawn, moved or removed under him: it stays as it is,
// marked as changed, until he sends or clears it, or reloads with r.

import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import type { DocumentEntry } from "./decisiondocument.ts";
import { type Heartbeat, isStale } from "./heartbeat.ts";
import type { Ask, Holds } from "./holds.ts";
import { askHref, type Card, CARD_LABEL } from "./inbox.ts";
import type { ApproveItem, ApproveResult } from "./maintain.ts";
import { approveGroup, KEEP_ATTR, KEEP_BUSY } from "./maintainview.ts";
import { age, pill, ROW_CLASS, ROW_HREF_ATTR, ROW_KEY_ATTR, ROW_SECTION_ATTR, SINCE_ATTR } from "./view.ts";

export const CARD_CLASS = "card";
export const CARD_DONE_CLASS = "card-done";
/** On a card kept for its unsent form though what it shows changed or left. */
export const CARD_STALE_CLASS = "card-stale";
/** On a card from a list that can't be read now. */
export const CARD_UNAVAILABLE_CLASS = "card-unavailable";
const SIG_ATTR = "data-sig";

export const CARD_CHANGED_NOTE = "This changed since it was drawn; send or clear your text, or press r to reload it (unsent text is lost).";
export const CARD_GONE_NOTE = "This has left the inbox; your unsent text is kept until you clear it or press r.";

export interface InboxHooks {
  /** Session receipts, keyed by target and ask, not visual card metadata. */
  writes?: Map<string, HTMLElement>;
  /** An Answer card's body: its target and question read now, with the form that answers it. */
  answerBody?(a: Ask): Promise<HTMLElement>;
  now: number;
  render: Renderer;
  /** Whether the signed-in token may act (the operator's, or not yet named). */
  mayAct: boolean;
  /** Tick option `letter` of document entry `entry` (as the card shows it) and fill its reply. */
  answerEntry(entry: DocumentEntry, letter: string, reply: string): Promise<void>;
  /** The body of a Send card: the draft as its review will look, with Send. */
  draftBody?(card: Card & { kind: "send" }): Promise<HTMLElement>;
  /** A Do card's body: its proposal read again, its live facts and exact mutations, with Run. */
  offerBody?(a: Ask): Promise<HTMLElement>;
  /** Approve at `head`, refusing a moved head; URL if written, undefined if already approved. */
  approve?(a: Ask, head: string): Promise<string | undefined>;
  /** Send the digest's picked approvals (approveSelected). */
  approveDigest?(items: readonly ApproveItem[]): Promise<ApproveResult[]>;
}

/** Why the write may or may not have happened, and that nothing retries it. */
const failed = (e: unknown): string => `Not sent, or uncertain: ${e instanceof Error ? e.message : String(e)}. Check on GitHub before trying again.`;

/**
 * Approve in place at the pass's head. The write checks the live head and
 * viewer's approvals, not every card on every poll.
 */
function approveBody(a: Ask, hooks: InboxHooks): HTMLElement {
  const head = a.action.head!;
  const where = `${a.action.repository}#${a.action.number}`;
  const button = h("button", { type: "button", class: "primary" }, `Approve ${head.slice(0, 7)}`);
  const status = h("p", { class: "status", role: "status" });
  button.addEventListener("click", () => {
    if (button.disabled || !window.confirm(`Approve ${where} at ${head.slice(0, 12)} as you, without its diff open here? If the head moved, nothing is sent.`)) return;
    button.disabled = true;
    status.textContent = "Sending…";
    status.setAttribute(KEEP_ATTR, KEEP_BUSY);
    hooks.approve!(a, head).then((url) => {
      status.removeAttribute(KEEP_ATTR);
      // Sent: a redraw shows this card again rather than offer the approval twice.
      status.setAttribute("data-sent", "");
      status.closest(`.${CARD_CLASS}`)?.classList.add(CARD_DONE_CLASS);
      status.replaceChildren(...(url ? ["Approved: ", link(url, url)] : ["Skipped: already approved at HEAD."]));
    }, (e: unknown) => {
      // Kept until r, which reads the head again: it may have moved, or the approval gone out.
      status.setAttribute(KEEP_ATTR, "");
      status.textContent = failed(e);
      button.disabled = false;
    });
  });
  return h("div", { class: "card-body actions" }, button, status);
}

/** Cards drawn at first, about a phone's screen; "Show more" draws as many again. */
export const INBOX_PAGE = 5;
const MORE_CLASS = "inbox-more";
const LIMIT_ATTR = "data-limit";

/** What a card shows, so an unchanged card is not redrawn. Its age is left out: the ticker moves it in place. */
export function cardSignature(c: Card): string {
  const base = [c.kind, c.key, c.title, c.where, c.url, c.since, c.answered === true, c.note, c.priority, c.unavailable === true];
  switch (c.kind) {
    case "answer":
    case "approve":
    case "open":
    case "do": return JSON.stringify([...base, c.ask.action]);
    case "digest": return JSON.stringify([...base, c.items]);
    case "send": return JSON.stringify([...base, c.draft.issue.body, c.draft.box, c.draft.found?.raw, c.draft.refused]);
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
  if (card.querySelector(`[${KEEP_ATTR}]`)) return true;
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

/** What a link card's action asks, by the type of its action. */
const VERB: Record<string, string> = { review_pull_request: "Review", reply_pull_request: "Reply", close_pull_request: "Close or keep" };

/** The card's in-place action or body, read on drawing where it needs to be; else a link to where it is done. */
function action(c: Card, hooks: InboxHooks): HTMLElement | null {
  if (c.answered) return null;
  switch (c.kind) {
    case "answer": if (hooks.answerBody && hooks.mayAct) return bodySlot(hooks.answerBody(c.ask)); break;
    case "approve": if (hooks.approve && hooks.mayAct) return approveBody(c.ask, hooks); break;
    case "do": if (hooks.offerBody) return bodySlot(hooks.offerBody(c.ask)); break;
    case "open": break;
    case "document": return hooks.mayAct && c.entry.options.length ? entryForm(c, hooks) : null;
    case "send": return hooks.draftBody ? bodySlot(hooks.draftBody(c)) : null;
    case "digest": return hooks.approveDigest && hooks.mayAct ? approveGroup(c.items, hooks.approveDigest) : null;
  }
  return h("a", { class: "action", href: askHref(c.ask.action) }, VERB[c.ask.action.type] ?? "Open");
}

/**
 * What holds every new run (wip, pools), said once over the cards; nothing
 * when no such hold is published. The pass rewrites its holds only when
 * they change, so whether they still stand is judged by the coordinator's
 * heartbeat, not by when they were written.
 */
export function passLine(holds: Holds | undefined, heartbeat: Heartbeat | null | undefined, now: number): HTMLElement | null {
  const pass = holds?.holds.filter((x) => x.item === null).map((x) => `${x.kind}: ${x.reason}`) ?? [];
  if (!pass.length) return null;
  const stale = !heartbeat || isStale(heartbeat, now);
  return h("p", { class: `note pass-holds${stale ? " warn" : ""}` }, `New runs wait: ${pass.join("; ")}`, stale ? " · the pass's heartbeat is stale" : "");
}

/** A slot filled with `body` when it arrives (it reads its targets on drawing). */
function bodySlot(body: Promise<HTMLElement>): HTMLElement {
  const slot = h("div", { class: "card-body" }, h("p", { class: "note" }, "Reading…"));
  body.then((b) => slot.replaceChildren(b), (e: unknown) => slot.replaceChildren(h("p", { class: "warn" }, String(e))));
  return slot;
}

export function cardEl(c: Card, hooks: InboxHooks): HTMLElement {
  // An answer keeps its own receipts (answerBody); the rest by what they write.
  const key = JSON.stringify(c.kind === "digest" ? [c.kind, c.items.map((a) => [a.pr, a.head])] : c.kind === "send" ? [c.kind, c.key, c.draft.issue.body, c.draft.found?.raw] : c.kind === "document" ? [c.kind, c.key, cardSignature(c)] : [c.kind, c.key, c.ask.action]);
  const previous = hooks.writes?.get(key);
  if (c.kind !== "answer" && previous?.querySelector("[data-sent], [data-keep]")) return previous;
  const head = h("div", { class: "card-head" },
    h("span", { class: `kind c-${c.kind}` }, CARD_LABEL[c.kind]),
    c.priority ? pill(c.priority) : null,
    h("span", { class: "title" }, c.url ? link(c.url, c.title) : c.title),
    h("span", { class: "age", ...(c.since ? { [SINCE_ATTR]: c.since, title: c.since } : {}) }, age(c.since, hooks.now)));
  const ask = "ask" in c ? c.ask : undefined;
  const el = h("article", {
    class: `${ROW_CLASS} ${CARD_CLASS} c-${c.kind}${c.answered ? ` ${CARD_DONE_CLASS}` : ""}${c.unavailable ? ` ${CARD_UNAVAILABLE_CLASS}` : ""}`,
    tabindex: "-1",
    [ROW_KEY_ATTR]: c.key,
    [ROW_SECTION_ATTR]: "inbox",
    [ROW_HREF_ATTR]: ask ? askHref(ask.action) : "#",
    [SIG_ATTR]: cardSignature(c),
  }, head, h("p", { class: "card-where" }, c.where),
  c.unavailable ? h("p", { class: "card-note warn" }, "Unavailable: from the last list read; the pass's list can't be read now.") : null,
  c.note ? h("p", { class: "card-note" }, c.note) : null);
  if (c.kind === "document" && c.entry.text.trim()) el.append(h("details", { class: "dec-body" }, h("summary", {}, "The whole entry"), h("div", { class: "md" }, hooks.render(c.entry.text, c.entry.about?.repo))));
  // Read on drawing (the target and its ask, the PR's head, the proposal's facts, the draft's PR): filled in when it arrives.
  const act = action(c, hooks);
  if (act) el.append(act);
  if (c.kind !== "answer") hooks.writes?.set(key, el);
  return el;
}

function staleNote(el: Element, text: string): void {
  el.classList.add(CARD_STALE_CLASS);
  const note = el.querySelector(":scope > .card-stale-note") ?? el.querySelector(":scope > .card-head")!.insertAdjacentElement("afterend", h("p", { class: "card-stale-note warn", role: "status" }))!;
  note.textContent = text;
}

/** The "Show more" button after `list`, for the cards of `total` not drawn yet; none when there are none. */
function moreButton(list: HTMLElement, drawn: number, total: number, more: () => void): void {
  const next = list.nextElementSibling;
  const old = next?.classList.contains(MORE_CLASS) ? next : null;
  if (drawn >= total) {
    old?.remove();
    return;
  }
  // Counted as the section's heading counts: every card in the list.
  const button = h("button", { type: "button", class: `small ${MORE_CLASS}` }, `Show ${Math.min(total - drawn, INBOX_PAGE)} more · ${drawn} of ${total} shown`);
  button.addEventListener("click", more);
  if (old) old.replaceWith(button);
  else list.after(button);
}

/**
 * Show `cards` in `list`, in order, keeping each card that didn't change
 * (or, unless `force`, holds an unsent form) as the node it is. A kept
 * draft is never moved either, since moving a node takes the focus out of
 * it: the other cards are placed around it. Only the first INBOX_PAGE cards
 * (more after "Show more") are drawn, so the ones further down read
 * nothing; a drawn card holding a draft stays however far it moved.
 * Returns how many cards the list holds, drawn or not: those of `cards`
 * and those kept for a draft though they left, as the heading counts them.
 */
export function fillInbox(list: HTMLElement, cards: readonly Card[], hooks: InboxHooks, force = false): number {
  const shown = new Map([...list.querySelectorAll<HTMLElement>(`:scope > .${CARD_CLASS}`)].map((el) => [el.getAttribute(ROW_KEY_ATTR)!, el]));
  // Not even r redraws writes still going out: a fresh card would offer them again.
  const keep = (el: HTMLElement): boolean => (!force && holdsDraft(el)) || el.querySelector(`[${KEEP_ATTR}="${KEEP_BUSY}"]`) !== null;
  const limit = Number(list.getAttribute(LIMIT_ATTR)) || INBOX_PAGE;
  const drawn = cards.filter((c, i) => {
    if (i < limit) return true;
    const el = shown.get(c.key);
    return el !== undefined && keep(el);
  });
  const more = () => {
    list.setAttribute(LIMIT_ATTR, String(limit + INBOX_PAGE));
    fillInbox(list, cards, hooks);
  };
  const wanted = drawn.map((c) => {
    const el = shown.get(c.key);
    shown.delete(c.key);
    // r clears a write's kept report too, reading the card's state again.
    const report = force && el?.querySelector(`[${KEEP_ATTR}=""]`);
    if (el && el.getAttribute(SIG_ATTR) === cardSignature(c) && !el.classList.contains(CARD_STALE_CLASS) && !report) return el;
    if (el && keep(el)) {
      staleNote(el, CARD_CHANGED_NOTE);
      return el;
    }
    const fresh = cardEl(c, hooks);
    el?.replaceWith(fresh);
    return fresh;
  });
  let gone = 0;
  for (const el of shown.values()) {
    if (keep(el)) {
      staleNote(el, CARD_GONE_NOTE);
      gone++;
    } else el.remove();
  }
  moreButton(list, drawn.length + gone, cards.length + gone, more);
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
  return cards.length + gone;
}
