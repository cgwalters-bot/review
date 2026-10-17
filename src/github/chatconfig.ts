import raw from "./chat-config.json" with { type: "json" };

/** A workflow whose runs serve sessions, and where their endpoints are published. */
export interface ChatSource {
  repo: string;
  workflow: string;
  issue: number;
  publisher: string;
  /** The branch Start dispatches the workflow on; the default branch, "main", if unset. */
  ref?: string;
}

export interface ChatConfig {
  tailnetDomain: string;
  sources: ChatSource[];
}

export const DEFAULT_REF = "main";

export function parseChatConfig(value: unknown): ChatConfig | undefined {
  const c = value as ChatConfig | null;
  if (!c?.tailnetDomain && Array.isArray(c?.sources) && !c.sources.length) return undefined;
  if (!c || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/.test(c.tailnetDomain)
    || !Array.isArray(c.sources) || !c.sources.length || c.sources.length > 8
    || c.sources.some((s) => !s || !/^[\w.-]+\/[\w.-]+$/.test(s.repo)
      || !/^[\w.-]+\.ya?ml$/.test(s.workflow) || !Number.isSafeInteger(s.issue) || s.issue < 1
      || !/^[\w-]+(?:\[bot\])?$/.test(s.publisher)
      || (s.ref !== undefined && (typeof s.ref !== "string" || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(s.ref))))) throw new Error("Invalid repository chat configuration");
  return c;
}

export const CHAT_CONFIG = parseChatConfig(raw);

export function chatEndpoint(text: string, domain: string): string | undefined {
  try {
    const u = new URL(text);
    // A publication must not redirect prompts outside the configured tailnet.
    if (u.protocol !== "wss:" || u.username || u.password || u.port || u.search || u.hash
      || !u.hostname.endsWith(`.${domain}`) || !/^[a-z0-9-]+$/.test(u.hostname.slice(0, -domain.length - 1))) return undefined;
    return u.href;
  } catch { return undefined; }
}
