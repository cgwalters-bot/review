// Build once, fill in place: changing views must not discard an unsent answer.
import { h } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import type { ProjectStatus } from "./backend.ts";
import type { Item } from "./board.ts";
import { TRACKER_REPO } from "./config.ts";
import type { People } from "./people.ts";
import { peopleView } from "./peopleview.ts";
import { PREVIEW_ROWS, SECTION_HINT, SECTION_TITLE, type SectionId } from "./sections.ts";
import { VIEW_ATTR } from "./shell.ts";
import type { PageState } from "./state.ts";
import { agoLabel, ROW_CLASS } from "./view.ts";

export const HOME_CLASS = "home";
export const SECTION_CLASS = "sec";
export const COUNT_CLASS = "sec-count";
export const VIEW_ALL_CLASS = "view-all";

export interface SectionEls {
  details: HTMLDetailsElement;
  count: HTMLElement;
  body: HTMLElement;
}

export interface Home {
  el: HTMLElement;
  sections: Record<SectionId, SectionEls>;
  slots: { people: HTMLElement; peopleCount: HTMLElement; freshness: HTMLElement; statusNote: HTMLElement };
  expected: Map<SectionId, boolean>;
}

export interface HomeHooks {
  open(id: SectionId): boolean;
  toggled(id: SectionId, open: boolean): void;
  peopleToggled?(open: boolean): void;
}

export function homeSkeleton(hooks: HomeHooks): Home {
  const count = h("span", { class: COUNT_CLASS }, "…");
  const body = h("div", { class: "sec-body" });
  const details = h("details", { class: `${SECTION_CLASS} sec-needs`, id: "sec-needs", [VIEW_ATTR]: "inbox" },
    h("summary", {}, h("span", { class: "sec-title" }, SECTION_TITLE.needs), count, h("span", { class: "sec-hint" }, SECTION_HINT.needs)), body);
  details.open = true;
  const expected = new Map<SectionId, boolean>([["needs", true]]);
  details.addEventListener("toggle", () => {
    if (details.open === expected.get("needs")) return;
    expected.set("needs", details.open);
    hooks.toggled("needs", details.open);
  });
  const people = h("div", { class: "people-slot sec-body" });
  const peopleCount = h("span", { class: COUNT_CLASS }, "…");
  const peopleSection = h("details", { class: `${SECTION_CLASS} sec-people`, id: "sec-people", [VIEW_ATTR]: "inbox" },
    h("summary", {}, h("span", { class: "sec-title" }, "From people (opt in)"), peopleCount), people);
  peopleSection.addEventListener("toggle", () => hooks.peopleToggled?.(peopleSection.open));
  const statusNote = h("section", { class: "status-note", [VIEW_ATTR]: "status", "aria-label": "Published status" });
  const freshness = h("p", { class: "source-freshness note", "aria-label": "Source freshness" });
  const el = h("div", { class: HOME_CLASS }, details, peopleSection, statusNote, freshness);
  return { el, sections: { needs: { details, count, body } }, slots: { people, peopleCount, statusNote, freshness }, expected };
}

export function fillState(home: Home, state: PageState): void {
  const now = Date.now();
  home.slots.freshness.hidden = Object.values(state.sources).every((s) => s.state === "ok" || s.state === "pending");
  home.slots.freshness.replaceChildren(...Object.entries(state.sources).flatMap(([name, source], i) => [
    i ? " · " : "", `${name}: ${source.state}`,
    source.checkedAt ? h("span", {}, " (checked ", agoLabel(new Date(source.checkedAt).toISOString(), now), ")")
      : source.fetchedAt ? h("span", {}, " (cached ", agoLabel(new Date(source.fetchedAt).toISOString(), now), ")") : "",
    source.publishedAt ? h("span", {}, " · published ", agoLabel(source.publishedAt, now)) : "",
    source.error ? ` — ${source.error}` : "",
  ]));
}

export function setSectionOpen(home: Home, id: SectionId, open: boolean, remember: boolean, hooks: Pick<HomeHooks, "toggled">): void {
  const { details } = home.sections[id];
  if (details.open === open) return;
  if (remember) hooks.toggled(id, open);
  home.expected.set(id, open);
  details.open = open;
}

export function setCount(home: Home, id: SectionId, text: string, opts: { title?: string; hot?: boolean } = {}): void {
  const el = home.sections[id].count;
  el.textContent = text;
  el.title = opts.title ?? "";
  el.classList.toggle("hot", opts.hot === true);
}

export function fillPeople(home: Home, people: People | undefined, now: number, hooks: Parameters<typeof peopleView>[2]): void {
  home.slots.peopleCount.textContent = people ? String(people.rows.length) : "…";
  home.slots.people.replaceChildren(peopleView(people, now, hooks));
  applyLimit(home.slots.people, "people", ".people-row");
}

const expanded = new Set<string>();

export function resetExpanded(): void {
  expanded.clear();
}

export function applyLimit(slot: HTMLElement, id: string, rowSelector: string, limit: number = PREVIEW_ROWS): void {
  slot.querySelector(`:scope > .${VIEW_ALL_CLASS}`)?.remove();
  const rows = [...slot.querySelectorAll<HTMLElement>(rowSelector)];
  const all = expanded.has(id);
  rows.forEach((r, i) => { r.hidden = !all && i >= limit; });
  for (const box of slot.querySelectorAll<HTMLElement>("section.group, ul")) {
    const inside = rows.filter((r) => box.contains(r));
    const empty = inside.length > 0 && inside.every((r) => r.hidden);
    box.hidden = empty;
    const before = box.previousElementSibling;
    if (before?.tagName === "H3") (before as HTMLElement).hidden = empty;
  }
  if (rows.length <= limit) return;
  const button = h("button", { type: "button", class: `small ${VIEW_ALL_CLASS}`, "aria-expanded": String(all) }, all ? "Show fewer" : `View all ${rows.length}`);
  button.addEventListener("click", () => {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    applyLimit(slot, id, rowSelector, limit);
  });
  slot.append(button);
}

export function walkRows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`.${ROW_CLASS}`)].filter((r) => !r.closest("[hidden], details:not([open])"));
}

export function stepRow(rows: readonly HTMLElement[], selected: HTMLElement | undefined, step: 1 | -1): HTMLElement | undefined {
  const i = selected ? rows.indexOf(selected) : -1;
  return rows[Math.max(0, Math.min(rows.length - 1, i + step))];
}

// Restore full board titles only when the publisher cut the link label short.
function fullTitles(slot: HTMLElement, board: readonly Item[] | undefined): void {
  if (!board) return;
  const titles = new Map(board.flatMap((i) => (i.url ? [[i.url.toLowerCase(), i.title] as const] : [])));
  for (const a of slot.querySelectorAll("a[href]")) {
    const title = titles.get(a.getAttribute("href")!.toLowerCase());
    const cut = /^(.+?)(?:…|\.\.\.)$/s.exec(a.textContent ?? "");
    if (title && cut && title !== a.textContent && title.startsWith(cut[1]!)) a.textContent = title;
  }
}

/** Published facts only; no board-derived risk, scheduler or usage policy. */
export function fillStatus(home: Home, status: ProjectStatus | null | undefined, render: Renderer, error?: string, now = Date.now(), board?: readonly Item[]): void {
  const slot = home.slots.statusNote;
  const timestamp = status ? Date.parse(status.createdAt) : NaN;
  const age = () => {
    const el = slot.querySelector<HTMLElement>(".status-age");
    if (!el) return;
    el.replaceChildren(...(status && Number.isFinite(timestamp) ? ["Published ", agoLabel(status.createdAt, now)] : ["Status age unknown"]));
  };
  age();
  if (status && slot.dataset.signature === JSON.stringify(status)) {
    fullTitles(slot, board);
    return;
  }
  slot.dataset.signature = JSON.stringify(status) ?? "";
  slot.replaceChildren(h("h2", {}, "Coordinator's note"));
  if (!status) {
    slot.append(h("p", { class: "note" }, error ?? (status === null ? "No project status update yet." : "Reading project status…")));
    return;
  }
  const body = h("div", { class: "md status-preview" }, render(status.body, TRACKER_REPO));
  const paragraph = body.querySelector(":scope > p") ?? body.firstElementChild;
  paragraph?.classList.add("status-summary");
  const button = h("button", { type: "button", class: "small", "aria-expanded": "false" }, "Expand");
  button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    body.classList.toggle("status-preview", !open);
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Collapse" : "Expand";
  });
  slot.append(h("p", { class: "note status-age" }), body, button);
  fullTitles(slot, board);
  age();
}
