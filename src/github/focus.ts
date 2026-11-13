// Read-only consumer of agent-board#814's bounded epic_focus publication.
// Missing children, blockers or runs are unknown, not a browser scheduling signal.
import { h } from "../dom.ts";
import { isObject, time } from "./heartbeat.ts";
import { agoLabel } from "./view.ts";

interface Blocker {
  type: "operator" | "review" | "ci" | "hold" | "not-started" | "unknown";
  kind: string | null;
  reason: string | null;
  since: string | null;
  pull: string | null;
}
interface Child {
  item: string | null;
  url: string | null;
  title: string | null;
  source: "sub-issue" | "task" | "both";
  state: "open" | "done";
  blocker: Blocker | null;
}
interface Run {
  item: string;
  kind: string;
  pool: string;
  run: { repository: string; id: number };
  started_at?: string | null;
}
interface Epic {
  item: string;
  url: string;
  title: string | null;
  goal: string | null;
  changed_at: string | null;
  progress: { done: number; total: number };
  operator_blocked: number;
  blocker: Blocker | null;
  runs: Run[];
  runs_omitted: number;
  children: Child[];
  omitted: number;
}
export interface EpicFocus {
  schema: "agent-board/epic-focus/v1";
  observed_at: string;
  priority: "P0";
  complete: boolean;
  sources: { epics: "complete" | "partial" | "unread"; runs: "complete" | "unread"; board: "complete" | "unread" };
  unread_epics: number;
  omitted: number;
  epics: Epic[];
}

const repository = (v: unknown): v is string => typeof v === "string" && v.length <= 201 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) && v.split("/").every((s) => s !== "." && s !== "..");
const item = (v: unknown): v is string => typeof v === "string" && repository(v.split("#")[0]) && /^[^#]+#[1-9]\d{0,9}$/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max * 2 && [...v].length <= max && !/[\x00-\x1f\x7f]/.test(v);
const nullable = (v: unknown, check: (v: unknown) => unknown): boolean => v === null || !!check(v);
const list = (v: unknown, max: number, check: (v: unknown) => boolean): v is unknown[] => Array.isArray(v) && v.length <= max && v.every(check);
const itemUrl = (ref: string, pull = false): string => `https://github.com/${ref.replace("#", pull ? "/pull/" : "/issues/")}`;
const identity = (ref: unknown, url: unknown): boolean => item(ref) && (url === itemUrl(ref) || url === itemUrl(ref, true));
const unique = (refs: string[]): boolean => new Set(refs.map((r) => r.toLowerCase())).size === refs.length;

function blocker(v: unknown): boolean {
  return v === null || isObject(v) && ["operator", "review", "ci", "hold", "not-started", "unknown"].includes(v.type as string)
    && nullable(v.kind, (s) => text(s, 64)) && nullable(v.reason, (s) => text(s, 240))
    && nullable(v.since, time) && nullable(v.pull, item);
}

function child(v: unknown): boolean {
  return isObject(v) && (v.item === null ? v.url === null && v.source === "task" : identity(v.item, v.url))
    && nullable(v.title, (s) => text(s, 120)) && ["sub-issue", "task", "both"].includes(v.source as string)
    && ["open", "done"].includes(v.state as string) && blocker(v.blocker) && (v.state !== "done" || v.blocker === null);
}

function epic(v: unknown): boolean {
  if (!isObject(v) || !identity(v.item, v.url) || !nullable(v.title, (s) => text(s, 120)) || !nullable(v.goal, (s) => text(s, 240))
    || !nullable(v.changed_at, time) || !count(v.operator_blocked) || !blocker(v.blocker)
    || !isObject(v.progress) || !count(v.progress.done) || !count(v.progress.total) || v.progress.done > v.progress.total
    || !count(v.runs_omitted) || !count(v.omitted) || !list(v.children, 50, child)
    || !list(v.runs, 8, (r) => isObject(r) && item(r.item) && text(r.kind, 64) && text(r.pool, 64)
      && isObject(r.run) && repository(r.run.repository) && Number.isSafeInteger(r.run.id) && (r.run.id as number) > 0 && (r.started_at === undefined || nullable(r.started_at, time)))) return false;
  const e = v as unknown as Epic;
  const members = [e.item, ...e.children.flatMap((c) => c.item ? [c.item] : [])];
  // Deduplication is the producer's job; reject conflicting identities, don't
  // silently remove rows or recompute its progress from a truncated inventory.
  return unique(members) && e.progress.total === e.children.length + e.omitted
    && e.progress.done >= e.children.filter((c) => c.state === "done").length
    && e.progress.total - e.progress.done >= e.children.filter((c) => c.state === "open").length
    && unique(e.runs.map((r) => `${r.run.repository}#${r.run.id}`))
    && e.runs.every((r) => e.omitted > 0 || members.some((m) => m.toLowerCase() === r.item.toLowerCase()));
}

/** A malformed extension must not turn into an empty, apparently healthy view. */
export function parseEpicFocus(raw: unknown): EpicFocus | string {
  if (!isObject(raw) || raw.schema !== "agent-board/epic-focus/v1" || !time(raw.observed_at) || raw.priority !== "P0"
    || typeof raw.complete !== "boolean" || !count(raw.unread_epics) || !count(raw.omitted) || !isObject(raw.sources)
    || !["complete", "partial", "unread"].includes(raw.sources.epics as string)
    || !["complete", "unread"].includes(raw.sources.runs as string) || !["complete", "unread"].includes(raw.sources.board as string)
    || !list(raw.epics, 10, epic) || !unique((raw.epics as Epic[]).map((e) => e.item))
    || raw.complete && (raw.unread_epics > 0 || Object.values(raw.sources).some((s) => s !== "complete"))) {
    return "Focus unavailable: malformed or over its publication bounds; unread work is unknown.";
  }
  return raw as unknown as EpicFocus;
}

const LABELS: Record<Blocker["type"], string> = {
  operator: "Waiting on operator", review: "Waiting on upstream review / merge", ci: "Failing CI",
  hold: "Pass hold", "not-started": "Nothing started (publisher assessment)", unknown: "State unknown",
};

function blockerLine(b: Blocker | null): HTMLElement {
  if (!b) return h("span", { class: "note" }, "State unknown (no blocker published)");
  return h("span", { class: b.type === "operator" ? "focus-operator" : "", ...(b.since ? { title: `Waiting since ${b.since}` } : {}) }, LABELS[b.type],
    b.reason ? ` — ${b.reason}` : "",
    b.pull ? h("a", { href: itemUrl(b.pull, true) }, ` · ${b.pull}`) : "");
}

export function focusView(data: EpicFocus | string | undefined, now = Date.now(), unavailable?: string): HTMLElement {
  const el = h("section", { class: "focus-view", "aria-label": "Focus" }, h("h2", {}, "Focus · P0 epics"));
  if (unavailable) el.append(h("p", { class: "warn" }, `Publication unavailable: ${unavailable}. Facts below are last read, not current.`));
  if (!data || typeof data === "string") {
    el.append(h("p", { class: "note" }, data ?? "Focus not published (off or older producer); work and blockers are unknown."));
    return el;
  }
  const age = now - Date.parse(data.observed_at);
  el.append(h("p", { class: "note" }, `Observed ${data.observed_at}`,
    age > 3_600_000 ? " · stale (over an hour); facts are last observed, not current" : age < -60_000 ? " · clock is in the future; current state unknown" : "",
    ` · ${data.complete ? "publisher reports complete sources" : "partial; unread work is unknown"}`,
    ` · sources: epics ${data.sources.epics}, runs ${data.sources.runs}, board ${data.sources.board}`,
    ` · ${data.unread_epics} unread epics · ${data.omitted} epics omitted`));
  if (!data.epics.length) el.append(h("p", {}, "No P0 epics listed in this publication; unread or omitted work remains unknown."));
  const ordered = [...data.epics].sort((a, b) => b.operator_blocked - a.operator_blocked
    || (a.changed_at ? Date.parse(a.changed_at) : Infinity) - (b.changed_at ? Date.parse(b.changed_at) : Infinity)
    || a.item.toLowerCase().localeCompare(b.item.toLowerCase()));
  for (const e of ordered) {
    const card = h("article", { class: "focus-card", "data-focus-item": e.item },
      h("h3", {}, h("a", { href: e.url }, `${e.item}${e.title ? ` · ${e.title}` : ""}`)),
      h("p", {}, e.goal ?? "Goal not published."),
      h("p", { class: "note" }, `${e.progress.done} / ${e.progress.total} done · ${e.operator_blocked} blocked on operator · Last changed `,
        e.changed_at ? agoLabel(e.changed_at, now) : "unknown"));
    if (e.blocker) card.append(h("p", {}, "Epic: ", blockerLine(e.blocker)));
    card.append(h("h4", {}, "What's moving (observed runs)"));
    if (!e.runs.length) card.append(h("p", { class: "note" }, "No runs listed; missing coverage is not evidence of inactivity."));
    card.append(h("ul", {}, ...e.runs.map((r) => h("li", {},
      h("a", { href: itemUrl(r.item) }, r.item), ` · ${r.kind} · ${r.pool} · `,
      h("a", { href: `https://github.com/${r.run.repository}/actions/runs/${r.run.id}` }, `run ${r.run.id}`),
      r.started_at ? ` · started ${r.started_at}` : " · start time unknown"))));
    card.append(h("details", {}, h("summary", {}, `Children · what's blocking · ${e.children.length} listed`), h("ul", { class: "focus-children" }, ...e.children.map((c) => {
      const moving = c.item && e.runs.some((r) => r.item.toLowerCase() === c.item!.toLowerCase());
      return h("li", {}, c.item ? h("a", { href: c.url! }, `${c.item}${c.title ? ` · ${c.title}` : ""}`) : `${c.title ?? "Untitled task"} (unlinked task)`,
        " — ", c.state === "done" ? "Done" : moving && !c.blocker ? "Run listed above; other blockers unknown" : blockerLine(c.blocker));
    }))));
    if (e.omitted || e.runs_omitted) card.append(h("p", { class: "warn" }, `${e.omitted} children omitted · ${e.runs_omitted} runs omitted; coverage incomplete.`));
    el.append(card);
  }
  return el;
}

/** A publication poll must not close a child inventory the reader opened. */
export function fillFocus(slot: HTMLElement, data: EpicFocus | string | undefined, now: number, unavailable?: string): void {
  const expanded = new Set([...slot.querySelectorAll(".focus-card")].filter((c) => c.querySelector("details")?.open).map((c) => c.getAttribute("data-focus-item")));
  const view = focusView(data, now, unavailable);
  for (const card of view.querySelectorAll(".focus-card")) {
    if (expanded.has(card.getAttribute("data-focus-item"))) card.querySelector("details")!.open = true;
  }
  slot.replaceChildren(view);
}
