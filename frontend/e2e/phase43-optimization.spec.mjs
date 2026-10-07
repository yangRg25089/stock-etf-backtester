import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { savedRun } from "./helpers/reports.mjs";
import { restoreSavedRecord, fetchSavedRecord, installRunFixture, selectHeaderLocale } from "./helpers/runtime.mjs";

test("Train/Test selection, matching baselines, modal boundaries and portable offline results", async ({ page }) => {
  const saved = await savedRun(page, "grid_search", {
    "search.optimizationMode": "train_test", "search.trainEndDate": "2024-02-28",
    "search.dimensions": ["vix.buyThreshold"], "search.values.vix.buyThreshold": [20, 30],
  }, rules => { rules.buy = rules.buy.children.find(item => item.kind === "vix"); rules.sell = null; });
  const grid = saved.result.strategyRuns.find(row => row.presetId === "grid_search");
  expect(grid.searchResult.optimizationMode).toBe("train_test");
  const candidate = grid.searchResult.candidates[0];
  const file = await fetchSavedRecord(page, saved);
  expect(Object.keys(file.candidateDetails)).toHaveLength(4);
  const csvs = {};
  for (const kind of ["summary", "daily-assets", "trades"]) {
    const response = await page.request.get(`/api/v1/runs/${saved.runId}/export/${kind}`, { params: { focusedResultId: candidate.testResult.resultId } });
    expect(response.ok()).toBe(true); csvs[kind] = await response.text();
  }
  await installRunFixture(page, saved);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".comparison-table").getByRole("button", { name: "グリッド検索", exact: true }).click();
  await page.locator(".comparison-table").getByRole("button", { name: "毎月定額積立", exact: true }).click();
  await page.locator(".comparison-table").getByRole("button", { name: "グリッド検索", exact: true }).click();
  await expect(page.locator(".result-search-section")).toBeVisible();
  const runButton = page.getByRole("button", { name: "バックテストを実行", exact: true });
  await expect(runButton).toBeEnabled();
  const periodsBefore = await page.locator(".search-periods").textContent();
  await page.getByRole("button", { name: "戦略を追加", exact: true }).click();
  await page.locator(".strategy-add-option").filter({ hasText: "グリッド検索" }).click();
  await expect(runButton).toBeEnabled();
  const disabledBefore = await runButton.isDisabled();
  await page.locator(".strategy-card-open").filter({ hasText: "グリッド検索" }).click();
  const dialog = page.locator(".strategy-dialog");
  await expect(dialog.locator("[data-parameter-key='search.optimizationMode']")).toHaveValue("full_period");
  await dialog.locator("[data-parameter-key='search.optimizationMode']").selectOption("train_test");
  await dialog.locator("[data-parameter-key='search.trainEndDate']").fill("");
  await dialog.locator(".dialog-done").click();
  await expect(dialog.locator("[data-parameter-key='search.trainEndDate']")).toHaveAttribute("aria-invalid", "true");
  expect(await runButton.isDisabled()).toBe(disabledBefore);
  await dialog.locator("[data-parameter-key='search.trainEndDate']").fill("2024-02-27");
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".search-periods")).toHaveText(periodsBefore);
  await expect(page.locator(".search-periods")).toContainText("2024-02-28");
  await expect(page.locator(".comparison-period")).toHaveText("学習");
  await expect(page.locator(".search-table thead")).toContainText("学習 XIRR");
  await expect(page.locator(".search-table thead")).toContainText("検証 XIRR");
  await page.getByRole("button", { name: "候補 #1 の検証結果を見る", exact: true }).click();
  await expect(page.locator(".search-test-select").first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#result-panel-performance")).toBeVisible();
  await expect(page.locator(".result-detail-name")).toContainText("検証");
  await expect(page.locator(".result-detail-name")).toContainText("2024-02-29 → 2024-03-01");
  const main = page.locator(".chart-overlay");
  await expect(main).toContainText("検証");
  expect(await main.locator("[data-result-id]").count()).toBeGreaterThan(0);
  await expect(page.locator(".result-search-section")).toBeVisible();
  for (const language of ["日本語", "中文"]) {
    await selectHeaderLocale(page, language === "日本語" ? "ja" : language === "中文" ? "zh" : "en");
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 850 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".search-results").screenshot({ path: test.info().outputPath("train-test.png") });
  let requests = 0;
  await page.route("**/api/v1/runs/**", route => { requests++; return route.abort(); });
  await restoreSavedRecord(page, file);
  await page.locator(".comparison-table").getByRole("button", { name: "网格搜索", exact: true }).click();
  await expect(page.locator(".result-search-section")).toBeVisible();
  await page.getByRole("button", { name: "查看候选 #1 的测试结果", exact: true }).click();
  for (const kind of ["summary", "daily-assets", "trades"]) {
    const download = page.waitForEvent("download");
    await page.locator(`[data-export-kind='${kind}']`).click();
    expect(await readFile(await (await download).path(), "utf8")).toBe(csvs[kind]);
  }
  expect(requests).toBe(0);
});
