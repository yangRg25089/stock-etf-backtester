import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { savedRun } from "./helpers/reports.mjs";
import { restoreSavedRecord, installRunFixture, selectHeaderLocale } from "./helpers/runtime.mjs";

test("real saved periods, material DCA drawdowns and keyboard heatmap stay independent of edits and reconnect", async ({ page }) => {
  const saved = await savedRun(page);
  const benchmark = saved.result.strategyRuns.find(row => row.role === "benchmark" && row.presetId === "monthly_dca");
  const analysis = benchmark.metrics.analysis;
  expect(analysis.drawdownEpisodes.length).toBeGreaterThan(0);
  await installRunFixture(page, saved);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await page.locator(".comparison-table").getByRole("button", { name: "毎月定額積立", exact: true }).click();
  await expect(page.locator("#result-panel-performance")).toBeVisible();
  const panel = page.locator("#result-panel-performance");
  await expect(panel.locator(".heatmap-annual .heatmap-cell")).toHaveCount(analysis.annualReturns.length);
  await expect(panel.locator(".drawdown-episodes-table tbody tr")).toHaveCount(analysis.drawdownEpisodes.filter(row => Number(row.drawdown) <= -0.025).length);
  const percent = value => new Intl.NumberFormat("ja-JP", { style: "percent", maximumFractionDigits: 2 }).format(Number(value));
  const annual = analysis.annualReturns[0];
  await expect(panel.locator(".heatmap-annual .heatmap-cell").first()).toContainText(percent(annual.navReturn));
  const firstEpisode = analysis.drawdownEpisodes.find(row => Number(row.drawdown) <= -0.025);
  if (firstEpisode) {
    await expect(panel.locator(".drawdown-episodes-table tbody tr").first()).toContainText(firstEpisode.peakDate);
    await expect(panel.locator(".drawdown-episodes-table tbody tr").first()).toContainText(firstEpisode.bottomDate);
  } else await expect(panel.locator(".drawdown-episodes-table")).toHaveCount(0);
  await expect(panel.locator(".heatmap-cell")).toHaveCount(analysis.monthlyReturns.length + analysis.annualReturns.length);
  await expect(panel.locator(".heatmap-cell.is-negative")).toHaveCount(0);
  await expect(panel.locator(".heatmap-cell.is-positive")).toHaveCount(2 + analysis.annualReturns.filter(row => Number(row.navReturn) > 0).length);
  for (const [index, month] of analysis.monthlyReturns.entries()) {
    await expect(panel.locator(".heatmap-cell").nth(index)).toContainText(percent(month.navReturn));
  }
  const cell = panel.locator(".heatmap-cell").first();
  await cell.focus();
  await expect(panel.locator(".heatmap-detail")).toHaveText(await cell.getAttribute("aria-label"));
  await page.keyboard.press("Tab");
  await expect(panel.locator(".heatmap-cell").nth(1)).toBeFocused();
  const originalAnnual = await panel.locator(".heatmap-annual").allTextContents();
  const originalMonths = await panel.locator(".heatmap-table").innerText();
  await page.locator(".shared-settings-summary").click();
  await page.locator(".shared-settings-dialog #field-contribution-amount").fill("500");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  expect(await panel.locator(".heatmap-annual").allTextContents()).toEqual(originalAnnual);
  expect(await panel.locator(".heatmap-table").innerText()).toBe(originalMonths);
  for (const name of ["日本語", "中文"]) {
    await selectHeaderLocale(page, name === "日本語" ? "ja" : "zh");
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 850 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    }
  }
  await panel.locator(".period-performance").screenshot({ path: test.info().outputPath("period-performance-narrow.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  let requests = 0;
  await page.route("**/api/v1/runs/**", route => { requests++; return route.abort(); });
  await restoreSavedRecord(page, { result: saved });
  await page.locator(".comparison-table").getByRole("button", { name: "每月定额定投", exact: true }).click();
  await expect(page.locator("#result-panel-performance")).toBeVisible();
  await expect(panel.locator(".drawdown-episodes-table tbody tr")).toHaveCount(analysis.drawdownEpisodes.filter(row => Number(row.drawdown) <= -0.025).length);
  await expect(panel.locator(".heatmap-cell")).toHaveCount(analysis.monthlyReturns.length + analysis.annualReturns.length);
  expect(requests).toBe(0);
});

test("a partial losing month retains its sign and exact saved value", async ({ page }) => {
  const saved = await savedRun(page, "vix_dca", {}, undefined, { run: { endDate: "2024-02-02" } });
  const benchmark = saved.result.strategyRuns.find(row => row.role === "benchmark" && row.presetId === "monthly_dca");
  const period = benchmark.metrics.analysis.monthlyReturns[0];
  expect(Number(period.navReturn)).toBeCloseTo(198 / 202 - 1, 14);
  expect(period.endDate).toBe("2024-02-02");
  await installRunFixture(page, saved);
  await page.goto("/");
  await page.locator(".comparison-table").getByRole("button", { name: "毎月定額積立", exact: true }).click();
  await expect(page.locator("#result-panel-performance")).toBeVisible();
  const cell = page.locator("td:not(.heatmap-annual) .heatmap-cell.is-negative");
  await expect(cell).toHaveCount(1);
  await expect(cell).toHaveText("-1.98%");
  await cell.click();
  await expect(page.locator(".heatmap-detail")).toHaveText(await cell.getAttribute("aria-label"));
  await expect(cell).toHaveAttribute("title", /2024-02-01 → 2024-02-02/);
});
