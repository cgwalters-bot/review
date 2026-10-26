import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { NEWS_REPOS } from "../src/github/config.ts";
import { firstParagraph, type HarnessCache, isHarnessPath, loadNews, parseNewsPull, sortNews } from "../src/github/news.ts";
import { installDom, scriptedFetch } from "./helpers.ts";

installDom();
const API = "https://api.github.com";

describe("firstParagraph", () => {
  const cases: [string, string][] = [
    ["", ""],
    ["One line.", "One line."],
    ["First\nstill first.\n\nSecond.", "First\nstill first."],
    ["<!-- a comment -->\n\n## Heading\n---\n\nThe text.\n\nMore.", "The text."],
    ["<!-- unterminated", ""],
    ["\r\n\r\nWindows\r\nlines\r\n\r\nnext", "Windows\nlines"],
    [`${"x".repeat(500)}`, `${"x".repeat(500)}`],
  ];
  for (const [body, want] of cases) it(JSON.stringify(body.slice(0, 30)), () => assert.equal(firstParagraph(body), want));
});

describe("isHarnessPath", () => {
  const cases: [string, boolean][] = [
    [".github/workflows/agent.yml", true],
    ["agent.yaml", true],
    ["bin/bot-harness", true],
    ["harness/src/main.rs", true],
    ["crates/harness/lib.rs", true],
    ["docs/harnesses.md", false],
    ["docs/bot-harness-notes.md", false],
    ["crates/bot-harness/src/lib.rs", true],
    ["myagent.yml", false],
    ["README.md", false],
  ];
  for (const [path, want] of cases) it(path, () => assert.equal(isHarnessPath(path), want));
});

describe("parseNewsPull and sortNews", () => {
  it("keeps merged PRs only, and marks the harness label", () => {
    const merged = parseNewsPull("o/r", { number: 2, html_url: "https://github.com/o/r/pull/2", title: " T ", merged_at: "2026-01-02T00:00:00Z", labels: [{ name: "harness" }], body: "Why.\n\nMore" });
    assert.deepEqual(merged, {
      repo: "o/r", number: 2, url: "https://github.com/o/r/pull/2", title: "T", author: "ghost",
      mergedAt: "2026-01-02T00:00:00Z", summary: "Why.", labels: ["harness"], harness: true,
    });
    assert.equal(parseNewsPull("o/r", { number: 3, html_url: "x", merged_at: null }), undefined);
  });
  it("sorts newest first", () => {
    const n = (repo: string, number: number, mergedAt: string) => ({ repo, number, url: "", title: "", author: "", mergedAt, summary: "", labels: [], harness: false });
    const sorted = sortNews([n("a/a", 1, "2026-01-01"), n("b/b", 5, "2026-01-03"), n("a/a", 2, "2026-01-03")]);
    assert.deepEqual(sorted.map((x) => `${x.repo}#${x.number}`), ["a/a#2", "b/b#5", "a/a#1"]);
  });
});

describe("loadNews", () => {
  const pull = (n: number, mergedAt: string | null, labels: string[] = []) => ({
    number: n, html_url: `https://github.com/x/pull/${n}`, title: `PR ${n}`, merged_at: mergedAt, labels: labels.map((name) => ({ name })),
  });

  it("merges repositories, reads files once per PR, and reports unreadable ones", async () => {
    const [first, second, ...rest] = NEWS_REPOS;
    const { fetchImpl, calls } = scriptedFetch((_m, url) => {
      if (url.startsWith(`${API}/repos/${first}/pulls?`)) return { body: [pull(1, "2026-01-05T00:00:00Z"), pull(2, null), pull(3, "2026-01-01T00:00:00Z", ["harness"])] };
      if (url.startsWith(`${API}/repos/${second}/pulls?`)) return { status: 404, body: { message: "Not Found" } };
      for (const r of rest) if (url.startsWith(`${API}/repos/${r}/pulls?`)) return { body: [pull(9, "2026-01-03T00:00:00Z")] };
      if (url.startsWith(`${API}/repos/${first}/pulls/1/files`)) return { body: [{ filename: ".github/workflows/agent.yml" }] };
      if (url.includes("/pulls/9/files")) return { body: [{ filename: "README.md" }] };
      return undefined;
    });
    const gh = new GitHub(async () => "t", fetchImpl);
    const cache: HarnessCache = new Map();
    const news = await loadNews(gh, cache, 10);
    assert.deepEqual(news.items.map((n) => [n.repo, n.number, n.harness]), [
      [first, 1, true],
      ...rest.toSorted((a, b) => a.localeCompare(b)).map((r) => [r, 9, false]),
      [first, 3, true],
    ]);
    assert.equal(news.warnings.length, 1);
    assert.match(news.warnings[0] ?? "", new RegExp(`^${second}: .*404`));
    const fileReads = calls.filter((c) => c.url.includes("/files")).length;
    assert.equal(fileReads, 1 + rest.length);
    // Labeled PRs need no files, and a second load reads none.
    await loadNews(gh, cache, 10);
    assert.equal(calls.filter((c) => c.url.includes("/files")).length, fileReads);
  });
});
