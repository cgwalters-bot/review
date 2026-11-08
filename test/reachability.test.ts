import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { it } from "node:test";
import { build } from "esbuild";

it("keeps production modules reachable from the app or a built CLI", async () => {
  // The three entry points in build.ts. Keep this list in step with that build.
  const entries = ["src/github/main.ts", "src/cli/main.ts", "src/cli/controlplanemain.ts"];
  const inputs = await Promise.all(entries.map(async (entry) => {
    const result = await build({
      entryPoints: [entry], bundle: true, packages: "external", format: "esm",
      platform: entry.startsWith("src/cli/") ? "node" : "browser",
      write: false, metafile: true,
    });
    return new Set(Object.keys(result.metafile.inputs));
  }));
  const files = (await readdir("src", { recursive: true })).filter((file) => file.endsWith(".ts")).map((file) => `src/${file}`);
  assert.deepEqual(files.filter((file) => !inputs.some((input) => input.has(file))).sort(), [], "unreachable production modules");
  assert.deepEqual(files.filter((file) => !inputs[0]!.has(file) && !file.startsWith("src/cli/")).sort(), [], "CLI-only modules belong under src/cli/");
});
