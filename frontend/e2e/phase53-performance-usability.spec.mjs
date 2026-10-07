import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { savedRun } from "./helpers/reports.mjs";
import { installRunFixture } from "./helpers/runtime.mjs";

test("monthly inspection stays compact and expands height only; saved metric explanations cover the cards", async ({ page }) => {
  const saved = await savedRun(page);
  const benchmark = saved.result.strategyRuns.find(row => row.presetId === "monthly_dca");
  await installRunFixture(page, saved);
  await page.goto("/");
  await page.locator(".comparison-table").getByRole("button", { name: "毎月定額積立", exact: true }).click();
  await page.locator("#result-tab-details").click();
  const panel = page.locator("#result-panel-performance");
  const monthly = panel.locator(".monthly-performance");
  const cell = monthly.locator(".heatmap-cell").first();
  await cell.hover();
  const period = benchmark.metrics.analysis.monthlyReturns[0];
  const percent = new Intl.NumberFormat("ja-JP", { style: "percent", maximumFractionDigits: 2 }).format(Number(period.navReturn));
  await expect(monthly.locator(".heatmap-detail")).toHaveText(`${period.year}-${String(period.month).padStart(2, "0")} · ${percent}`);
  const table = monthly.locator(".performance-table-scroll");
  const toggle = monthly.locator(".table-expand-button");
  const before = await table.innerText();
  const width = (await table.boundingBox()).width;
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await table.evaluate(node => getComputedStyle(node).maxHeight)).toBe("none");
  expect((await table.boundingBox()).width).toBe(width);
  expect(await table.innerText()).toBe(before);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await table.evaluate(node => getComputedStyle(node).maxHeight)).not.toBe("none");
  for (const language of ["日本語", "中文", "English"]) {
    await page.locator(".locale-select").selectOption(language === "日本語" ? "ja" : language === "中文" ? "zh" : "en");
    const cards = panel.locator(".performance-stat");
    await expect(cards).toHaveCount(11);
    for (const card of await cards.all()) {
      await card.hover();
      const tooltip = card.locator(".performance-help-tooltip");
      await expect(tooltip).toHaveCSS("visibility", "visible");
      await expect(tooltip).not.toBeEmpty();
      await card.focus();
      const description = await card.getAttribute("aria-describedby");
      expect(await page.locator(`[id="${description}"]`).innerText()).toBe(await tooltip.innerText());
    }
    for (const viewportWidth of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width: viewportWidth, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewportWidth);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    }
  }
  await panel.screenshot({ path: test.info().outputPath("performance-usability.png") });
});
