// Item text stays in the browser: public workflow inputs contain only a reference.
import { h } from "../dom.ts";
import { CHAT_CONFIG } from "./chatconfig.ts";

export interface ChatItem {
  ref: string;
  title: string;
  pool?: string;
}

export const ITEM_CHAT_EVENT = "review-item-chat";

export function publicItemRef(value: string): string | undefined {
  return /^[A-Za-z0-9-]+\/(?!\.+#)[A-Za-z0-9_.-]+#[1-9]\d{0,9}$/.test(value) ? value.toLowerCase() : undefined;
}

export function chatItem(url: string | undefined, title: string, pool?: string): ChatItem | undefined {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9]\d{0,9})(?:[?#].*)?$/.exec(url ?? "");
  const ref = m && publicItemRef(`${m[1]}#${m[2]}`);
  return ref ? { ref, title, ...(pool ? { pool } : {}) } : undefined;
}

export function sessionInputs(item: ChatItem): { prompt: string; pool: string } {
  const ref = publicItemRef(item.ref);
  if (!ref) throw new Error("Chat needs an issue or PR reference.");
  return { prompt: `Context: ${ref}. The operator opens a session about it.`, pool: ["claude", "openai", "mistral"].includes(item.pool ?? "") ? item.pool! : "claude" };
}

/** A bubbling request lets every renderer use the page's single session owner. */
export function chatButton(item: ChatItem | undefined): HTMLButtonElement | null {
  if (!CHAT_CONFIG || !item) return null;
  const button = h("button", { type: "button", class: "small item-chat", "aria-label": `Chat about ${item.title}` }, "Chat");
  button.onclick = (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    const Event = button.ownerDocument.defaultView!.CustomEvent;
    button.dispatchEvent(new Event(ITEM_CHAT_EVENT, { bubbles: true, detail: item }));
  };
  return button;
}
