import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { installRunFixture } from "./helpers/runtime.mjs";

test("partial API failures preserve results while strategy exports remain draft-only", async ({ page }) => {
  const response = await page.request.post("/api/v1/runs", { headers: { "Idempotency-Key": `partial-files-${Date.now()}` }, data: {
    draft: { shared: { run: { symbol: "QQQ", startDate: "2024-01-31", endDate: "2024-03-01" } },
      strategies: [{ id: "file-vix", presetId: "vix_dca", params: { "vix.buyThreshold": "not-numeric" } },
        { id: "file-custom", presetId: "composite_dca", params: {}, rules: {
          buy: { type: "condition", id: "buy-vix", kind: "vix", enabled: true, params: { "vix.symbol": "^VIX", "vix.buyThreshold": 25 } }, sell: null,
        } }] }, scope: "all_enabled",
  } });
  expect(response.status()).toBe(202);
  const { runId } = await response.json();
  let saved;
  await expect.poll(async () => {
    saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
    return saved.status;
  }).toBe("completed_with_warning");
  expect(saved.result.strategyRuns.filter(row => row.metrics)).toHaveLength(3);
  await installRunFixture(page, saved);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const restored = page.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith(`/api/v1/runs/${saved.runId}`));
  await page.goto("/");
  await restored;
  await expect(page.locator(".run-submit-button")).toHaveAttribute("aria-busy", "false");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("stock-etf-backtester.last-run-strategy.v1")).failedStrategyIds)).toEqual(["file-vix"]);
  const downloadEvent = page.waitForEvent("download");
  await page.locator('.package-actions button').first().click();
  const exported = JSON.parse(await readFile(await (await downloadEvent).path(), "utf8"));
  expect(exported.type).toBe("strategy");
  expect(exported).not.toHaveProperty("result");
  expect(exported.draft.strategies).toHaveLength(1);
  const prior = await page.locator(".comparison-table").textContent();

  // The run snapshot restores the malformed API strategy independently from
  // the valid one-strategy workspace package exported above.
  await installRunFixture(page, saved);
  await page.reload();
  await expect(page.locator(".strategy-card-open")).toHaveCount(2);
  await page.locator(".strategy-card-open").first().click();
  const dialog = page.locator(".strategy-dialog");
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-parameter-key="vix.buyThreshold"]')).toHaveAttribute("aria-invalid", "true");
  await dialog.locator('[data-parameter-key="vix.buyThreshold"]').fill("25");
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".comparison-table")).toHaveText(prior);

  await installRunFixture(page, saved);
  await page.reload();
  await expect(page.locator(".strategy-card-open")).toHaveCount(2);
  await page.locator(".strategy-card-open").first().click();
  await dialog.locator(".dialog-done").click();
  await expect(dialog.locator('[data-parameter-key="vix.buyThreshold"]')).toHaveAttribute("aria-invalid", "true");
  await dialog.locator('[data-parameter-key="vix.buyThreshold"]').fill("25");
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
