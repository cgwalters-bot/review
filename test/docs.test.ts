import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { it } from "node:test";
import MarkdownIt from "markdown-it";

const root = new URL("../", import.meta.url);

it("keeps README as a short entry point to the website and checkout docs", () => {
  const readme = readFileSync(new URL("README.md", root), "utf8");
  assert.ok(readme.split("\n").length <= 20);
  assert.match(readme, /^# Control app\n\n> This text is LLM generated\./);
  assert.match(readme, /\]\(https:\/\/cgwalters-forge\.github\.io\/review\/\)/);
  assert.match(readme, /\]\(docs\/index\.md\)/);
  assert.match(readme, /\]\(LICENSE-MIT\)/);
  assert.match(readme, /\]\(LICENSE-APACHE\)/);
});

for (const file of ["README.md", "docs/index.md"]) {
  it(`${file} has resolvable relative links`, () => {
    const source = new URL(file, root);
    const tokens = new MarkdownIt().parse(readFileSync(source, "utf8"), {});
    for (const block of tokens) {
      for (const token of block.children ?? []) {
        if (token.type !== "link_open") continue;
        const href = token.attrGet("href")!;
        if (/^https?:/.test(href)) continue;
        const target = new URL(href, source);
        target.hash = "";
        assert.ok(existsSync(target), `${file}: missing ${href}`);
      }
    }
  });
}
