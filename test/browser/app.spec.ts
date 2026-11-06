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
// the token reads, so they stay off public PRs.

import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_DATA, type FixtureData, FIXTURE_TOKEN, fixtureResponse, isWrite } from "../e2e/fixture-api.ts";

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

async function screenshot(page: Page, view: string) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(SETTLE_MS);
  const prefix = LIVE_TOKEN ? "live-" : "";
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${prefix}${view}-${test.info().project.name}.png`, fullPage: true });
}

test("Needs you and Status render without errors", async ({ page }) => {
  const problems = await serve(page);
  await page.goto("#inbox");
  await page.locator(".signin input[type=password]").fill(LIVE_TOKEN ?? FIXTURE_TOKEN);
  await page.locator(".signin button[type=submit]").click();
  await expect(page.locator(".published")).toBeVisible();
  await expect(page.locator(".published")).not.toHaveText(/^Reading/);
  await screenshot(page, "inbox");

  await page.goto("#status");
  await expect(page.getByRole("heading", { name: "Poller passes" })).toBeVisible();
  await screenshot(page, "status");

  expect(problems).toEqual([]);
});
