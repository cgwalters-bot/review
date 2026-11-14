// One read-only adapter for HTTP and full-resync SSE. Preview facts are never
// write authorization. Missing sections stay missing; no GitHub fallback here.
import type { Fetch } from "./api.ts";
import { isObject, time } from "./heartbeat.ts";
import { HOLDS_MARKER, type Holds, parseHolds } from "./holds.ts";
import { stale } from "./passes.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length <= 500;
const evidence = ["observed", "partial", "stale", "missing"];

function workOptions(raw: unknown): unknown {
  if (!isObject(raw) || !isObject(raw.repositories)) return raw;
  return { ...raw, repositories: Object.fromEntries(Object.entries(raw.repositories).map(([name, r]) => {
    if (!isObject(r) || !Array.isArray(r.items)) return [name, r];
    return [name, { ...r, items: r.items.map((i: unknown) => isObject(i)
      ? Object.fromEntries(Object.entries(i).filter(([, v]) => v !== null)) : i) }];
  })) };
}

export interface DecisionPool {
  name: string;
  evidence: string;
  hold: boolean | null;
  reason: string | null;
  used_percent: number | null;
  allowed_percent: number | null;
  observed_at: string | null;
  resets_at: string | null;
}

export interface ServiceDecision {
  generation: number;
  readAt: string | null;
  complete: boolean;
  error?: string;
  holds: Holds;
  pools: DecisionPool[];
  poolsOmitted: number;
  holdsOmitted: number;
  candidates: number | null;
}

/** Reject unsupported/malformed documents as a whole, without mixing generations. */
export function parseService(raw: unknown): ServiceDecision {
  if (!isObject(raw) || raw.schema !== "review-service/v1" || !count(raw.generation) || !isObject(raw.decision)) throw new Error("Service decision unavailable or unsupported");
  const section = raw.decision;
  if (!Array.isArray(section.items) || section.items.length !== 1 || typeof section.complete !== "boolean" || (section.readAt !== null && !time(section.readAt)) || (section.error !== null && !text(section.error))) throw new Error("Service decision unavailable or malformed");
  const d = section.items[0];
  if (!isObject(d) || d.schema !== "agent-board/decision/v1" || !time(d.observed_at) || typeof d.complete !== "boolean" || typeof d.holds_complete !== "boolean" || !count(d.holds_omitted) || !count(d.pools_omitted) || !count(d.failures) || (d.candidates !== null && !count(d.candidates)) || !Array.isArray(d.holds) || d.holds.length > 10_000 || !Array.isArray(d.pools) || d.pools.length > 16) throw new Error("Unsupported or malformed service decision");
  for (const p of d.pools) {
    if (!isObject(p) || !text(p.name) || !p.name || !evidence.includes(p.evidence as string) || (p.hold !== null && typeof p.hold !== "boolean") || (p.reason !== null && !text(p.reason)) || ![p.used_percent, p.allowed_percent].every((v) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0)) || ![p.observed_at, p.resets_at].every((v) => v === null || !!time(v))) throw new Error("Malformed service pools");
  }
  // Rust's typed Work serializes absent Options as null; the legacy comment
  // parser expects those optional fields omitted. Do not drop false or zero.
  const work = workOptions(d.work);
  // Reuse the exact publication parsers, not a new decision derivation. A null
  // optional section is unavailable, never an invented successful empty list.
  const holds = parseHolds(`${HOLDS_MARKER}\n\x60\x60\x60json\n${JSON.stringify({
    schema: "agent-board/holds/v1", at: d.observed_at, holds: d.holds,
    truncated: d.holds_complete ? d.holds_omitted : Math.max(1, d.holds_omitted),
    wip: d.wip, ...(d.needs_you === null ? {} : { needs_you: d.needs_you }), dispatchable_work: work,
  })}\n\x60\x60\x60`);
  if (!holds || !holds.wip || typeof holds.dispatchableWork !== "object") throw new Error("Malformed service holds or work");
  if (typeof holds.needsYou === "object") holds.needsYou.producerOrder = true;
  return { generation: raw.generation, readAt: section.readAt as string | null, complete: section.complete && d.complete,
    ...(section.error ? { error: section.error as string } : {}), holds, pools: d.pools as DecisionPool[],
    poolsOmitted: d.pools_omitted, holdsOmitted: d.holds_omitted, candidates: d.candidates as number | null };
}

/** Publication clocks, not successful HTTP/SSE delivery, establish freshness. */
export function serviceProblem(d: ServiceDecision, now: number): string | undefined {
  if (d.error) return d.error;
  if (!d.readAt || stale(d.readAt, now) || stale(d.holds.at, now)) return "Service decision is stale or has a future clock";
  return undefined;
}

/** No GitHub token, cookies, redirects or unbounded response bodies. */
export async function readService(base: string, fetchImpl: Fetch, now: number): Promise<ServiceDecision> {
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid service URL");
  let response: Response;
  try {
    response = await fetchImpl(new URL("/api/v1/state", url).href, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error("Service decision unavailable"); }
  if (!response.ok || !response.body) throw new Error("Service decision unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      // A body can fail after fetch has returned headers. Transport errors may
      // contain private connection details, just like errors from fetch itself.
      const { done, value } = await reader.read().catch(() => { throw new Error("Service decision unavailable"); });
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) throw new Error("Service state exceeds size bound");
      chunks.push(value);
    }
  } finally {
    // An errored stream rejects cancel with its original error. Cleanup must
    // not replace the sanitized read error or the explicit size-bound error.
    await reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { throw new Error("Malformed service JSON"); }
  const decision = parseService(raw);
  const problem = serviceProblem(decision, now);
  if (problem) decision.error = problem;
  return decision;
}

/** Native EventSource reconnects with Last-Event-ID; every event is a full resync.
 * An error retains only explicitly unavailable prior facts. The id must agree
 * with the document; generations can reset when the server restarts. A quiet
 * stream is normal (refreshes may be an hour apart, and keep-alive comments are
 * invisible here): callers re-check serviceProblem's clocks instead of a timer. */
export function watchService(changed: (decision: ServiceDecision | undefined, error?: string) => void, open: (url: string) => EventSource = (url) => new EventSource(url)): () => void {
  const stream = open("/api/events");
  stream.addEventListener("state", (event) => {
    try {
      const e = event as MessageEvent<string>;
      if (new TextEncoder().encode(e.data).length > MAX_BYTES) throw new Error("Service state exceeds size bound");
      const d = parseService(JSON.parse(e.data));
      if (e.lastEventId !== String(d.generation)) throw new Error("Service generation mismatch");
      changed(d, serviceProblem(d, Date.now()));
    } catch { changed(undefined, "Unsupported or malformed service resync"); }
  });
  stream.onerror = () => changed(undefined, "Service stream unavailable; waiting for full resync");
  return () => stream.close();
}
