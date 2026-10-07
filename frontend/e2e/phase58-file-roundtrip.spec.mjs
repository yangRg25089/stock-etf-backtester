import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { importPackage, fetchSavedRecord, restoreSavedRecord } from "./helpers/runtime.mjs";
import { savedRun } from "./helpers/reports.mjs";

async function downloadStrategy(page) {
  const waiting = page.waitForEvent("download");
  await page.locator(".package-actions button").first().click();
  const download = await waiting;
  expect(download.suggestedFilename()).toMatch(/\.strategy\.json$/);
  return JSON.parse(await readFile(await download.path(), "utf8"));
}

test("actual strategy JSON preserves all ten instances, independent params and numbering; it can run again", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
  await page.locator(".shared-settings-open-button").click();
  await page.locator("#field-run-startDate").fill("2024-02-01"); await page.locator("#field-run-endDate").fill("2024-03-01");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  for (let number = 2; number <= 5; number++) {
    await page.locator(".strategy-nav-card").first().hover(); await page.locator(".strategy-copy").first().click();
  }
  await page.locator(".strategy-card-open").nth(1).click();
  await page.locator('[data-parameter-key="vix.buyThreshold"]').fill("30"); await page.locator(".strategy-dialog .dialog-done").click();
  await page.locator(".add-strategy-button").click(); await page.getByRole("menuitem", { name: /カスタム戦略/ }).click();
  for (let number = 2; number <= 5; number++) {
    await page.locator(".strategy-nav-card").last().hover(); await page.locator(".strategy-copy").last().click();
  }
  await expect(page.locator(".strategy-card-open")).toHaveCount(10);
  const before = await page.locator(".strategy-card-name").allTextContents();
  const file = await downloadStrategy(page);
  expect(file.draft.strategies).toHaveLength(10); expect(new Set(file.draft.strategies.map(row => row.id)).size).toBe(10);
  expect(Number(file.draft.strategies[1].rules.buy.params["vix.buyThreshold"])).toBe(30);
  for (const presetId of ["vix_dca", "composite_dca"]) expect(file.draft.strategies.filter(row => row.presetId === presetId).map(row => row.instanceNumber)).toEqual([1, 2, 3, 4, 5]);
  await importPackage(page, file);
  expect(await page.locator(".strategy-card-name").allTextContents()).toEqual(before);
  await page.locator(".add-strategy-button").click();
  for (const item of await page.getByRole("menuitem").all()) await expect(item).toBeDisabled(); await page.keyboard.press("Escape");
  const accepted = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/v1/runs"));
  await page.locator(".run-submit-button").click(); expect((await accepted).status()).toBe(202);
  await expect(page.locator(".run-submit-button")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(12);
  await expect(page.locator(".result-select[aria-pressed='true']")).toHaveCount(0);
  const roundtrip = await downloadStrategy(page); expect(roundtrip.draft).toEqual(file.draft);
});

test("saved Train/Test candidates preserve every CSV byte and PNG across locales, sorting and zero trades", async ({ page }) => {
  const saved = await savedRun(page, "grid_search", {
    "search.dimensions": ["vix.buyThreshold"], "search.values.vix.buyThreshold": [20, 30],
    "search.optimizationMode": "train_test", "search.trainEndDate": "2024-02-28",
  }, rules => { rules.buy = rules.buy.children.find(node => node.kind === "vix"); rules.sell = null; });
  const record = await fetchSavedRecord(page, saved);
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/"); await restoreSavedRecord(page, record);
  const primary = saved.result.strategyRuns[0]; await page.locator(`.comparison-table tr[data-result-id="${primary.id}"] .result-select`).click();
  for (const locale of ["ja", "zh", "en"]) {
    await page.locator(".locale-select").selectOption(locale);
    for (const [id, result] of Object.entries(record.candidateDetails)) {
      await expect(page.locator(".result-search-section")).toBeVisible();
      const row = primary.searchResult.candidates.find(row => row.candidateId === id || row.testResult?.resultId === id);
      const index = primary.searchResult.candidates.indexOf(row);
      const cell = page.locator(".search-table tbody tr").filter({ has: page.locator(`.result-select`, { hasText: String(index + 1) }) });
      await cell.locator(id === row.candidateId ? ".result-select" : ".search-test-select").click();
      await expect(page.locator(".result-detail-name")).toContainText(`#${row.sequence}`);
      await expect(page.locator("#result-panel-performance")).toBeVisible();
      await expect(page.locator(".trade-table tbody tr")).toHaveCount(result.trades.length);
      await expect(page.locator("#result-panel-performance")).toBeVisible();
      await expect(page.locator(".annual-performance-table")).toHaveCount(0);
      await expect(page.locator(".heatmap-annual")).toHaveCount(result.metrics.analysis.annualReturns.length);
      await page.locator(".heatmap-table [data-sort-key='annual']").click();
      for (const kind of ["summary", "daily-assets", "trades", "search-results"]) {
        const waiting = page.waitForEvent("download"); await page.locator(`[data-export-kind="${kind}"]`).click();
        const bytes = await readFile(await (await waiting).path(), "utf8");
        expect(bytes).toBe(record.csv[`${kind === "search-results" ? primary.id : id}/${kind}`]);
      }
      const waiting = page.waitForEvent("download"); await page.locator("[data-report-kind=png]").click();
      const bytes = await readFile(await (await waiting).path()); expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
  }
});
