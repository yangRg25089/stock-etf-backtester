import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openSaved, savedRun } from "./helpers/reports.mjs";
import { installRunFixture } from "./helpers/runtime.mjs";

const GREEN = "rgb(8, 116, 67)";
const RED = "rgb(183, 28, 28)";

test("one global return convention follows locale until a manual choice and survives focus changes and reload", async ({ page }) => {
  const saved = await savedRun(page);
  for (const result of saved.result.strategyRuns) {
    const analysis = result.metrics?.analysis;
    if (!analysis) continue;
    analysis.annualizedReturn = "-0.04";
    analysis.annualReturns = [{ year: 2024, startDate: "2024-01-01", endDate: "2024-12-31", navReturn: "-0.04", priceReturn: "0.08" }];
    analysis.monthlyReturns = [
      { year: 2024, month: 1, startDate: "2024-01-01", endDate: "2024-01-31", navReturn: "0.05", priceReturn: "0.08" },
      { year: 2024, month: 2, startDate: "2024-02-01", endDate: "2024-02-29", navReturn: "-0.04", priceReturn: "-0.06" },
    ];
  }
  await openSaved(page, saved);
  const frame = page.locator(".app-frame");
  const control = page.locator(".return-color-control");
  const locale = page.locator(".locale-select");
  await expect(control).toHaveCount(1);
  expect((await control.boundingBox()).x + (await control.boundingBox()).width).toBeLessThan((await locale.boundingBox()).x);
  await expect(frame).toHaveAttribute("data-return-palette", "green-up");
  const positive = page.locator(".comparison-table .return-value.is-positive").first();
  await expect(positive).toHaveCSS("color", GREEN);
  const benchmarkId = saved.result.strategyRuns.find(result => result.presetId === "monthly_dca").id;
  await page.locator(`.comparison-table tr[data-result-id="${benchmarkId}"] .result-select`).click();
  const chartReturn = page.locator(`.chart-strategy-readout[data-result-id="${benchmarkId}"] .return-value`);
  await expect(chartReturn).toHaveClass(/is-positive/);
  await expect(chartReturn).toHaveCSS("color", GREEN);
  const comparisonValues = await page.locator(".comparison-table .return-value").allTextContents();
  let submissions = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/runs")) submissions++; });

  await page.locator("#result-tab-details").click();
  const performance = page.locator("#result-panel-performance");
  const monthlyPositive = performance.locator(".heatmap-cell.is-positive");
  const monthlyNegative = performance.locator("td:not(.heatmap-annual) .heatmap-cell.is-negative");
  await expect(monthlyPositive).toHaveCSS("background-color", GREEN);
  await expect(monthlyNegative).toHaveCSS("background-color", RED);
  await expect(performance.locator(".performance-stat .return-value.is-negative")).toHaveCSS("color", RED);
  await expect(performance.locator(".heatmap-annual .heatmap-cell.is-negative")).toHaveCSS("background-color", RED);
  await expect(performance.locator(".heatmap-annual .heatmap-cell.is-negative").first()).toHaveCSS("background-color", RED);
  await monthlyNegative.hover();
  await expect(performance.locator(".heatmap-detail .return-value.is-negative")).toHaveCSS("color", RED);
  await expect(performance.locator(".return-color-control")).toHaveCount(0);

  await locale.selectOption("zh");
  await expect(frame).toHaveAttribute("data-return-palette", "red-up");
  await expect(positive).toHaveCSS("color", RED);
  await expect(chartReturn).toHaveCSS("color", RED);
  await expect(monthlyNegative).toHaveCSS("background-color", GREEN);
  await locale.selectOption("en");
  await expect(frame).toHaveAttribute("data-return-palette", "green-up");
  await control.getByRole("button", { name: "Gains red, losses green" }).click();
  await expect(frame).toHaveAttribute("data-return-palette", "red-up");
  await expect(positive).toHaveCSS("color", RED);
  await expect(chartReturn).toHaveCSS("color", RED);
  await expect(performance.locator(".performance-stat .return-value.is-negative")).toHaveCSS("color", GREEN);
  await expect(performance.locator(".heatmap-annual .heatmap-cell.is-negative").first()).toHaveCSS("background-color", GREEN);
  await expect(monthlyNegative).toHaveCSS("background-color", GREEN);
  await page.locator(".comparison-table .result-select").nth(1).click();
  await expect(frame).toHaveAttribute("data-return-palette", "red-up");
  await expect(monthlyPositive).toHaveCSS("background-color", RED);
  await locale.selectOption("ja");
  await expect(frame).toHaveAttribute("data-return-palette", "red-up");
  expect(await page.locator(".comparison-table .return-value").allTextContents()).toEqual(comparisonValues);
  expect(submissions).toBe(0);
  await installRunFixture(page, saved);
  await page.reload();
  await expect(frame).toHaveAttribute("data-return-palette", "red-up");
  await expect(control.getByRole("button", { name: "上昇は赤、下落は緑" })).toHaveAttribute("aria-pressed", "true");
  await expect(positive).toHaveCSS("color", RED);
  await page.locator("#result-tab-details").click();
  await expect(monthlyPositive).toHaveCSS("background-color", RED);
  await expect(monthlyNegative).toHaveCSS("background-color", GREEN);
  for (const choice of ["上昇は緑、下落は赤", "上昇は赤、下落は緑"]) {
    await control.getByRole("button", { name: choice }).click();
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);
  }
  await page.screenshot({ path: test.info().outputPath("global-return-colors-desktop.png") });
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(control).toBeVisible();
    await expect(locale).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const paletteBox = await control.boundingBox();
    expect(paletteBox.x + paletteBox.width).toBeLessThan((await locale.boundingBox()).x);
    const brand = await page.locator(".brand-mark").boundingBox();
    for (const selector of [".return-color-control", ".locale-select", ".package-actions"]) {
      const box = await page.locator(selector).boundingBox();
      const overlapsBrand = box.x < brand.x + brand.width && brand.x < box.x + box.width
        && box.y < brand.y + brand.height && brand.y < box.y + box.height;
      expect(overlapsBrand, `${selector} covers the brand at ${width}px`).toBe(false);
    }
    if (width === 320) await page.screenshot({ path: test.info().outputPath("global-return-colors-mobile.png") });
  }
});

test.describe("touch return controls", () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 900 } });

  test("header retains its fixed height and distinct touch targets on a narrow screen", async ({ page }) => {
    await openSaved(page, await savedRun(page));
    await page.setViewportSize({ width: 320, height: 900 });
    const header = await page.locator(".app-topbar").boundingBox();
    expect(header.height).toBeGreaterThanOrEqual(108);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    const palette = await page.locator(".return-color-control").boundingBox();
    const locale = await page.locator(".locale-select").boundingBox();
    expect(palette.x + palette.width).toBeLessThan(locale.x);
    const brand = await page.locator(".brand-mark").boundingBox();
    expect(brand.y + brand.height).toBeLessThanOrEqual(palette.y);
    for (const button of await page.locator(".return-color-option").all()) {
      const box = await button.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const files = await page.locator(".package-actions").boundingBox();
    expect(files.y).toBeGreaterThanOrEqual(palette.y + palette.height);
    await page.locator(".return-color-control").getByRole("button", { name: "上昇は赤、下落は緑" }).tap();
    await expect(page.locator(".app-frame")).toHaveAttribute("data-return-palette", "red-up");
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("global-return-colors-touch.png") });
  });
});

test("search training/testing returns and the XIRR matrix use the same global signs and colors", async ({ page }) => {
  const saved = await savedRun(page, "grid_search", {
    "search.optimizationMode": "train_test", "search.trainEndDate": "2024-02-28",
    "search.dimensions": ["vix.buyThreshold", "accumulation.cashSafetyLimit"],
    "search.values.vix.buyThreshold": [20, 30], "search.values.accumulation.cashSafetyLimit": [100, 200],
  }, rules => { rules.buy = rules.buy.children.find(item => item.kind === "vix"); rules.sell = null; });
  const grid = saved.result.strategyRuns.find(result => result.searchResult);
  grid.searchResult.candidates.forEach((candidate, index) => {
    if (candidate.metrics) candidate.metrics.xirr = index % 2 ? "-0.8" : "12";
    if (candidate.testResult?.metrics) candidate.testResult.metrics.xirr = index % 2 ? "0.09" : "-0.06";
  });
  await openSaved(page, saved);
  await page.locator("#result-tab-search").click();
  const search = page.locator("#result-panel-search");
  await expect(search.locator(".search-table .return-value.is-positive").first()).toHaveCSS("color", GREEN);
  await expect(search.locator(".search-table .return-value.is-negative").first()).toHaveCSS("color", RED);
  await search.locator(".search-lab > summary").click();
  const positive = search.locator(".search-heat-cell .return-value.is-positive").first();
  const negative = search.locator(".search-heat-cell .return-value.is-negative").first();
  await expect(positive).toHaveCSS("color", GREEN);
  await expect(negative).toHaveCSS("color", RED);
  const background = await positive.locator("..").evaluate(button => getComputedStyle(button).backgroundColor);
  await page.locator(".return-color-control").getByRole("button", { name: "上昇は赤、下落は緑" }).click();
  await expect(search.locator(".search-table .return-value.is-positive").first()).toHaveCSS("color", RED);
  await expect(search.locator(".search-table .return-value.is-negative").first()).toHaveCSS("color", GREEN);
  await expect(positive).toHaveCSS("color", RED);
  await expect(negative).toHaveCSS("color", GREEN);
  expect(await positive.locator("..").evaluate(button => getComputedStyle(button).backgroundColor)).not.toBe(background);
  for (const choice of ["上昇は緑、下落は赤", "上昇は赤、下落は緑"]) {
    await page.locator(".return-color-control").getByRole("button", { name: choice }).click();
    await search.locator(".search-heatmap-table").scrollIntoViewIfNeeded();
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);
  }
});
