import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openSaved, savedRun, pngDownload } from "./helpers/reports.mjs";
import { openTopbarMenu } from "./helpers/runtime.mjs";

for (const theme of ["light", "dark"]) for (const palette of ["red-up", "green-up"]) for (const width of [320, 1440]) {
  test(`original heatmap preserves all swatches and white labels at ${width}px ${theme} ${palette}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(() => {
      window.heatmapReportAudit = { fills: [], text: [] };
      const fill = CanvasRenderingContext2D.prototype.fillRect;
      CanvasRenderingContext2D.prototype.fillRect = function (...args) {
        window.heatmapReportAudit.fills.push({ color: this.fillStyle, bounds: args });
        return fill.apply(this, args);
      };
      const text = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (...args) {
        window.heatmapReportAudit.text.push({ value: args[0], color: this.fillStyle });
        return text.apply(this, args);
      };
    });
    const saved = await savedRun(page);
    const metrics = saved.result.strategyRuns[0].metrics.analysis;
    const sample = metrics.monthlyReturns[0];
    metrics.monthlyReturns = ["0.01", "0.04", "0.09", "0.16", "-0.01", "-0.04", "-0.09", "-0.16", "0", null, "1.2345", "-0.9999"].map((navReturn, index) => ({
      ...sample, year: 2024, month: index + 1, navReturn,
      unavailableReason: navReturn === null ? "missing_nav" : null,
      startDate: `2024-${String(index + 1).padStart(2, "0")}-01`, endDate: `2024-${String(index + 1).padStart(2, "0")}-28`,
    }));
    await openSaved(page, saved);
    await page.setViewportSize({ width, height: 900 });
    // Exercise the actual palette control; do not depend on preference key names.
    await openTopbarMenu(page);
    await page.locator(".return-color-option").filter({ has: page.locator(`.return-color-preview.is-${palette}`) }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".app-frame")).toHaveAttribute("data-return-palette", palette);
    for (const shape of await page.locator(".result-chart polyline[aria-label], .result-chart circle[aria-label]").all()) {
      await expect(shape).toHaveAttribute("role", "img");
    }
    const swatches = ["rgb(239, 74, 74)", "rgb(247, 45, 45)", "rgb(191, 34, 34)", "rgb(154, 26, 26)", "rgb(24, 213, 127)", "rgb(29, 200, 122)", "rgb(12, 154, 90)", "rgb(8, 116, 67)"];
    const cells = await page.locator(".heatmap-table tbody tr:first-child td:not(.heatmap-annual) .heatmap-cell").evaluateAll(nodes => nodes.map(node => {
      const cell = node.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(node); const bounds = range.getBoundingClientRect();
      return { fill: getComputedStyle(node).backgroundColor, text: getComputedStyle(node).color,
        inside: bounds.left >= cell.left && bounds.right <= cell.right && bounds.top >= cell.top && bounds.bottom <= cell.bottom };
    }));
    expect(cells).toHaveLength(12);
    expect(cells.slice(0, 8).map(cell => cell.fill)).toEqual(palette === "red-up" ? swatches : [...swatches.slice(4), ...swatches.slice(0, 4)]);
    for (const cell of cells.filter((_, index) => index !== 8 && index !== 9)) {
      expect(cell.text).toBe("rgb(255, 255, 255)");
    }
    await expect(page.locator(".heatmap-value")).toHaveCount(0);
    expect(cells.every(cell => cell.inside)).toBe(true);
    await page.locator(".monthly-performance").scrollIntoViewIfNeeded();
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    await page.screenshot({ path: test.info().outputPath("heatmap-original.png") });
    if (width < 768) await page.locator(".result-downloads-toggle").click();
    await pngDownload(page, "heatmap-original-report.png");
    const audit = await page.evaluate(() => window.heatmapReportAudit);
    const reportColors = audit.fills.filter(row => row.bounds[3] === 34).map(row => row.color);
    const hexSwatches = ["#ef4a4a", "#f72d2d", "#bf2222", "#9a1a1a", "#18d57f", "#1dc87a", "#0c9a5a", "#087443"];
    for (const color of hexSwatches) expect(reportColors).toContain(color);
    expect(audit.fills.some(row => row.color === "#243447")).toBe(false);
    expect(audit.text.filter(row => row.value === "+123.45%").some(row => row.color === "#ffffff")).toBe(true);
    // Keep the contrast gate truthful under the user-approved original palette.
    expect(accessibility.violations).toEqual([]);
  });
}
