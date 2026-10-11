import { expect, test } from "@playwright/test";
import { openSaved, savedRun } from "./helpers/reports.mjs";

for (const width of [320, 375, 768, 1440]) {
  test(`selected area closes at the responsive plot bottom at ${width}px`, async ({ page }) => {
    await openSaved(page, await savedRun(page));
    await page.setViewportSize({ width, height: 900 });
    await page.locator('.comparison-table tr[data-result-id="report-strategy"] .result-select').click();
    const svg = page.locator(".chart-overlay svg.result-chart");
    await expect(svg.locator(".chart-highlight-area")).toHaveCount(1);
    const geometry = await svg.evaluate(svg => {
      const path = svg.querySelector(".chart-highlight-area");
      const coordinates = [...path.getAttribute("d").matchAll(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi)]
        .map(match => Number(match[0]));
      return { bottom: Number(svg.dataset.plotBottom), firstY: coordinates[1], lastY: coordinates.at(-1) };
    });
    expect(geometry.firstY).toBeCloseTo(geometry.bottom, 6);
    expect(geometry.lastY).toBeCloseTo(geometry.bottom, 6);
    const color = await page.locator('.comparison-table tr[data-result-id="report-strategy"] .result-color-swatch')
      .evaluate(el => getComputedStyle(el).backgroundColor);
    const fillColor = await svg.locator(".chart-highlight-fill stop").first()
      .evaluate(el => getComputedStyle(el).stopColor);
    expect(fillColor).toBe(color);
    await page.screenshot({ path: test.info().outputPath(`responsive-area-${width}.png`) });
  });
}

test("phone vertical drag never moves the value axis or curve", async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await openSaved(page, await savedRun(page));
    await page.locator('.comparison-table tr[data-result-id="report-strategy"] .result-select').click();
    const svg = page.locator(".chart-overlay svg.result-chart");
    await svg.scrollIntoViewIfNeeded();
    const bounds = await svg.boundingBox();
    const point = { x: Math.round(bounds.x + bounds.width * .6), y: Math.round(bounds.y + bounds.height * .5) };
    const before = await svg.locator(".overlay-series-line").first().getAttribute("points");
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y + 35 }] });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(svg.locator(".overlay-series-line").first()).toHaveAttribute("points", before);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await context.close();
  }
});
