// Loads the built app in Chromium, signs in, and screenshots each view at
// the project's width (playwright.config.ts) into dist/screenshots/, failing
// on any console error or uncaught exception. Run it, and attach the
// screenshots to the PR, for every UI change:
//
//   npx playwright install chromium   # once
//   npm run test:browser
//
// By default the GitHub API answers from the fixtures (test/e2e/
// fixture-api.ts) and nothing leaves the machine; BROWSER_DATA picks one
// of its FIXTURE_DATA (default `group`). With REVIEW_LIVE_TOKEN set, it
// is a dry run against live data read with that token instead: reads go
// to api.github.com, and any write, which an approval or answer would be,
// is aborted and fails the test. Its screenshots (live-*.png) show what
// the token reads, so they stay off public PRs. Either way it also writes
// [live-]report-<project>.md, the page's status phrases and problem counts
// (test/e2e/live-report.ts), which .github/workflows/live.yml posts for agents.

import { expect, type Page, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { FIXTURE_DATA, type FixtureData, FIXTURE_TOKEN, fixtureResponse, isWrite } from "../e2e/fixture-api.ts";
import { countProblems, DIAGNOSTICS, diagnosticTexts, liveReport, type ViewReport } from "../e2e/live-report.ts";

const API = "https://api.github.com";
const SCREENSHOT_DIR = "dist/screenshots";
const SETTLE_MS = 500;
const LIVE_TOKEN = process.env.REVIEW_LIVE_TOKEN;
const DATA = (process.env.BROWSER_DATA ?? "group") as FixtureData;
if (!FIXTURE_DATA.includes(DATA)) throw new Error(`BROWSER_DATA=${DATA}: not one of ${FIXTURE_DATA.join(", ")}`);

/** Answers or passes the app's requests, and collects what went wrong. */
async function serve(page: Page): Promise<string[]> {
  const problems: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  // Anything but the app and the API, which the CSP forbids anyway.
  await page.route((url) => url.origin !== API && !url.href.startsWith(test.info().project.use.baseURL!), (route) => {
    problems.push(`unexpected request: ${route.request().url()}`);
    return route.abort();
  });
  await page.route(`${API}/**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ?? undefined;
    if (isWrite(req.method(), path, body)) {
      problems.push(`refused write: ${req.method()} ${path}`);
      return route.abort();
    }
    if (LIVE_TOKEN) return route.continue();
    return route.fulfill({ json: fixtureResponse(DATA, req.method(), path, body) });
  });
  return problems;
}

// The live report's views and problems, written after the test however it ends.
const views: ViewReport[] = [];
let problems: string[] = [];

test.beforeEach(() => {
  views.length = 0;
  problems = [];
});

test.afterEach(async ({ page }) => {
  const info = test.info();
  // The spec's line from the stack, not the message, which quotes the page.
  const spec = relative(process.cwd(), info.file);
  const line = info.errors.map((e) => e.stack?.split(`${info.file}:`)[1]?.match(/^\d+/)?.[0]).find(Boolean);
  // Where it stopped, when a failure cut the views short; the page may be gone.
  if (info.errors.length) views.push(await pageText(page, "at failure").catch(() => ({ view: "at failure (page unreadable)", texts: [] })));
  const failedAt = info.errors.length ? (line ? `${spec}:${line}` : spec) : null;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const prefix = LIVE_TOKEN ? "live-" : "";
  writeFileSync(`${SCREENSHOT_DIR}/${prefix}report-${info.project.name}.md`, liveReport(info.project.name, views, countProblems(problems, failedAt)));
});

/** The page's diagnostics, for the report. */
async function pageText(page: Page, view: string): Promise<ViewReport> {
  return { view, texts: await page.evaluate(diagnosticTexts, DIAGNOSTICS) };
}

async function screenshot(page: Page, view: string) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate(() => window.scrollTo(0, 0));
  const prefix = LIVE_TOKEN ? "live-" : "";
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${prefix}${view}-${test.info().project.name}.png`, fullPage: true });
  views.push(await pageText(page, view));
}

test("Needs you and Status render without errors", async ({ page }) => {
  problems = await serve(page);
  await page.goto("#inbox");
  await page.locator(".signin input[type=password]").fill(LIVE_TOKEN ?? FIXTURE_TOKEN);
  await page.locator(".signin button[type=submit]").click();
  await expect(page.locator(".published")).toBeVisible();
  await expect(page.locator(".published")).not.toHaveText(/^Reading/);
  if (!LIVE_TOKEN) {
    const run = page.getByRole("button", { name: "Run a pass now", exact: true });
    await expect(run).toBeDisabled();
    await page.getByRole("button", { name: "Check pass availability", exact: true }).click();
    await expect(run).toBeEnabled();
    await expect(page.locator(".run-pass-control [role=status]")).toContainText("No active pass found");
    // Keyboard cancellation must leave the write untouched (serve refuses writes).
    page.once("dialog", (dialog) => dialog.dismiss());
    await run.focus();
    await page.keyboard.press("Enter");
    await expect(run).toBeEnabled();
  }
  await screenshot(page, "inbox");
  if (!LIVE_TOKEN && DATA !== "259") {
    const today = page.getByRole("region", { name: "Today", exact: true });
    await expect(today).toBeVisible();
    await expect(today.getByText("3", { exact: true })).toBeVisible();
    await expect(today).toContainText("Incomplete pass history");
    await expect(today).toContainText("By pool: claude 2 · unknown 1");
    await expect(today.locator(".today-cost")).toContainText("$3.00 at list prices");
    await today.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await today.screenshot({ path: `${SCREENSHOT_DIR}/today-${test.info().project.name}.png` });
  }

  await page.goto("#status");
  await expect(page.getByRole("heading", { name: "Poller passes" })).toBeVisible();
  if (!LIVE_TOKEN) {
    const board = page.getByRole("region", { name: "Repositories", exact: true });
    await expect(board.getByRole("table")).toHaveCount(2);
    await expect(board.getByRole("cell", { name: "3", exact: true })).toBeVisible();
    await expect(board.getByText(/1 items omitted/)).toBeVisible();
    const entry = board.getByRole("link", { name: "Run a pass now" });
    await entry.focus();
    await expect(entry).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await screenshot(page, "status");

  expect(problems).toEqual([]);
});
