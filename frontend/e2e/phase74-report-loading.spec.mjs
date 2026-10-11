import { expect, test } from "@playwright/test";
import { openSaved, savedRun, pngDownload } from "./helpers/reports.mjs";

const renderer = /\/src\/features\/results\/reportImage\.ts(?:\?|$)/;

test("report renderer is requested only for PNG download", async ({ page }) => {
  const requests = [];
  page.on("request", request => { if (renderer.test(request.url())) requests.push(request.url()); });
  await openSaved(page, await savedRun(page));
  await expect(page.locator("[data-report-kind=png]")).toBeEnabled();
  expect(requests).toHaveLength(0);
  await pngDownload(page, "on-demand-report.png");
  expect(requests).toHaveLength(1);
});

test("failed report module download shows a reload instruction and releases pending state", async ({ page }) => {
  await page.route(renderer, route => route.abort("failed"));
  await openSaved(page, await savedRun(page));
  await page.locator("[data-report-kind=png]").click();
  await expect(page.locator(".report-download-error")).toContainText("再読み込み");
  await expect(page.locator("[data-report-kind=png]")).toBeEnabled();
  await expect(page.locator("[data-report-kind=png]")).toHaveAttribute("aria-busy", "false");
  expect(await page.evaluate(() => window.reportAudit.downloads)).toBe(0);
});

test("changing focus while the renderer loads cancels the old report", async ({ page }) => {
  let release;
  let confirmRequest;
  const gate = new Promise(resolve => { release = resolve; });
  const requestStarted = new Promise(resolve => { confirmRequest = resolve; });
  await page.route(renderer, async route => { confirmRequest(); await gate; await route.continue(); });
  await openSaved(page, await savedRun(page));
  await page.locator("[data-report-kind=png]").click();
  await expect(page.locator("[data-report-kind=png]")).toHaveAttribute("aria-busy", "true");
  await requestStarted;
  await page.locator(".comparison-table .result-select").filter({ hasText: "毎月定額積立" }).click();
  await expect(page.locator("[data-report-kind=png]")).toHaveAttribute("aria-busy", "false");
  const loaded = page.waitForResponse(renderer);
  release();
  await loaded;
  await pngDownload(page, "changed-focus-report.png");
  expect(await page.evaluate(() => window.reportAudit.downloads)).toBe(1);
  expect(await page.evaluate(() => window.reportAudit.text.join("\n"))).toContain("毎月定額積立");
});
