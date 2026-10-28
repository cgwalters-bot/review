// Exercise deep links through the real entry point, including refreshes and late reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { fields } from "./helpers.ts";

it("opens out-of-queue links and keeps read errors visible across chrome refreshes", async () => {
  const id = "PVTI_lADOE9oHIs4BlJLczhENIh0";
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => {
    // Sign-out reloads the page; jsdom implements only hash navigation.
    if (!error.message.startsWith("Not implemented: navigation")) throw error;
  });
  const dom = new JSDOM(readFileSync(new URL("../static/index.html", import.meta.url), "utf8"), {
    url: `https://review.example/#item/${id}`, pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.scrollTo = () => {};
  const content = { __typename: "Issue", id: "I_example786", title: "An in-progress epic", body: "Epic context", url: "https://github.com/cgwalters-forge/tracker/issues/786", state: "OPEN" };
  const board = { id, project: { number: 1, owner: { login: "cgwalters-forge" } }, fieldValues: { nodes: [{ name: "In Progress", field: { name: "Status" } }] } };
  let reads = 0;
  let missing = false;
  Object.assign(globalThis, {
    window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement,
    ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      let body: unknown = [];
      if (url.pathname === "/user") body = { login: "viewer" };
      else if (url.pathname.endsWith("/fields")) body = fields();
      else if (url.pathname === "/search/issues") body = { items: [], total_count: 0 };
      else if (url.pathname === "/graphql") {
        const request = JSON.parse(String(init?.body)) as { query: string };
        if (request.query.includes("node(id:$id)")) {
          reads++;
          body = { data: { node: missing ? null : { ...board, content } } };
        } else if (request.query.includes("issue(number:$number)")) {
          reads++;
          body = { data: { repository: { issue: { ...content, projectItems: { nodes: missing ? [] : [board], pageInfo: { hasNextPage: false } } } } } };
        } else body = { data: {} };
      }
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    },
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out: ${window.document.querySelector("#view")?.textContent}`);
  };
  const text = () => window.document.querySelector("#view")?.textContent ?? "";
  const key = (key: string) => window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
  try {
    await import("../src/github/main.ts");
    await until(() => !!window.document.querySelector(".signin"));
    window.document.querySelector<HTMLInputElement>(".signin input[type=password]")!.value = ["ghp", "x".repeat(24)].join("_");
    window.document.querySelector(".signin")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await until(() => text().includes(content.title));
    assert.match(text(), /In Progress/);
    assert.match(text(), /Epic context/);
    assert.doesNotMatch(text(), /left this without an ask/);
    assert.equal(reads, 1);
    assert.equal(window.document.querySelector("#sec-needs"), null, "not the Inbox");

    window.location.hash = "#issue/cgwalters-forge/tracker/786";
    await until(() => reads === 2 && text().includes("In Progress"));
    missing = true;
    window.location.hash = "#item/PVTI_missing";
    await until(() => text().includes("Couldn't read this item"));
    key("?"); // renderChrome used to erase the route's notice.
    assert.match(text(), /Couldn't read this item/);
    assert.ok(window.document.querySelector('[role="alert"]'));
    key("r");
    await until(() => reads === 4 && text().includes("Couldn't read this item"));

    window.location.hash = "#issue/cgwalters-forge/tracker/786";
    await until(() => reads === 5 && text().includes(content.title));
    assert.doesNotMatch(text(), /In Progress/, "off-board issue renders alone");
  } finally {
    window.document.querySelector<HTMLButtonElement>("#signout")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.window.close();
  }
});
