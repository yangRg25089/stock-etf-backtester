import { expect, test } from "@playwright/test";
import { backtestFile, importPackage } from "./helpers/runtime.mjs";
import { savedRun } from "./helpers/reports.mjs";

async function execute(page) {
  const accepted = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/v1/runs"));
  await page.locator(".run-submit-button").click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const { runId } = await response.json();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/runs/${runId}`)).json()).status).toBe("completed");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await expect(page.locator("#result-details .diagnostic-list")).toHaveCount(0);
}

test("saved inputs survive refresh and rerun through the real API validation boundary", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.locator(".shared-settings-open-button").click();
  await page.locator("#field-run-startDate").fill("2024-02-01");
  await page.locator("#field-run-endDate").fill("2024-03-01");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await execute(page);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("stock-etf-backtester.last-run-strategy.v1")));
  expect(typeof saved.draft.strategies[0].params["vix.buyThreshold"]).toBe("string");
  await page.reload();
  await execute(page);
  expect(errors).toEqual([]);
});

test("an exported result configuration can be imported and executed again", async ({ page }) => {
  const saved = await savedRun(page);
  await page.goto("/");
  await importPackage(page, backtestFile(saved));
  await execute(page);
});
