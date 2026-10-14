import { h } from "../dom.ts";
import type { GitHub } from "./api.ts";
import { CHAT_CONFIG, chatEndpoint, type ChatConfig } from "./chatconfig.ts";

export interface ChatPanel { mount(slot: HTMLElement): void; dispose(): void }
export interface ChatSession { title: string; endpoint: string }

export async function findSessions(gh: GitHub, config: ChatConfig): Promise<ChatSession[]> {
  const sessions: ChatSession[] = [];
  for (const source of config.sources) {
    const base = `/repos/${source.repo}`;
    const runs = await gh.get<{ workflow_runs: { id: number; display_title: string }[] }>(`${base}/actions/workflows/${source.workflow}/runs?status=in_progress&per_page=100`);
    const issue = await gh.get<{ comments: number }>(`${base}/issues/${source.issue}`);
    const page = Math.max(1, Math.ceil(issue.data.comments / 100));
    const comments = await gh.get<{ body: string; user: { login: string } | null }[]>(`${base}/issues/${source.issue}/comments?per_page=100&page=${page}`);
    for (const run of runs.data.workflow_runs.slice(0, 100)) {
      const runUrl = `https://github.com/${source.repo}/actions/runs/${run.id}`;
      for (const comment of comments.data.slice(0, 100).reverse()) {
        if (comment.user?.login !== source.publisher || typeof comment.body !== "string" || comment.body.length > 65536) continue;
        const urls: string[] = comment.body.match(/(?:https|wss):\/\/[^\s<>\x60)\]]+/g) ?? [];
        if (!urls.includes(runUrl)) continue;
        const endpoint = urls.map((u) => chatEndpoint(u, config.tailnetDomain)).find(Boolean);
        if (endpoint) { sessions.push({ title: run.display_title, endpoint }); break; }
      }
    }
  }
  return sessions;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One JSON-RPC message per WebSocket text frame; no GitHub credentials. */
export class AcpClient {
  #next = 0;
  #pending = new Map<number, Pending>();
  sessionId = "";
  readonly socket: WebSocket;

  constructor(socket: WebSocket, update: (value: any) => void, closed: () => void) {
    this.socket = socket;
    socket.onmessage = (event) => {
      // Bound unsolicited agent data before parsing/rendering it.
      if (typeof event.data !== "string" || event.data.length > 512 * 1024) { socket.close(); return; }
      try {
        const m = JSON.parse(event.data);
        if (m.jsonrpc !== "2.0") return;
        if (m.method === "session/update" && m.params?.sessionId === this.sessionId) update(m.params.update);
        else if (m.id !== undefined && m.method) socket.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Unsupported client method" } }));
        else {
          const p = this.#pending.get(m.id);
          if (!p) return;
          clearTimeout(p.timer); this.#pending.delete(m.id);
          if (m.error) p.reject(new Error(String(m.error.message ?? "ACP request failed")));
          else p.resolve(m.result);
        }
      } catch { socket.close(); }
    };
    socket.onclose = () => {
      for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new Error("Session disconnected")); }
      this.#pending.clear(); closed();
    };
  }

  request(method: string, params: unknown, timeout = 60_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.#next;
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error("ACP response timed out")); this.socket.close(); }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch (e) { clearTimeout(timer); this.#pending.delete(id); reject(e); }
    });
  }

  async attach(): Promise<void> {
    const init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    if (init?.protocolVersion !== 1) throw new Error("Unsupported ACP protocol version");
    const session = await this.request("session/new", { cwd: "/", mcpServers: [] });
    if (typeof session?.sessionId !== "string" || !session.sessionId) throw new Error("Missing ACP session id");
    this.sessionId = session.sessionId;
  }

  cancel(): void {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } }));
  }
}

export function chatPanel(gh: GitHub, config = CHAT_CONFIG, socketFactory = (url: string) => new WebSocket(url)): ChatPanel | undefined {
  if (!config) return undefined;
  let cleanup = () => {};
  let disposed = false;
  return { dispose() { disposed = true; cleanup(); }, mount(slot) {
    if (disposed) return;
    const pane = h("details", { class: "chat-panel" }, h("summary", {}, "Chat with a session"));
    const status = h("p", { role: "status" });
    const select = h("select", { "aria-label": "Session" });
    const refresh = h("button", { type: "button" }, "Find sessions");
    const connect = h("button", { type: "button" }, "Connect");
    const disconnect = h("button", { type: "button" }, "Disconnect");
    const cancel = h("button", { type: "button" }, "Cancel turn");
    const log = h("div", { class: "chat-log", role: "log", "aria-live": "polite" });
    const input = h("textarea", { "aria-label": "Prompt", maxlength: "65536", rows: "3" });
    const send = h("button", { type: "submit" }, "Send");
    const form = h("form", {}, input, send);
    let client: AcpClient | undefined;
    let busy = false;
    let sessions: ChatSession[] = [];
    let chars = 0;
    const tools = new Map<string, HTMLElement>();
    let message: HTMLElement | undefined;
    let messageKind = "";
    cleanup = () => { client?.socket.close(); client = undefined; slot.replaceChildren(); slot.hidden = true; };
    const controls = () => {
      send.disabled = !client?.sessionId || busy;
      cancel.disabled = !client?.sessionId;
      disconnect.disabled = !client;
      connect.disabled = !!client || !sessions.length;
      refresh.disabled = !!client;
      select.disabled = !!client;
    };
    const error = (e: unknown) => { status.textContent = e instanceof Error ? e.message : String(e); };
    const render = (u: any) => {
      if (!u || chars >= 1024 * 1024 || log.childElementCount >= 1000) { status.textContent = "Transcript display limit reached"; return; }
      const text = (v: unknown) => typeof v === "string" ? v.slice(0, 65536) : "";
      let node: HTMLElement | undefined;
      if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "user_message_chunk") {
        if (u.content?.type === "text") {
          const chunk = text(u.content.text).slice(0, 1024 * 1024 - chars);
          if (!chunk) return;
          if (!message || messageKind !== u.sessionUpdate) {
            message = h("p"); messageKind = u.sessionUpdate; log.append(message);
          }
          const leaf = message.firstChild;
          if (leaf) leaf.nodeValue = (leaf.nodeValue ?? "") + chunk;
          else message.append(document.createTextNode(chunk));
          chars += chunk.length;
        }
      } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        const id = text(u.toolCallId);
        node = tools.get(id);
        if (!node) { node = h("details"); tools.set(id, node); }
        node.replaceChildren(h("summary", {}, `${text(u.title) || "Tool"} · ${text(u.status)}`), h("pre", {}, text(JSON.stringify(u.content ?? u.rawOutput ?? ""))));
      } else if (u.sessionUpdate === "plan" && Array.isArray(u.entries)) {
        node = h("ul", {}, ...u.entries.slice(0, 100).map((e: any) => h("li", {}, `${text(e.status)}: ${text(e.content)}`)));
      }
      if (u.sessionUpdate !== "agent_message_chunk" && u.sessionUpdate !== "user_message_chunk") message = undefined;
      if (node) { chars += node.textContent?.length ?? 0; if (!node.parentNode) log.append(node); }
    };
    refresh.onclick = async () => {
      refresh.disabled = true;
      try {
        sessions = await findSessions(gh, config);
        if (disposed) return;
        select.replaceChildren(...sessions.map((s, i) => h("option", { value: String(i) }, s.title)));
        status.textContent = sessions.length ? "Select a session. Disconnecting ends its run." : "No published sessions found (first 100 runs/comments per source).";
      } catch (e) { error(e); }
      controls();
    };
    connect.onclick = () => {
      const session = sessions[Number(select.value)];
      if (!session || client || disposed) return;
      log.replaceChildren(); chars = 0; tools.clear();
      const socket = socketFactory(session.endpoint);
      client = new AcpClient(socket, render, () => { client = undefined; busy = false; status.textContent = "Disconnected; the session run ends when its client leaves."; controls(); });
      const opening = setTimeout(() => { status.textContent = "Connection timed out"; socket.close(); }, 15_000);
      socket.onopen = async () => {
        clearTimeout(opening);
        if (disposed) { socket.close(); return; }
        try { await client?.attach(); status.textContent = "Connected"; controls(); }
        catch (e) { error(e); socket.close(); }
      };
      socket.addEventListener("close", () => clearTimeout(opening));
      socket.onerror = () => { status.textContent = "Connection failed: check tailnet login and bridge origin configuration."; };
      controls();
    };
    disconnect.onclick = () => { if (confirm("Disconnect and end this session run?")) client?.socket.close(); };
    cancel.onclick = () => { try { client?.cancel(); } catch (e) { error(e); } };
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (disposed || !client?.sessionId || busy || !input.value.trim()) return;
      message = undefined;
      busy = true; controls();
      const prompt = input.value;
      try {
        await client.request("session/prompt", { sessionId: client.sessionId, prompt: [{ type: "text", text: prompt }] }, 6 * 3600_000);
        if (input.value === prompt) input.value = "";
        status.textContent = "Turn finished";
      } catch (e) { error(e); }
      busy = false; controls();
    };
    pane.append(h("p", {}, "Uses your tailnet login, not your GitHub token. No reconnect: disconnecting ends the run."), refresh, select, connect, disconnect, status, log, form, cancel);
    slot.replaceChildren(pane); controls();
  } };
}
