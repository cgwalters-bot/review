import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCREENSHOT_DIR = "dist/screenshots";
const WIDTHS = [1280, 390];
const MAX_HEIGHT = 3000;
const REPLAYS = [
  { fixture: "174-grouped", kinds: ["Approve", "Act", "Answer", "Act", "Act"], rows: 22, decisions: 174, missing: 3 },
  { fixture: "174", kinds: ["Approve", "Answer", "Answer", "Answer", "Answer"], rows: 174, decisions: 174, missing: 0 },
  { fixture: "661", kinds: ["Approve", "Approve", "Approve", "Act", "Answer"], rows: 8, decisions: 8, missing: 1 },
  { fixture: "approval", kinds: ["Approve", "Approve", "Approve", "Approve"], rows: 4, decisions: 4, missing: 0 },
] as const;

// The renderer stubs API reads. Chromium only displays the resulting HTML:
// don't let embedded markup run scripts or load anything over the network.
test.use({ javaScriptEnabled: false, offline: true });

test("capture the initial Needs you fixture cards at both widths", async ({ page }, info) => {
  test.skip(process.env.CAPTURE_NEEDS_YOU !== "1" || info.project.name !== "desktop", "opt-in fixture capture on one page");
  test.setTimeout(45_000);
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { timeout: 5_000 });
  const files: string[] = [];
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  for (const { fixture, kinds, rows, decisions, missing } of REPLAYS) {
    const html = info.outputPath(`${fixture}.html`);
    await run(process.execPath, ["test/e2e/render-needs-you.ts", ".", fixture, html], { timeout: 5_000 });
    await page.setContent(await readFile(html, "utf8"));
    const section = page.locator("#sec-needs");
    const cards = section.locator(".inbox-cards > .card");
    await expect(section.getByText("Needs you", { exact: true })).toBeVisible();
    await expect(cards.locator(".card-head .kind")).toHaveText([...kinds]);
    await expect(cards.locator("details[open]")).toHaveCount(0);
    await expect(section.locator(".epic-chips [aria-pressed=true]")).toContainText(fixture === "approval" ? "Default (all)" : "In progress + approvals");
    await expect(section.locator(".epic-chips").getByRole("button", { name: /^Show everything/ })).toBeVisible();
    await expect(section.getByText(`${decisions} decisions reported:`, { exact: false })).toContainText(`${rows} rows`);
    await expect(section.getByText(`${decisions} decisions reported:`, { exact: false })).toContainText(`members: ${decisions}.`);
    const missingCards = cards.filter({ hasText: "Detail not published: inspect the source before acting" });
    await expect(missingCards).toHaveCount(missing);
    await expect(missingCards.locator(".kind.c-answer, .card-full")).toHaveCount(0);
    await expect(section).not.toContainText("descriptors could not be read safely");
    await expect(cards.first().getByRole("button", { name: /^Chat about / })).toBeVisible();

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      // Keep the viewport's horizontal margins, but omit the other sections.
      const box = await section.boundingBox();
      if (!box) throw new Error(`Needs you has no layout for ${fixture} at ${width}px`);
      const y = Math.floor(box.y);
      const height = Math.ceil(box.y + box.height) - y;
      expect(height, `${fixture} at ${width}px should fit within the capture bound`).toBeLessThanOrEqual(MAX_HEIGHT);
      const file = `needs-you-${fixture}-${width}.png`;
      await page.screenshot({ path: `${SCREENSHOT_DIR}/${file}`, fullPage: true, clip: { x: 0, y, width, height } });
      files.push(file);
    }
  }
  await writeFile(`${SCREENSHOT_DIR}/needs-you-replay.txt`, [
    "Offline Needs you fixture replay (not signed-in evidence)",
    `Checkout: ${stdout.trim()}`,
    ...files,
    "",
  ].join("\n"));
});
