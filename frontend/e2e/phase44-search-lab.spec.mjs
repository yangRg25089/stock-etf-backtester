import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { savedRun } from "./helpers/reports.mjs";
import { importPackage, installRunFixture } from "./helpers/runtime.mjs";

async function openSearch(page, saved) {
  await installRunFixture(page, saved);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".comparison-table").getByRole("button", { name: "グリッド検索", exact: true }).click();
  await page.locator("#result-tab-search").click();
  await page.locator(".search-lab > summary").click();
  return page.locator(".search-lab");
}

test("saved heatmap fixes the third dimension, switches stages/metrics and opens offline curves", async ({ page }) => {
  const saved = await savedRun(page, "grid_search", {
    "search.optimizationMode": "train_test", "search.trainEndDate": "2024-02-28",
    "search.dimensions": ["vix.buyThreshold", "rsi.buyThreshold", "accumulation.cashSafetyLimit"],
    "search.values.vix.buyThreshold": [30, 20, 25], "search.values.rsi.buyThreshold": [35, 25],
    "search.values.accumulation.cashSafetyLimit": [100, 200],
  }, rules => { rules.buy = rules.buy.children.find(item => item.kind === "vix"); rules.sell = null; });
  const grid = saved.result.strategyRuns.find(row => row.searchResult);
  const file = await (await page.request.get(`/api/v1/runs/${saved.runId}/package`)).json();
  const lab = await openSearch(page, saved);
  await lab.getByLabel("X", { exact: true }).selectOption("vix.buyThreshold");
  await lab.getByLabel("Y", { exact: true }).selectOption("rsi.buyThreshold");
  await lab.getByLabel("現金安全上限", { exact: true }).selectOption({ label: "200" });
  await expect(lab.locator(".search-heatmap-table thead th")).toHaveText(["RSI買付しきい値", "20", "25", "30"]);
  await expect(lab.locator(".search-heatmap-table tbody th")).toHaveText(["25", "35"]);
  await expect(lab.locator(".search-heat-cell")).toHaveCount(6);
  const candidate = grid.searchResult.candidates.find(row => Number(row.parameterValues["vix.buyThreshold"]) === 20
    && Number(row.parameterValues["rsi.buyThreshold"]) === 25 && Number(row.parameterValues["accumulation.cashSafetyLimit"]) === 200);
  await lab.getByLabel("指標", { exact: true }).selectOption("drawdown");
  const first = lab.locator(".search-heat-cell").first();
  const percent = value => new Intl.NumberFormat("ja-JP", { style: "percent", maximumFractionDigits: 2 }).format(Number(value));
  await expect(first).toHaveText(percent(candidate.metrics.maximumDrawdown));
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await lab.getByLabel("評価期間", { exact: true }).selectOption("test");
  await expect(first).toHaveText(percent(candidate.testResult.metrics.maximumDrawdown));
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await lab.getByLabel("指標", { exact: true }).selectOption("sharpe");
  expect(candidate.testResult.metrics.analysis.sharpeRatio).toBeNull();
  await expect(first).toHaveText("—");
  await lab.getByRole("button", { name: "近傍比較", exact: true }).click();
  await lab.getByLabel("パラメーター", { exact: true }).selectOption("rsi.buyThreshold");
  await lab.getByRole("button", { name: "ヒートマップ", exact: true }).click();
  expect(await lab.getByLabel("X", { exact: true }).inputValue()).not.toBe(await lab.getByLabel("Y", { exact: true }).inputValue());
  for (const language of ["日本語", "中文"]) {
    await page.getByRole("button", { name: language, exact: true }).click();
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 850 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await lab.screenshot({ path: test.info().outputPath("search-lab.png") });
  let requests = 0;
  await page.route("**/api/v1/runs/**", route => { requests++; return route.abort(); });
  await importPackage(page, file);
  await page.locator(".comparison-table").getByRole("button", { name: "网格搜索", exact: true }).click();
  await page.locator("#result-tab-search").click();
  await page.locator(".search-lab > summary").click();
  await lab.getByLabel("指标", { exact: true }).selectOption("drawdown");
  await lab.getByLabel("评估期间", { exact: true }).selectOption("test");
  await lab.locator(".search-heat-cell").first().focus();
  await page.keyboard.press("Enter");
  await expect(lab.locator(".search-heat-cell[aria-pressed='true']")).toHaveCount(1);
  expect(requests).toBe(0);
});

test("large numeric axes paginate bounded cells and preserve neighborhood ordering", async ({ page }) => {
  const values = Array.from({ length: 21 }, (_, index) => index + 10).reverse();
  const saved = await savedRun(page, "grid_search", {
    "search.dimensions": ["vix.buyThreshold", "rsi.buyThreshold"],
    "search.values.vix.buyThreshold": values, "search.values.rsi.buyThreshold": [25, 35],
  }, rules => { rules.buy = rules.buy.children.find(item => item.kind === "vix"); rules.sell = null; });
  const lab = await openSearch(page, saved);
  await expect(lab.locator(".search-heat-cell")).toHaveCount(40);
  await expect(lab.locator(".search-heatmap-table thead th").nth(1)).toHaveText("10");
  await lab.getByRole("button", { name: "X 軸の次の値", exact: true }).click();
  await expect(lab.locator(".search-heat-cell")).toHaveCount(2);
  await expect(lab.locator(".search-heatmap-table thead th").nth(1)).toHaveText("30");
  await lab.getByRole("button", { name: "近傍比較", exact: true }).click();
  await expect(lab.locator(".search-neighbor-table tbody tr")).toHaveCount(20);
  await expect(lab.locator(".search-neighbor-table tbody th").first()).toHaveText("10");
  await lab.getByRole("button", { name: "X 軸の次の値", exact: true }).click();
  await expect(lab.locator(".search-neighbor-table tbody th")).toHaveText("30");
});
