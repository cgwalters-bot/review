// The inbox's cards (inbox.ts) on the page. Cards are kept by key across
// polls: an unchanged card is left alone, a changed one redrawn, a gone one
// removed. A card holding an unsent form (a pick, a reply, a half-written
// answer) is never redrawn, moved or removed under him: it stays as it is,
// marked as changed, until he sends or clears it, or reloads with r.

import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import { chatButton, type ChatItem } from "./chatitem.ts";
import type { DocumentEntry } from "./decisiondocument.ts";
import { type Heartbeat, isStale } from "./heartbeat.ts";
import type { MemberPr } from "./backend.ts";
import type { IssueRef } from "./board.ts";
import { refKey } from "./forge.ts";
import type { Ask, Holds, InboxContext } from "./holds.ts";
import { askHref, type Card, CARD_LABEL, githubTarget, members, refusal } from "./inbox.ts";
import { approvalKey, type ApproveItem, type ApproveResult } from "./maintain.ts";
import { approveGroup, KEEP_ATTR, KEEP_BUSY } from "./maintainview.ts";
import { age, pill, ROW_CLASS, ROW_HREF_ATTR, ROW_KEY_ATTR, ROW_SECTION_ATTR, SINCE_ATTR } from "./view.ts";

export const CARD_CLASS = "card";
export const CARD_DONE_CLASS = "card-done";
/** On a card kept for its unsent form though what it shows changed or left. */
export const CARD_STALE_CLASS = "card-stale";
/** On a card from a list that can't be read now. */
export const CARD_UNAVAILABLE_CLASS = "card-unavailable";
const SIG_ATTR = "data-sig";
const POLICY_ATTR = "data-policy";
const retired = new WeakSet<Element>();

export const CARD_CHANGED_NOTE = "This changed since it was drawn; send or clear your text, or press r to reload it (unsent text is lost).";
export const CARD_GONE_NOTE = "This has left the inbox; your unsent text is kept until you clear it or press r.";

export interface InboxHooks {
  changed?(): void;
  publishedBody?(a: Ask): Promise<HTMLElement>;
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
  /** Approve at `head`, retaining the write's structured outcome. */
  approve?(a: Ask, head: string): Promise<ApproveResult>;
  /** Read one of a card's PRs now (readMember). */
  member?(ref: IssueRef): Promise<MemberPr>;
  promote?(a: Ask, ref: IssueRef, head: string): Promise<string | undefined>;
  /** Send the digest's picked approvals (approveSelected). */
  approveDigest?(items: readonly ApproveItem[]): Promise<ApproveResult[]>;
  /** A card's chat context, for its Chat button; none for a card about no item. */
  chatItem?(c: Card): ChatItem | undefined;
}

/** Why the write may or may not have happened, and that nothing retries it. */
const failed = (e: unknown): string => `Not sent, or uncertain: ${e instanceof Error ? e.message : String(e)}. Check on GitHub before trying again.`;

/**
 * One confirmed write in place, as the viewer. Nothing retries it. Its
 * receipt, sent or uncertain, is kept under `key` in the session's writes,
 * so a redraw shows it rather than offer the write again, and says at once
 * what it now waits on (`done`). Its card is marked done.
 */
function writeButton(hooks: InboxHooks, key: string, label: string, question: string, write: () => Promise<string | undefined | ApproveResult>, done: (url: string | undefined) => (string | Node)[], reread = false): HTMLElement {
  const previous = hooks.writes?.get(key);
  if (previous?.querySelector(`[data-sent], [${KEEP_ATTR}="${KEEP_BUSY}"]`)) return presentReceipt(previous);
  const button = h("button", { type: "button", class: "primary" }, label);
  const status = h("p", { class: "status", role: "status" });
  button.addEventListener("click", () => {
    // Another already-drawn card may have attempted this head since we drew.
    // Its session receipt outlives approveHead's bounded five-minute cache.
    const latest = hooks.writes?.get(key);
    if (latest && latest !== el && latest.querySelector("[data-sent]")) {
      el.replaceChildren(presentReceipt(latest.cloneNode(true) as HTMLElement, true));
      return;
    }
    if (button.disabled || !window.confirm(question)) return;
    button.disabled = true;
    status.textContent = "Sending…";
    status.setAttribute(KEEP_ATTR, KEEP_BUSY);
    void (async () => {
      const result = await write();
      if (result && typeof result !== "string" && !["approved", "already-approved"].includes(result.status)) {
        const e = new Error(result.note ?? result.status);
        if (result.status === "uncertain") e.name = "MaybeSentError";
        throw e;
      }
      const url = typeof result === "object" ? result.url : result;
      status.removeAttribute(KEEP_ATTR);
      status.setAttribute("data-sent", "");
      if (!reread) status.closest(`.${CARD_CLASS}`)?.classList.add(CARD_DONE_CLASS);
      const outcome = done(url);
      status.replaceChildren(...(status.closest("[data-receipt-only]") ? outcome.map((x) => typeof x === "string" ? x : x.textContent ?? "") : outcome));
    })().catch((e: unknown) => {
      // Kept until r, which reads the target again: it may have moved, or the write gone out.
      status.setAttribute(KEEP_ATTR, "");
      status.textContent = e instanceof Error && e.name === "MaybeSentError" ? failed(e) : `Not sent: ${e instanceof Error ? e.message : String(e)}`;
      if (e instanceof Error && e.name === "MaybeSentError") status.setAttribute("data-sent", "");
      else button.disabled = reread;
    }).finally(() => hooks.changed?.());
  });
  const el = h("div", { class: "card-body actions" }, button, status);
  hooks.writes?.set(key, el);
  return el;
}

/** What an approval releases, and what it doesn't. */
export const APPROVED_WAIT = "Waiting on the agent: this releases only the approval wait; checks and merge policy still decide.";

/**
 * Approve in place at the pass's head. The write checks the live head and
 * viewer's approvals, not every card on every poll.
 */
function approveBody(a: Ask, hooks: InboxHooks): HTMLElement {
  const head = a.action.head!;
  const where = `${a.action.repository}#${a.action.number}`;
  const [owner = "", repo = ""] = a.action.repository.split("/");
  return writeButton(hooks, approvalKey({ owner, repo, number: a.action.number }, head), `Approve ${head.slice(0, 7)}`,
    `Approve ${where} at ${head.slice(0, 12)} as you, without its diff open here? If the head moved, nothing is sent.`, () => hooks.approve!(a, head),
    (url) => (url ? ["Approved: ", link(url, url), `. ${APPROVED_WAIT}`] : ["Skipped: already approved at HEAD."]));
}

/** Digest rows belong to their report; other receipts stay live, including pending writes. */
function presentReceipt(el: HTMLElement, only = false): HTMLElement {
  if (el.hasAttribute("data-approval-receipt")) el = el.cloneNode(true) as HTMLElement;
  if (!only) return el;
  el.setAttribute("data-receipt-only", "");
  for (const control of el.querySelectorAll("button, input, textarea, select")) control.remove();
  for (const a of el.querySelectorAll("a")) a.removeAttribute("href");
  return el;
}

/** Receipts for this target only, including a write still going out. */
function memberReceipts(ref: IssueRef, hooks: InboxHooks): [string, HTMLElement][] {
  const prefix = JSON.stringify(["approve", refKey(ref).toLowerCase()]).slice(0, -1) + ",";
  return [...(hooks.writes ?? [])].filter(([key, el]) => key.startsWith(prefix) && el.querySelector(`[data-sent], [${KEEP_ATTR}]`));
}

/** One member read now: its facts, and on a Promote card its own Promote or why there is none. */
async function memberBody(c: Card & { ask: Ask }, ref: IssueRef, hooks: InboxHooks, current: () => boolean): Promise<HTMLElement> {
  let m: MemberPr;
  try { m = await hooks.member!(ref); }
  catch (e) { return current() ? h("div", {}, h("p", { class: "warn" }, String(e)), ...memberReceipts(ref, hooks).map(([, el]) => presentReceipt(el, true))) : h("div"); }
  // Receipts are shared live nodes: an obsolete read must not move them off the current card.
  if (!current()) return h("div");
  const receipts = memberReceipts(ref, hooks);
  const where = refKey(m.ref);
  const facts = h("p", {}, link(m.url, m.title), ` · ${m.state} · ${m.head.slice(0, 7)} · by ${m.author} · `, h("a", { href: `#pr/${where.replace("#", "/")}` }, "Review"));
  if (c.kind !== "promote") return h("div", {}, facts);
  const no = [refusal(c.ask, "promote"), m.problem, m.state !== "open draft" ? `member is ${m.state}, not an open draft` : undefined].filter(Boolean).join("; ");
  const key = approvalKey(m.ref, m.head);
  return h("div", {}, facts, ...receipts.filter(([k]) => k !== key || no || !hooks.mayAct).map(([, el]) => presentReceipt(el, true)), no ? h("p", { class: "warn" }, `Promote not offered: ${no}.`) : hooks.mayAct && hooks.promote ?
    writeButton(hooks, key, `Promote ${m.head.slice(0, 7)}`,
      `Approve ${where} at ${m.head} for promotion as you? A changed member must be reread and confirmed again.`,
      () => hooks.promote!(c.ask, ref, m.head),
      (url) => [url ? "Approval sent: " : "Already approved: ", ...(url ? [link(url, url)] : []), " Waiting on promoter; promotion is not completed."], true) : null);
}

/** A card's PRs, each read only when he opens it: a group's members, or a Promote card's PR. */
function memberList(c: Card & { ask: Ask }, hooks: InboxHooks): HTMLElement | null {
  const [owner = "", repo = ""] = c.ask.action.repository.split("/");
  if (!hooks.member) return h("div", { class: "card-body" }, "Inspect each member; no group writes.",
    h("ul", {}, ...members(c.ask).map((number) => h("li", {}, h("a", { href: askHref({ ...c.ask.action, number }) }, `Inspect ${c.ask.action.repository}#${number}`)))));
  return h("div", { class: "card-body members" }, ...members(c.ask).map((number) => {
    const d = h("details", { class: "member" }, h("summary", {}, `${c.ask.action.repository}#${number}`, " · ", h("a", { href: askHref({ ...c.ask.action, number }) }, "Inspect")));
    const current = () => d.isConnected && !retired.has(d.closest(`.${CARD_CLASS}`)!);
    d.addEventListener("toggle", () => {
      if (current() && d.open && d.children.length === 1) d.append(bodySlot(memberBody(c, { owner, repo, number }, hooks, current)));
    });
    return d;
  }));
}

const STEP: Record<string, string> = { promote: "promote", "merge-or-enqueue": "merge or enqueue", reply: "reply", close: "close", "review-at-head": "approve at the head", "check-proposal": "run the proposal" };

/** The steps a card's own path takes, through its own checks, whatever the pass supplies. */
const OWN: Partial<Record<Card["kind"], string>> = { promote: "promote", answer: "reply" };

/** The steps the pass says are not supported from its request, each with its reason, less the card's own. */
function notOffered(c: Card & { ask: Ask }): HTMLElement | null {
  const off = (c.ask.requests ?? []).flatMap((r) => r.actions).filter((x) => !x.supported && OWN[c.kind] !== x.kind).filter((x, i, all) => all.findIndex((y) => y.kind === x.kind) === i);
  if (!off.length) return null;
  return h("details", { class: "not-offered" }, h("summary", {}, `Not offered here: ${off.map((x) => STEP[x.kind] ?? x.kind).join(", ")}`),
    h("ul", {}, ...off.map((x) => h("li", {}, `${STEP[x.kind] ?? x.kind}: ${x.reason}`))));
}

/** In place of a write the pass or the forge rules out: why, and where to look. */
const refused = (why: string, a: Ask): HTMLElement => h("div", { class: "card-body" }, h("p", { class: "warn" }, `Not offered here: ${why}`), githubTarget(a) ? h("a", { class: "action", href: askHref(a.action) }, "Inspect") : null);

/** Cards drawn at first, about a phone's screen; "Show more" draws as many again. */
export const INBOX_PAGE = 5;
const MORE_CLASS = "inbox-more";
const LIMIT_ATTR = "data-limit";

/** What a card shows, so an unchanged card is not redrawn. Its age is left out: the ticker moves it in place. */
export function cardSignature(c: Card): string {
  const base = [c.kind, c.key, c.title, c.where, c.url, c.since, c.answered === true, c.note, c.priority, c.unavailable === true];
  return JSON.stringify([...base, ...("ask" in c ? [c.ask.action, c.ask.group, c.ask.requests, c.ask.requestsUnreadable] :
    c.kind === "digest" ? [c.items] : c.kind === "send" ? [c.draft.issue.body, c.draft.box, c.draft.found?.raw, c.draft.refused] : [c.entry.text, c.mark])]);
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
    status.setAttribute(KEEP_ATTR, KEEP_BUSY);
    status.textContent = "Sending…";
    hooks.answerEntry(c.entry, picked, reply.value).then(() => {
      form.dataset.sent = "true";
      status.textContent = "Answered.";
      for (const input of form.querySelectorAll("input")) input.disabled = true;
    }, (e: unknown) => {
      status.textContent = `Not sent: ${e instanceof Error ? e.message : String(e)}`;
      button.disabled = false;
    }).finally(() => status.removeAttribute(KEEP_ATTR));
  });
  return form;
}

/** The card's in-place action or body, read on drawing where it needs to be; else a link to where it is done. */
function action(c: Card, hooks: InboxHooks): HTMLElement | null {
  if (c.answered) return null;
  const no = "ask" in c ? refusal(c.ask, c.kind === "approve" ? "review-at-head" : c.kind === "do" ? "check-proposal" : undefined) : undefined;
  if (no && "ask" in c) {
    const body = refused(no, c.ask);
    if (c.kind === "promote") for (const number of members(c.ask)) {
      const [owner = "", repo = ""] = c.ask.action.repository.split("/");
      for (const [, receipt] of memberReceipts({ owner, repo, number }, hooks)) {
        body.append(h("div", {}, `Prior write on ${owner}/${repo}#${number}:`, presentReceipt(receipt, true)));
      }
    }
    return body;
  }
  if ("ask" in c && (c.ask.group || c.kind === "promote")) return memberList(c, hooks);
  if ("ask" in c && (c.ask.source === "decisions" || c.ask.source === "drafts") && hooks.publishedBody) return bodySlot(hooks.publishedBody(c.ask));
  switch (c.kind) {
    case "answer": if (hooks.answerBody && hooks.mayAct) return bodySlot(hooks.answerBody(c.ask)); break;
    case "approve": if (hooks.approve && hooks.mayAct) return approveBody(c.ask, hooks); break;
    case "do": if (hooks.offerBody) return bodySlot(hooks.offerBody(c.ask)); break;
    case "document": return hooks.mayAct && c.entry.options.length ? entryForm(c, hooks) : null;
    case "send": return hooks.draftBody ? bodySlot(hooks.draftBody(c)) : null;
    case "digest": return hooks.approveDigest && hooks.mayAct ? approveGroup(c.items, hooks.approveDigest, hooks.writes) : null;
  }
  return h("a", { class: "action", href: askHref(c.ask.action) }, "Inspect");
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

/** Published facts only: never new human asks or write controls. */
export function publishedContext(context: InboxContext | undefined): HTMLDetailsElement {
  const fold = h("details", { class: "published-context" }, h("summary", {}, "Published context"));
  if (!context) {
    fold.append(h("p", { class: "note" }, "Context not published."));
    return fold;
  }
  fold.append(h("p", { class: "note" }, `Observed ${context.observedAt ?? "unknown"} · WIP ${context.wip?.inFlight ?? "unknown"}/${context.wip?.limit ?? "unknown"} · ${context.omitted} facts omitted.`,
    ` Sources: ${Object.entries(context.sources).map(([name, state]) => `${name} ${state}`).join(", ") || "not published"}. Unread sources are unknown, not empty.`),
    h("ul", {}, ...context.items.map((f) => h("li", {}, `${f.source} · ${f.item ?? "all new runs"} · ${f.kind}: ${f.reason} · observed ${f.observedAt ?? "unknown"}${f.since ? ` · since ${f.since}` : ""}`))),
    ...Object.entries(context.limits).map(([name, fields]) => h("p", { class: "note" }, `${name}: ${Object.entries(fields).map(([key, value]) => `${key} ${value}`).join(" · ")}`)));
  return fold;
}

/** A slot filled with `body` when it arrives. */
function bodySlot(body: Promise<HTMLElement>): HTMLElement {
  const slot = h("div", { class: "card-body" }, h("p", { class: "note" }, "Reading…"));
  body.then((b) => slot.replaceChildren(b), (e: unknown) => slot.replaceChildren(h("p", { class: "warn" }, String(e))));
  return slot;
}

export function cardEl(c: Card, hooks: InboxHooks): HTMLElement {
  // An answer keeps its own receipts (answerBody), and an Open card writes nothing; the rest by what they write.
  const key = JSON.stringify(c.kind === "digest" ? [c.kind, c.items.map((a) => [a.pr, a.head])] : c.kind === "send" ? [c.kind, c.key, c.draft.issue.body, c.draft.found?.raw] : c.kind === "document" ? [c.kind, c.key, cardSignature(c)] : [c.kind, c.key, c.ask.action, members(c.ask), policySignature(c)]);
  const previous = hooks.writes?.get(key);
  if (c.kind !== "answer" && c.kind !== "promote" && c.kind !== "open" && previous?.querySelector("[data-sent], [data-keep]")) return previous;
  const head = h("div", { class: "card-head" },
    h("span", { class: `kind c-${c.kind}` }, CARD_LABEL[c.kind]),
    c.priority ? pill(c.priority) : null,
    h("span", { class: "title", title: c.title }, c.url && !("ask" in c && c.ask.group) ? link(c.url, c.title) : c.title),
    h("span", { class: "age", ...(c.since ? { [SINCE_ATTR]: c.since, title: c.since } : {}) }, age(c.since, hooks.now)));
  const ask = "ask" in c ? c.ask : undefined;
  const el = h("article", {
    class: `${ROW_CLASS} ${CARD_CLASS} c-${c.kind}${c.answered ? ` ${CARD_DONE_CLASS}` : ""}${c.unavailable ? ` ${CARD_UNAVAILABLE_CLASS}` : ""}`,
    tabindex: "-1",
    [ROW_KEY_ATTR]: c.key,
    [ROW_SECTION_ATTR]: "inbox",
    [ROW_HREF_ATTR]: ask && githubTarget(ask) ? askHref(ask.action) : "#",
    [SIG_ATTR]: cardSignature(c),
    [POLICY_ATTR]: policySignature(c),
  }, head, h("p", { class: "card-where" }, c.where),
  c.unavailable ? h("p", { class: "card-note warn" }, "Unavailable: from the last list read; the pass's list can't be read now.") : null,
   c.note ? h("details", { class: "card-note" }, h("summary", {}, "Context"), h("p", {}, c.note)) : null);
  // The pass publishes the kind and head, not the diff or checks: say so rather than guess.
  if (c.kind === "approve") el.append(h("div", { class: "approval-evidence" },
    c.ask.kind === "review-withheld" ? pill("Review agent withheld") : null,
    h("span", {}, "Diff size and CI not published"),
    githubTarget(c.ask) ? h("a", { href: askHref(c.ask.action) }, "Review the diff") : null));
  if (ask?.requests?.some((r) => r.quality !== "decision")) el.append(h("small", { class: "note" }, [...new Set(ask.requests.map((r) => r.quality).filter((q) => q !== "decision"))].join(" · ")));
  const descriptions = ask?.requests?.filter((r) => r.detail);
  if (descriptions?.length) el.append(h("details", { class: "request-context" }, h("summary", {}, "Published decision context"),
    ...descriptions.map((r) => h("dl", {}, ...Object.entries(r.detail!).flatMap(([key, value]) => [h("dt", {}, key), h("dd", {}, value)])))));
  if (c.kind === "document" && c.entry.text.trim()) el.append(h("details", { class: "dec-body" }, h("summary", {}, "The whole entry"), h("div", { class: "md" }, hooks.render(c.entry.text, c.entry.about?.repo))));
  // Cold load and polls read the publication alone. Target reads are lazy;
  // action-time preflight remains independent of these inspection reads.
  if (((c.kind === "answer" && hooks.mayAct) || c.kind === "send" || c.kind === "do" || (ask && ["decisions", "drafts"].includes(ask.source))) && !(ask && refusal(ask))) {
    const fold = h("details", { class: "card-full" }, h("summary", {}, "Details and action"));
    fold.addEventListener("toggle", () => {
      if (!fold.open || fold.children.length > 1 || retired.has(el)) return;
      const act = action(c, hooks);
      if (act) fold.append(act);
    });
    el.append(fold);
  } else {
    const act = action(c, hooks);
    if (act) el.append(act);
  }
  const off = ask && !c.answered ? notOffered({ ...c, ask }) : null;
  if (off) el.append(off);
  // After the card's own action: chatting never stands in for it.
  const chat = chatButton(!ask || githubTarget(ask) ? hooks.chatItem?.(c) : undefined);
  if (chat) el.append(h("div", { class: "actions" }, chat));
  if (c.kind !== "answer" && c.kind !== "promote" && c.kind !== "open") hooks.writes?.set(key, el);
  return el;
}

/** A retained draft or receipt must not retain authority a newer list removed. */
function policySignature(c: Card): string {
  return JSON.stringify("ask" in c ? [c.ask.requests, c.ask.requestsUnreadable] : c.kind === "digest" ? c.items.map((a) => [a.pr, a.head]) : null);
}

/** Keep typed text and receipts, but retire their old handlers until an explicit reload. */
function retireActions(el: HTMLElement): void {
  retired.add(el);
  for (const button of el.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input[type=submit]")) button.disabled = true;
  for (const a of el.querySelectorAll("a")) a.removeAttribute("href");
  el.setAttribute(ROW_HREF_ATTR, "#");
  for (const type of ["click", "submit"]) el.addEventListener(type, (ev) => {
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
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
 * Returns the matching published card count, excluding departed drafts.
 */
export function fillInbox(list: HTMLElement, cards: readonly Card[], hooks: InboxHooks, force = false, selected?: ReadonlySet<string>): number {
  const shown = new Map([...list.querySelectorAll<HTMLElement>(`:scope > .${CARD_CLASS}`)].map((el) => [el.getAttribute(ROW_KEY_ATTR)!, el]));
  // Not even r redraws writes still going out: a fresh card would offer them again.
  const keep = (el: HTMLElement): boolean => (!force && holdsDraft(el)) || el.querySelector(`[${KEEP_ATTR}="${KEEP_BUSY}"]`) !== null;
  const limit = Number(list.getAttribute(LIMIT_ATTR)) || INBOX_PAGE;
  const matching = cards.filter((c) => !selected || selected.has(c.key));
  const page = new Set(matching.slice(0, limit).map((c) => c.key));
  const drawn = cards.filter((c) => {
    if (page.has(c.key)) return true;
    const el = shown.get(c.key);
    return el !== undefined && keep(el);
  });
  const more = () => {
    list.setAttribute(LIMIT_ATTR, String(limit + INBOX_PAGE));
    fillInbox(list, cards, hooks, false, selected);
  };
  const wanted = drawn.map((c) => {
    const el = shown.get(c.key);
    shown.delete(c.key);
    // r clears a write's kept report too, reading the card's state again.
    const report = force && el?.querySelector(`[${KEEP_ATTR}=""]`);
    if (el && el.getAttribute(SIG_ATTR) === cardSignature(c) && !el.classList.contains(CARD_STALE_CLASS) && !report && !(force && "ask" in c && (c.kind === "promote" || c.ask.group || ["decisions", "drafts"].includes(c.ask.source)))) return el;
    // A newly published group revokes the representative's old single-item form.
    if (el && keep(el) && !("ask" in c && (c.ask.group || c.kind === "promote"))) {
      if (el.getAttribute(POLICY_ATTR) !== policySignature(c)) retireActions(el);
      staleNote(el, CARD_CHANGED_NOTE);
      return el;
    }
    if (el) retired.add(el);
    const fresh = cardEl(c, hooks);
    if ("ask" in c && c.ask.group && c.kind !== "promote") {
      const prior = el?.querySelector<HTMLElement>(":scope > .prior-write");
      if (prior) fresh.append(prior);
      else if (el?.querySelector("[data-sent], [data-keep]")) {
        // Its outcome stays visible; its controls go, so a failed write offers no retry.
        fresh.append(presentReceipt(h("div", { class: "prior-write" }, "Prior write:", ...el.children), true));
      }
    }
    el?.replaceWith(fresh);
    return fresh;
  });
  let gone = 0;
  for (const el of shown.values()) {
    if (keep(el)) {
      // A filtered-out digest has no replacement key to compare policies
      // with. Keep its report/text, never its obsolete approval handlers.
      retireActions(el);
      staleNote(el, CARD_GONE_NOTE);
      // A poll must not hide an already-visible draft when its key leaves
      // the publication. Show everything also recovers drafts hidden earlier.
      if (!selected) el.hidden = false;
      if (!el.hidden) gone++;
    } else el.remove();
  }
  wanted.forEach((el, i) => { el.hidden = !!selected && !selected.has(drawn[i]!.key); });
  moreButton(list, drawn.filter((c) => !selected || selected.has(c.key)).length + gone, matching.length + gone, more);
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
  return matching.length;
}
