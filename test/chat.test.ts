import assert from "node:assert/strict";
import { it } from "node:test";
import { AcpClient, chatPanel, findSessions } from "../src/github/chat.ts";
import { chatEndpoint, parseChatConfig } from "../src/github/chatconfig.ts";
import { GitHub } from "../src/github/api.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const config = { tailnetDomain: "example.ts.net", sources: [{ repo: "owner/repo", workflow: "session.yml", issue: 1, publisher: "publisher" }] };

class MockServer extends EventTarget {
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: any[] = [];
  close() { this.onclose?.(); }
  send(text: string) {
    const m = JSON.parse(text); this.sent.push(m);
    if (!m.id) return;
    queueMicrotask(() => this.emit({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: 1 } : m.method === "session/new" ? { sessionId: "session" } : { stopReason: "end_turn" } }));
  }
  emit(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

it("is off by default and confines endpoints to the configured tailnet", () => {
  assert.equal(parseChatConfig({ tailnetDomain: "", sources: [] }), undefined);
  assert.equal(chatPanel(new GitHub(async () => "token")), undefined);
  assert.deepEqual(parseChatConfig(config), config);
  for (const url of ["ws://runner.example.ts.net/", "wss://example.ts.net/", "wss://runner.example.ts.net.evil/", "wss://u@runner.example.ts.net/", "wss://runner.example.ts.net:444/", "wss://runner.example.ts.net/?token=x"]) assert.equal(chatEndpoint(url, config.tailnetDomain), undefined);
  assert.equal(chatEndpoint("wss://runner.example.ts.net/acp", config.tailnetDomain), "wss://runner.example.ts.net/acp");
  assert.throws(() => parseChatConfig({ ...config, tailnetDomain: "x; connect-src *" }));
});

it("discovers only live runs with matching publisher, run URL and safe endpoint", async () => {
  const paths: string[] = [];
  const gh = new GitHub(async () => "token", async (url) => {
    paths.push(url);
    return Response.json(url.endsWith("/issues/1") ? { comments: 201 } : url.includes("/runs?") ? { workflow_runs: [{ id: 42, display_title: "Live" }] } : [
      { user: null, body: "unattributable" },
      { user: { login: "other" }, body: "https://github.com/owner/repo/actions/runs/42 wss://evil.example.ts.net/" },
      { user: { login: "publisher" }, body: "https://github.com/owner/repo/actions/runs/420 wss://wrong.example.ts.net/" },
      { user: { login: "publisher" }, body: "https://github.com/owner/repo/actions/runs/42 wss://runner.example.ts.net/" },
    ]);
  });
  assert.deepEqual(await findSessions(gh, config), [{ title: "Live", endpoint: "wss://runner.example.ts.net/" }]);
  assert.ok(paths.some((p) => p.endsWith("comments?per_page=100&page=3")));
});

it("speaks ACP initialize/new/prompt/cancel and filters notifications", async () => {
  const server = new MockServer(); const updates: unknown[] = [];
  const client = new AcpClient(server as unknown as WebSocket, (u) => updates.push(u), () => {});
  await client.attach();
  await client.request("session/prompt", { sessionId: client.sessionId, prompt: [{ type: "text", text: "Hello" }] });
  client.cancel();
  server.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "other", update: {} } });
  server.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "plan" } } });
  assert.equal(updates.length, 1);
  assert.deepEqual(server.sent.map((m) => m.method), ["initialize", "session/new", "session/prompt", "session/cancel"]);
  assert.ok(server.sent.every((m) => !JSON.stringify(m).includes("token")));
  server.emit({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: {} });
  assert.equal(server.sent.at(-1).error.code, -32601);
  server.close();
});

it("renders malicious message/tool/plan text without HTML and disables duplicate prompts", async () => {
  const server = new MockServer() as MockServer & { onopen?: () => Promise<void>; onerror?: () => void };
  const gh = new GitHub(async () => "secret", async (url) => Response.json(url.endsWith("/issues/1") ? { comments: 1 } : url.includes("/runs?") ? { workflow_runs: [{ id: 42, display_title: "Live" }] } : [{ user: { login: "publisher" }, body: "https://github.com/owner/repo/actions/runs/42 wss://runner.example.ts.net/" }]));
  const slot = document.createElement("div");
  const panel = chatPanel(gh, config, () => server as unknown as WebSocket)!;
  panel.mount(slot);
  const buttons = [...slot.querySelectorAll("button")];
  buttons[0]!.click(); await new Promise((r) => setTimeout(r, 0));
  buttons[1]!.click(); await server.onopen?.();
  const evil = "<img src=x onerror=alert(1)>";
  for (const update of [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: evil } },
    { sessionUpdate: "tool_call", toolCallId: "1", title: evil, status: "pending" },
    { sessionUpdate: "plan", entries: [{ content: evil, status: "pending" }] },
  ]) server.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update } });
  assert.equal(slot.querySelector("img"), null);
  assert.ok(slot.textContent?.includes(evil));
  assert.equal(slot.querySelector(".chat-log details")?.hasAttribute("open"), false);
  for (let i = 0; i < 1001; i++) server.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } });
  assert.equal(slot.querySelectorAll(".chat-log p").length, 2);
  for (let i = 0; i < 10000; i++) server.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } } } });
  assert.equal(slot.querySelectorAll(".chat-log p")[1]!.childNodes.length, 1);
  const input = slot.querySelector("textarea")!; input.value = "Hello";
  slot.querySelector("form")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
  assert.equal(slot.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled, true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(input.value, ""); panel.dispose();
  assert.equal(slot.childElementCount, 0);
  assert.equal(slot.hidden, true);
});
