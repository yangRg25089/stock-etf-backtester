import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { savedRun, openSaved, pngDownload } from "./helpers/reports.mjs";
import { openTopbarMenu } from "./helpers/runtime.mjs";

const rowFor = (page, id) => page.locator(`.comparison-table tr[data-result-id="${id}"]`);
const readingFor = (page, id) => page.locator(`.chart-strategy-readout[data-result-id="${id}"]`);

test("comparison selection pins the same curve/readings as hover and chart clicks focus details without a last-click row state", async ({ page }) => {
  const saved = await savedRun(page);
  await openSaved(page, saved);
  const [primary, dca] = saved.result.strategyRuns;
  await expect(page.locator(".comparison-table .is-focused, .comparison-table [aria-current]")).toHaveCount(0);
  await expect(page.locator(".chart-strategy-readout")).toHaveCount(0);
  await rowFor(page, primary.id).click();
  await expect(readingFor(page, primary.id)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".selected-strategy-chip")).toHaveCount(1);
  await page.mouse.move(1350, 55);
  const main = page.locator(".chart-overlay");
  const pinnedArea = await main.locator(".chart-highlight-area").getAttribute("d");
  await expect(main.locator(`.chart-trade-marker[data-result-id="${primary.id}"]`).first()).toBeVisible();
  await rowFor(page, dca.id).click();
  await expect(readingFor(page, dca.id)).toHaveAttribute("aria-pressed", "true");
  await expect(readingFor(page, primary.id)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".selected-strategy-chip")).toHaveCount(2);
  const focusedChip = page.locator('.selected-strategy-chip[aria-current="true"]');
  await expect(focusedChip).toHaveCount(1);
  await expect(focusedChip).toHaveAttribute("data-result-id", dca.id);
  await expect(focusedChip).toHaveCSS("border-top-width", "3px");
  await expect(focusedChip).toHaveCSS("font-weight", "700");
  await expect(focusedChip.locator(".selected-strategy-detail-label")).toBeVisible();
  await expect(page.locator(".result-detail-name")).toContainText("毎月定額積立");
  await readingFor(page, primary.id).hover();
  expect(await main.locator(".chart-highlight-area").getAttribute("d")).toBe(pinnedArea);
  await readingFor(page, primary.id).click();
  await page.mouse.move(1350, 55);
  await expect(readingFor(page, primary.id)).toHaveAttribute("aria-pressed", "true");
  expect(await main.locator(".chart-highlight-area").getAttribute("d")).toBe(pinnedArea);
  await expect(page.locator(".result-detail-name")).toContainText("ボラティリティ");
  await expect(focusedChip).toHaveAttribute("data-result-id", primary.id);
  await rowFor(page, dca.id).click();
  await expect(readingFor(page, dca.id)).toHaveCount(0);
  await expect(readingFor(page, primary.id)).toHaveAttribute("aria-pressed", "true");
  const priceToggle = page.locator('.chart-controls [data-series="price"]');
  await priceToggle.click(); await expect(priceToggle).toHaveAttribute("aria-pressed", "false");
  await priceToggle.click(); await expect(priceToggle).toHaveAttribute("aria-pressed", "true");
  await rowFor(page, primary.id).click();
  await expect(page.locator(".chart-strategy-readout, .chart-trade-marker, .selected-strategy-chip")).toHaveCount(0);
  await expect(main.locator("polyline.overlay-price")).toHaveCount(1);
  await rowFor(page, primary.id).click();
  for (const auxiliary of ["drawdown", "vix"]) {
    const figure = page.locator(`.chart-${auxiliary}`);
    await expect(figure.locator(".chart-y-axis-title")).toHaveCount(1);
    await expect(figure.locator(".chart-highlight-area")).toHaveCount(1);
    await expect(figure.locator("figcaption")).toHaveCount(0);
  }
  await page.screenshot({ path: test.info().outputPath("selected-curve-and-navigation.png") });
});

test("period metrics locate only material drawdowns for three seconds; annual returns share the monthly heatmap and PNG", async ({ page }) => {
  const saved = await savedRun(page);
  const analysis = saved.result.strategyRuns[0].metrics.analysis;
  analysis.annualReturns = analysis.annualReturns.map(row => ({ ...row, navReturn: "0.7777" }));
  analysis.maximumDrawdownDuration = 21; analysis.recoveryDuration = 12;
  analysis.drawdownEpisodes = [
    { peakDate: "2024-02-06", bottomDate: "2024-02-15", drawdown: "-0.08", recoveredDate: "2024-02-27", endDate: "2024-02-27", durationDays: 21, recoveryDays: 12, state: "recovered" },
    { peakDate: "2024-02-28", bottomDate: "2024-03-01", drawdown: "-0.025", recoveredDate: null, endDate: "2024-03-01", durationDays: 2, recoveryDays: null, state: "ongoing" },
    { peakDate: "2024-02-01", bottomDate: "2024-02-02", drawdown: "-0.024999999", recoveredDate: "2024-02-05", endDate: "2024-02-05", durationDays: 4, recoveryDays: 3, state: "recovered" },
  ];
  await openSaved(page, saved); await page.locator("#result-tab-details").click();
  await expect(page.locator(".annual-performance-table")).toHaveCount(0);
  const annual = page.locator(".heatmap-annual .heatmap-cell");
  await expect(annual).toHaveCount(analysis.annualReturns.length);
  await expect(annual.first()).toHaveAttribute("title", /年別/);
  const episodes = page.locator(".drawdown-episodes-table tbody tr");
  await expect(episodes).toHaveCount(2);
  const button = page.locator(".performance-episode-link").first();
  await button.click();
  await expect(page.locator('.drawdown-episodes-table tr[data-episode="2024-02-06"]')).toHaveClass(/is-located/);
  await expect(page.locator(".drawdown-episodes-table .is-located")).toHaveCount(0, { timeout: 5000 });
  await page.locator(".monthly-performance .table-expand-button").click();
  await expect(page.locator(".monthly-performance")).toHaveClass(/is-height-expanded/);
  await expect(page.locator(".monthly-performance .performance-group-heading")).toHaveCSS("position", "sticky");
  await annual.first().hover(); await expect(page.locator(".heatmap-detail")).toContainText("年別リターン");
  const canvasBefore = JSON.stringify(saved.result.strategyRuns[0].metrics.analysis);
  await pngDownload(page, "strategy-monthly-annual-report.png");
  const texts = await page.evaluate(() => window.reportAudit.text);
  expect(texts).toContain("月別リターン");
  expect(texts.some(text => text.includes("77.77%"))).toBe(true);
  expect(texts.some(text => text.includes("現金安全上限"))).toBe(true);
  expect(JSON.stringify(saved.result.strategyRuns[0].metrics.analysis)).toBe(canvasBefore);
});

test("tax defaults off and applies only on submission; sale taxes, totals and frozen CSV remain consistent", async ({ page }) => {
  const shared = { execution: { capitalGainsTaxEnabled: true } };
  const saved = await savedRun(page, "ma_trend", { "ma.period": 2 }, rules => {
    rules.buy.params["ma.period"] = 2;
    rules.sell.params["ma.period"] = 2;
  }, shared);
  const primary = saved.result.strategyRuns[0];
  expect(primary.trades.some(trade => trade.side === "sell")).toBe(true);
  const totalTax = primary.trades.reduce((sum, trade) => sum + Number(trade.tradingCosts.capitalGainsTax), 0);
  expect(Number(primary.metrics.tradingCosts.capitalGainsTax)).toBeCloseTo(totalTax, 12);
  await openSaved(page, saved); await page.locator(".locale-select").selectOption("en");
  await expect(page.locator(".comparison-table thead")).not.toContainText("Contributed capital");
  await expect(page.locator(".comparison-table thead th")).toHaveCount(9);
  await expect(page.locator(".comparison-table thead th").last()).toHaveText(/Tax/);
  const resultBefore = await page.locator(".comparison-table").innerText();
  await page.locator(".shared-settings-open-button").click();
  const tax = page.locator('[data-parameter-key="execution.capitalGainsTaxEnabled"]');
  await expect(tax).toHaveAttribute("aria-checked", "false");
  await tax.click(); await expect(tax).toHaveAttribute("aria-checked", "true");
  expect(await page.locator(".comparison-table").innerText()).toBe(resultBefore);
  await page.locator(".shared-settings-dialog .dialog-done").click();
  expect(await page.locator(".comparison-table").innerText()).toBe(resultBefore);
  const waiting = page.waitForEvent("download"); await page.locator('[data-export-kind="summary"]').click();
  const csv = await (await waiting).path();
  const { readFile } = await import("node:fs/promises");
  const expected = await page.request.get(`/api/v1/runs/${saved.runId}/export/summary`, { params: { focusedResultId: primary.id } });
  expect(await readFile(csv, "utf8")).toBe(await expected.text());
  const accepted = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/api/v1/runs"));
  await page.locator(".run-submit-button").click();
  expect((await accepted).postDataJSON().draft.shared.execution.capitalGainsTaxEnabled).toBe(true);
  await expect(page.locator(".run-submit-button")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".result-select[aria-pressed='true']")).toHaveCount(0);
  await expect(page.locator('.comparison-table th [data-sort-key="capitalGainsTax"]')).toBeEnabled();
});

test("visible file actions, compact execution controls, theme persistence, branding and footer work in three languages and responsive sizes", async ({ page }) => {
  await openSaved(page, await savedRun(page));
  await expect(page.locator(".package-menu, .package-actions details")).toHaveCount(0);
  await expect(page.locator(".package-actions button")).toHaveCount(2);
  await expect(page.locator(".execution-actions > button")).toHaveCount(2);
  await expect(page.locator(".run-stop-button")).toHaveCount(0);
  await expect(page.locator(".package-actions button span")).toHaveText(["export", "import"]);
  await expect(page.locator(".theme-select option")).toHaveText(["Classic", "Wine", "Navy", "Blush", "Forest"]);
  await expect(page.locator(".brand-mark")).toHaveAttribute("src", "/brand.svg");
  await expect(page.locator(".app-footer")).toContainText("MIT");
  for (const theme of ["classic", "burgundy", "midnight", "blush", "forest"]) {
    await page.locator(".theme-select").selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`${theme}-desktop.png`) });
  }
  for (const locale of ["ja", "zh", "en"]) {
    await page.locator(".locale-select").selectOption(locale);
    for (const width of [320, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await openTopbarMenu(page);
      await expect(page.locator(".package-actions button").first()).toBeVisible();
      const buttons = await page.locator(".execution-actions > button").all();
      const boxes = await Promise.all(buttons.map(button => button.boundingBox()));
      expect(new Set(boxes.map(box => box.width)).size).toBe(1);
      expect(boxes[0].width).toBeGreaterThanOrEqual(40);
      expect(boxes[0].height).toBe(32);
      expect(boxes[0].width).toBeGreaterThan(boxes[0].height);
      for (const button of await page.locator(".package-actions button").all()) {
        const box = await button.boundingBox();
        expect(box.height).toBe(32); expect(box.width).toBeGreaterThan(box.height);
        await expect(button.locator("span")).toBeVisible();
      }
      for (let index = 1; index < boxes.length; index++) expect(boxes[index - 1].x + boxes[index - 1].width).toBeLessThanOrEqual(boxes[index].x);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`forest-${locale}-${width}.png`) });
    }
  }
  await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-theme", "forest");
  await page.locator(".theme-select").selectOption("classic"); await expect(page.locator("html")).toHaveAttribute("data-theme", "classic");
});
