import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openSaved } from "./helpers/runtime.mjs";
import { savedRun } from "./helpers/reports.mjs";

test("comparison stays primary and focused details stay distinct from chart selection", async ({ page }) => {
  await openSaved(page, await savedRun(page));

  const comparison = page.locator("#result-panel-comparison");
  const resultCard = page.locator("#result-details");
  const detailCard = page.locator("#result-strategy-details");
  const detailsTarget = page.locator(".result-detail-target");
  const tabs = page.getByRole("tablist", { name: "実行結果の詳細" });
  await expect(resultCard).toHaveCount(1);
  await expect(comparison).toHaveCount(1);
  await expect(detailCard).toHaveCount(1);
  await expect(comparison).toBeVisible();
  await expect(resultCard).toContainText("実行結果");
  await expect(detailCard).toContainText("戦略詳細");
  await expect(resultCard.locator("#result-panel-comparison")).toBeVisible();
  await expect(page.getByRole("tab", { name: "戦略比較" })).toHaveCount(0);
  expect(await page.evaluate(() => {
    const comparisonTop = document.querySelector("#result-panel-comparison").getBoundingClientRect().top;
    const chartTop = document.querySelector("#result-chart-panel").getBoundingClientRect().top;
    const detailTop = document.querySelector("#result-strategy-details").getBoundingClientRect().top;
    const targetTop = document.querySelector(".result-detail-target").getBoundingClientRect().top;
    const tabsTop = document.querySelector(".result-tabs").getBoundingClientRect().top;
    return comparisonTop < chartTop && chartTop < detailTop && detailTop < targetTop && targetTop < tabsTop;
  })).toBe(true);
  await expect(tabs.getByRole("tab", { name: "詳細" })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(page.locator("#result-panel-trades")).toBeVisible();
  await expect(page.locator("#result-panel-performance")).toBeVisible();
  await expect(detailsTarget).toContainText("明細対象");

  await expect(page.locator(".comparison-table .is-focused, .comparison-table [aria-current]")).toHaveCount(0);
  const selectedButton = page.locator(".comparison-table .result-select").filter({ hasText: "ボラティリティ" });
  const originalId = await selectedButton.evaluate(button => button.closest("tr").dataset.resultId);
  await expect(selectedButton).toHaveAttribute("aria-pressed", "false");
  await selectedButton.click();
  await expect(selectedButton).toHaveAttribute("aria-pressed", "true");
  const otherButton = page.locator(".comparison-table .result-select").filter({ hasText: "毎月定額積立" });
  await otherButton.click();
  await expect(page.locator(".result-detail-name")).toHaveText("毎月定額積立");
  await expect(otherButton).toHaveAttribute("aria-pressed", "true");
  await otherButton.click();
  await expect(otherButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(`.comparison-table tr[data-result-id="${originalId}"] .result-select`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".comparison-table .is-focused, .comparison-table [aria-current]")).toHaveCount(0);
  const selectedRow = selectedButton.locator("xpath=ancestor::tr");
  const inactiveRow = otherButton.locator("xpath=ancestor::tr");
  expect((await selectedRow.boundingBox()).x).toBeLessThan((await inactiveRow.boundingBox()).x);
  const selectedColor = await selectedRow.evaluate(row => getComputedStyle(row).backgroundColor);
  expect(selectedColor).not.toBe(await inactiveRow.evaluate(row => getComputedStyle(row).backgroundColor));
  const brightness = selectedColor.match(/\d+/g).slice(0, 3).map(Number).reduce((sum, channel) => sum + channel, 0);
  expect(brightness).toBeGreaterThan(650);

  await page.getByRole("tab", { name: "詳細" }).click();
  await expect(detailsTarget).toContainText("毎月定額積立");
  const scrollers = await page.locator(".comparison-table-scroll, .trade-table-scroll, .performance-table-scroll, .search-table-scroll, .search-lab-scroll")
    .evaluateAll(elements => elements.map(element => getComputedStyle(element).maxHeight));
  expect(new Set(scrollers).size).toBe(1);

  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator("#result-panel-comparison")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }

  for (const locale of [
    { value: "ja", tabs: "実行結果の詳細", detailsHeading: "戦略詳細", target: "明細対象", strategy: "毎月定額積立", performance: "詳細" },
    { value: "zh", tabs: "结果详情", detailsHeading: "策略详情", target: "明细对象", strategy: "每月定额定投", performance: "详情" },
    { value: "en", tabs: "Result details", detailsHeading: "Strategy details", target: "Details for", strategy: "Monthly fixed-amount DCA", performance: "Details" },
  ]) {
    await page.locator(".locale-select").selectOption(locale.value);
    await expect(page.getByRole("tablist", { name: locale.tabs })).toBeVisible();
    await expect(detailCard).toContainText(locale.detailsHeading);
    await expect(detailsTarget).toContainText(locale.target);
    await expect(page.locator(".result-detail-name")).toHaveText(locale.strategy);
    await expect(page.getByRole("tab", { name: locale.performance })).toBeVisible();
  }
});
