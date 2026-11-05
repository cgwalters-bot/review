// Optional publication only: no log scraping, target discovery or write authority.
import { h } from "../dom.ts";
import { isObject, time } from "./heartbeat.ts";

interface Run { repository: string; id: number }
interface Start { item: string; kind: string; pool: string; run: Run }
interface Reason { item: string | null; kind: "no-ready-work" | "replan-delay" | "capped" | "held"; reason: string; until: string | null }
interface Pass { at: string; result: "success" | "partial" | "failure"; sections: { name: string; result: "success" | "skipped" | "failure"; error: string | null }[]; started: Start[]; reasons: Reason[]; omitted: number }
interface Pool { name: string; used_percent: number | null; allowed_percent: number | null; resets_at: string | null; ready: number | null; under_pace: boolean | null }
type Flight = { state: "running"; item: string; kind: string; pool: string; run: Run } | { state: "merge-queue" | "waiting-review"; repository: string; number: number };
export interface PassView { schema: "agent-board/pass-view/v1"; observed_at: string; complete: boolean; omitted: number; passes: Pass[]; pools: Pool[]; in_flight: Flight[] }

// A hostile/oversized publication must not create unbounded DOM or arbitrary links.
const token = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !/[\r\n\x00-\x1f\x7f]/.test(v);
const repository = (v: unknown): v is string => typeof v === "string" && v.length <= 201 && v.split("/").length === 2 && v.split("/").every((s) => /^[A-Za-z0-9_.-]+$/.test(s) && s !== "." && s !== "..");
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
const item = (v: unknown): v is string => typeof v === "string" && repository(v.split("#")[0]) && /^[^#]+#[1-9]\d{0,9}$/.test(v);
const run = (v: unknown): boolean => isObject(v) && repository(v.repository) && positive(v.id);
const list = (v: unknown, max: number, check: (v: unknown) => boolean): boolean => Array.isArray(v) && v.length <= max && v.every(check);
const percent = (v: unknown): boolean => v === null || typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
const start = (v: unknown): boolean => isObject(v) && item(v.item) && token(v.kind) && token(v.pool) && run(v.run);

/** Reject the extension as a whole: malformed entries are not evidence of nothing running. */
export function parsePassView(raw: unknown): PassView | string {
  if (!isObject(raw) || raw.schema !== "agent-board/pass-view/v1" || !time(raw.observed_at) || typeof raw.complete !== "boolean" || !count(raw.omitted)
    || !list(raw.passes, 8, (p) => isObject(p) && !!time(p.at) && ["success", "partial", "failure"].includes(p.result as string) && count(p.omitted)
      && list(p.sections, 12, (s) => isObject(s) && token(s.name) && ["success", "skipped", "failure"].includes(s.result as string) && (s.result === "failure" ? text(s.error) : s.error === null))
      && list(p.started, 32, start)
      && list(p.reasons, 32, (r) => isObject(r) && (r.item === null || item(r.item)) && ["no-ready-work", "replan-delay", "capped", "held"].includes(r.kind as string) && text(r.reason) && (r.kind === "replan-delay" ? !!time(r.until) : r.until === null)))
    || !list(raw.pools, 16, (p) => isObject(p) && token(p.name) && percent(p.used_percent) && percent(p.allowed_percent) && (p.resets_at === null || !!time(p.resets_at)) && (p.ready === null || count(p.ready)) && (p.under_pace === null || typeof p.under_pace === "boolean"))
    || !list(raw.in_flight, 100, (f) => isObject(f) && (f.state === "running" ? start(f) : ["merge-queue", "waiting-review"].includes(f.state as string) && repository(f.repository) && positive(f.number)))) {
    return "Pass view unavailable: malformed or over its publication bounds.";
  }
  // Only validated fields are consumed below; unknown extension fields are ignored.
  return raw as unknown as PassView;
}

/** While the publication can't be read, the last readable view stays, marked last read by passView's warning. */
export function retainPassView(last: PassView | undefined, read: PassView | string | undefined, unavailable: boolean): PassView | string | undefined {
  return unavailable && last && typeof read !== "object" ? last : read;
}

function itemLink(ref: string): HTMLElement {
  return h("a", { href: `https://github.com/${ref.replace("#", "/issues/")}` }, ref);
}

function runLink(ref: Run): HTMLElement {
  return h("a", { href: `https://github.com/${ref.repository}/actions/runs/${ref.id}` }, `run ${ref.id}`);
}

function startLine(s: Start): HTMLElement {
  return h("li", {}, itemLink(s.item), ` · ${s.kind} · ${s.pool} · `, runLink(s.run));
}

export function passView(data: PassView | string | undefined, now = Date.now(), unavailable?: string): HTMLElement {
  const el = h("section", { class: "pass-view", "aria-label": "Poller passes" }, h("h2", {}, "Poller passes"));
  if (unavailable) el.append(h("p", { class: "warn" }, `Publication unavailable: ${unavailable}. Any facts below are last read, not current.`));
  if (!data || typeof data === "string") {
    el.append(h("p", { class: "note" }, data ?? "Pass view not published (off or older producer)."));
    return el;
  }
  const age = now - Date.parse(data.observed_at);
  el.append(h("p", { class: age > 3_600_000 || age < -60_000 ? "warn" : "note" }, `Observed ${data.observed_at}${age > 3_600_000 ? " · stale (over an hour)" : age < -60_000 ? " · clock is in the future" : ""} · ${data.complete ? "complete published sample" : "partial; unread work is unknown"} · ${data.omitted} records omitted`));
  el.append(h("h3", {}, "Last passes"));
  if (!data.passes.length) el.append(h("p", {}, "No pass history published; not evidence that no pass ran."));
  for (const p of data.passes) {
    const row = h("article", { class: "pass-record" }, h("h4", {}, `${p.at} · ${p.result}`));
    row.append(h("ul", {}, ...p.sections.map((s) => h("li", { class: s.result === "failure" ? "warn" : "" }, `${s.name}: ${s.result}${s.error ? ` — ${s.error}` : ""}`))));
    row.append(h("p", {}, `Started ${p.started.length}${p.omitted ? " shown" : ""}`), h("ul", {}, ...p.started.map(startLine)));
    if (!p.started.length && !p.reasons.length) row.append(h("p", { class: "warn" }, "Started nothing; reason not published."));
    row.append(h("ul", {}, ...p.reasons.map((r) => h("li", {}, r.item ? itemLink(r.item) : "New runs", ` · ${r.kind}: ${r.reason}${r.until ? ` · until ${r.until}` : ""}`))));
    if (p.omitted) row.append(h("p", { class: "warn" }, `${p.omitted} pass records omitted; starts and reasons may be incomplete.`));
    el.append(row);
  }
  el.append(h("h3", {}, "Pool pace"));
  if (!data.pools.length) el.append(h("p", {}, "Pool pace not published."));
  for (const p of data.pools) {
    const reset = p.resets_at ? Math.ceil((Date.parse(p.resets_at) - now) / 60_000) : null;
    el.append(h("p", { class: p.under_pace === true && p.ready === 0 ? "warn" : "" }, `${p.name}: ${p.used_percent ?? "unknown"}% used / ${p.allowed_percent ?? "unknown"}% allowed · reset ${p.resets_at ?? "unknown"}${reset === null ? "" : reset > 0 ? ` (in ${reset}m)` : " (due; awaiting reading)"} · ready ${p.ready ?? "unknown"}${p.under_pace === true && p.ready === 0 ? " · well under pace with nothing ready (publisher assessment)" : ""}`));
  }
  el.append(h("h3", {}, "Work in flight"));
  if (!data.in_flight.length) el.append(h("p", {}, data.complete && data.omitted === 0 ? "No work in flight in this published sample." : "No work in flight listed; incomplete publication is not an empty queue."));
  el.append(h("ul", {}, ...data.in_flight.map((f) => f.state === "running" ? startLine(f) : h("li", {}, h("a", { href: `https://github.com/${f.repository}/pull/${f.number}` }, `${f.repository}#${f.number}`), ` · ${f.state}`))));
  return el;
}
