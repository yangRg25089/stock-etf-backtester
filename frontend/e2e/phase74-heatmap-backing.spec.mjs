import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openSaved, savedRun, pngDownload } from "./helpers/reports.mjs";
import { openTopbarMenu } from "./helpers/runtime.mjs";

for (const theme of ["light", "dark"]) for (const palette of ["red-up", "green-up"]) for (const width of [320, 1440]) {
  test(`heatmap backing preserves all swatches and white labels at ${width}px ${theme} ${palette}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(() => {
      window.heatmapReportAudit = { backings: [], text: [] };
      const rounded = CanvasRenderingContext2D.prototype.roundRect;
      CanvasRenderingContext2D.prototype.roundRect = function (...args) {
        window.heatmapReportAudit.backings.push({ color: this.fillStyle, bounds: args });
        return rounded.apply(this, args);
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
      const label = node.querySelector(".heatmap-value"), cell = node.getBoundingClientRect(), bounds = label.getBoundingClientRect();
      return { fill: getComputedStyle(node).backgroundColor, text: getComputedStyle(label).color, backing: getComputedStyle(label).backgroundColor,
        inside: bounds.left >= cell.left && bounds.right <= cell.right && bounds.top >= cell.top && bounds.bottom <= cell.bottom };
    }));
    expect(cells).toHaveLength(12);
    expect(cells.slice(0, 8).map(cell => cell.fill)).toEqual(palette === "red-up" ? swatches : [...swatches.slice(4), ...swatches.slice(0, 4)]);
    for (const cell of cells.filter((_, index) => index !== 8 && index !== 9)) {
      expect(cell.text).toBe("rgb(255, 255, 255)"); expect(cell.backing).toBe("rgb(36, 52, 71)");
    }
    expect(cells[8].backing).toBe("rgba(0, 0, 0, 0)"); expect(cells[9].backing).toBe("rgba(0, 0, 0, 0)");
    expect(cells.every(cell => cell.inside)).toBe(true);
    await page.locator(".monthly-performance").scrollIntoViewIfNeeded();
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("heatmap-backing.png") });
    if (width < 768) await page.locator(".result-downloads-toggle").click();
    await pngDownload(page, "heatmap-backing-report.png");
    const audit = await page.evaluate(() => window.heatmapReportAudit);
    expect(audit.backings.length).toBeGreaterThanOrEqual(10);
    expect(audit.backings.every(row => row.color === "#243447" && row.bounds[2] <= 1104 / 14 - 4 && row.bounds[3] <= 18)).toBe(true);
    expect(audit.text.filter(row => row.value === "+123.45%").some(row => row.color === "#ffffff")).toBe(true);
  });
}
