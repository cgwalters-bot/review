// Shared test setup: a jsdom window, synthetic fixtures, and a scripted
// fetch that records requests.

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import type { RawField, RawItem } from "../src/github/board.ts";

export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8")) as T;
}

export const fields = (): RawField[] => fixture<RawField[]>("fields.json");
export const rawItems = (): RawItem[] => fixture<RawItem[]>("items.json");

/** A fresh jsdom window, also installed as the global document. */
export function installDom(): JSDOM["window"] {
  const { window } = new JSDOM("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { document: window.document, window });
  return window;
}

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Scripted {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A fetch that answers from `route` and records each request. Throws on
 * an unrouted request so a test can't silently hit the network.
 */
export function scriptedFetch(route: (method: string, url: string, headers: Record<string, string>) => Scripted | undefined) {
  const calls: Recorded[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, headers, body });
    const r = route(method, url, headers);
    if (!r) throw new Error(`unexpected request: ${method} ${url}`);
    const status = r.status ?? 200;
    const payload = status === 204 || status === 205 || status === 304 ? null : JSON.stringify(r.body ?? {});
    return new Response(payload, { status, headers: { "content-type": "application/json", ...r.headers } });
  };
  return { fetchImpl, calls };
}

const TEXT_FIELDS: readonly string[] = ["Why", "Branch", "Gist", "Verdict target"];

/** A board item with the given fields set, as the Projects REST API returns them. */
export function rawBoardItem(n: number, fields: Record<string, string>, title = `item ${n}`): RawItem {
  return {
    id: n,
    node_id: `PVTI_t${n}`,
    content_type: "Issue",
    content: { title, html_url: `https://github.com/cgwalters-forge/tracker/issues/${n}`, state: "open" },
    fields: Object.entries(fields).map(([name, v], i) =>
      TEXT_FIELDS.includes(name)
        ? { id: 200 + i, name, data_type: "text", value: { raw: v } }
        : { id: 200 + i, name, data_type: "single_select", value: { name: { raw: v } } },
    ),
  };
}

/** A published ask as agent-board's pass writes it (its docs/pass.md), on cgwalters-forge/tracker#n unless `over` says otherwise. */
export function rawAsk(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const repository = "cgwalters-forge/tracker";
  return {
    key: `${repository}#${n}`, item: `${repository}#${n}`, source: "items", kind: "needs-human", priority: null, waiting_since: "2026-10-29T18:24:18Z",
    ask: `Ask ${n}?`, recommendation: null, target: `https://github.com/${repository}/issues/${n}`, head: null,
    action: { type: "issue", repository, number: n }, source_ref: { type: "hold", repository, number: n }, ...over,
  };
}

/** A needs-you list of `items`, complete and confirmed at `at`. */
export function rawNeedsYou(items: unknown[], at: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "agent-board/needs-you/v2", complete: true, validated_at: at, changed_at: at,
    sources: { epics: "complete", items: "complete", reviews: "complete", proposals: "complete", digest: "off" },
    summaries: "complete", omitted: 0, count: items.length, items, ...over,
  };
}

/** The bot's hold comment holding `needsYou` (left out where undefined), as the pass renders it. */
export function holdsComment(at: string, needsYou?: unknown, holds: unknown[] = []): { user: { login: string }; body: string } {
  const snapshot = { schema: "agent-board/holds/v1", at, truncated: 0, holds, ...(needsYou === undefined ? {} : { needs_you: needsYou }) };
  return { user: { login: "cgwalters-bot" }, body: `<!-- agent-board-holds v1 -->\nHolds as of ${at}.\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n` };
}
