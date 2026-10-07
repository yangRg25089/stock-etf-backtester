import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openSaved } from "./helpers/runtime.mjs";
import { savedRun } from "./helpers/reports.mjs";

async function manyResults(page) {
  const saved = await savedRun(page);
  const source = saved.result.strategyRuns[0];
  saved.result.strategyRuns = Array.from({ length: 10 }, (_, index) => ({
    ...structuredClone(source), id: `phone-${index}`, instanceNumber: index + 1,
  }));
  const strategy = saved.snapshot.config.strategies[0];
  saved.snapshot.config.strategies = saved.result.strategyRuns.map(row => ({ ...structuredClone(strategy), id: row.id }));
  saved.selectedStrategyIds = saved.result.strategyRuns.map(row => row.id);
  saved.progress = { completedStrategies: 10, totalStrategies: 10, currentStrategyId: null };
  return saved;
}

test("phone selection stays on one compact row and follows the details target", async ({ page }) => {
  await openSaved(page, await manyResults(page));
  await page.setViewportSize({ width: 320, height: 740 });
  for (const button of await page.locator(".comparison-table .result-select").all()) await button.click();
  await expect(page.locator(".selected-strategy-chip")).toHaveCount(10);
  await page.screenshot({ path: test.info().outputPath("phone-selected-before.png") });
  const strip = page.locator(".selected-strategies");
  const layout = await strip.evaluate(element => {
    const chips = [...element.children].map(chip => chip.getBoundingClientRect());
    return { rows: new Set(chips.map(chip => Math.round(chip.top))).size, height: element.clientHeight,
      overflow: element.scrollWidth > element.clientWidth,
      mainLeft: document.querySelector("main").getBoundingClientRect().left };
  });
  expect(layout.rows).toBe(1);
  expect(layout.height).toBeLessThanOrEqual(44);
  expect(layout.overflow).toBe(true);
  expect(layout.mainLeft).toBe(8);
  const focus = page.locator('.selected-strategy-chip[aria-current="true"]');
  const focusBox = await focus.boundingBox(), stripBox = await strip.boundingBox();
  expect(focusBox.x).toBeGreaterThanOrEqual(stripBox.x);
  expect(focusBox.x + focusBox.width).toBeLessThanOrEqual(stripBox.x + stripBox.width + 1);
  await expect(focus).toHaveCSS("border-top-width", "3px");
  await expect(page.locator(".app-topbar")).toHaveCSS("position", "sticky");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test("phone plots, dates and saved readings fit the viewport in three languages", async ({ page }) => {
  await openSaved(page, await savedRun(page));
  await page.locator(".comparison-table .result-select").first().click();
  for (const locale of ["ja", "zh", "en"]) {
    await page.locator(".locale-select").selectOption(locale);
    for (const width of [320, 360, 375, 390, 420, 767]) {
      await page.setViewportSize({ width, height: 740 });
      await page.locator(".chart-overlay").scrollIntoViewIfNeeded();
      const layout = await page.locator(".chart-linked-stack").evaluate(element => {
        const box = element.getBoundingClientRect();
        const svg = element.querySelector(".chart-overlay .result-chart").getBoundingClientRect();
        const date = element.querySelector(".chart-date-axis").getBoundingClientRect();
        const readout = element.querySelector(".chart-core-readout-row");
        return { width: element.clientWidth, scrollWidth: element.scrollWidth, plotWidth: svg.width,
          plotHeight: svg.height, dateWidth: date.width, left: box.left,
          readingsFit: readout.scrollWidth <= readout.clientWidth,
          ticksFit: [...element.querySelectorAll(".chart-y-tick")].every(tick => tick.getBoundingClientRect().left >= box.left - 1) };
      });
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
      expect(layout.plotWidth).toBeLessThanOrEqual(layout.width + 1);
      expect(layout.plotHeight).toBeGreaterThanOrEqual(180);
      expect(layout.dateWidth).toBeCloseTo(layout.plotWidth, 1);
      expect(layout.readingsFit).toBe(true);
      expect(layout.ticksFit).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const svg = page.locator(".chart-overlay .result-chart");
  await svg.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  const cursorDate = await page.locator(".chart-crosshair-readout").getAttribute("data-date");
  await expect(page.locator(".chart-cursor-date")).toHaveText(cursorDate);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: test.info().outputPath("phone-charts.png") });
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

test("touch phones retain full action targets and settings fit the screen", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await expect(page.locator(".run-submit-button")).toBeEnabled();
    for (const selector of [".execution-actions button", ".package-actions button", ".return-color-option", ".locale-select", ".theme-select"]) {
      for (const element of await page.locator(selector).all()) {
        const box = await element.boundingBox();
        expect(box.height, selector + " " + await element.getAttribute("class")).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(320);
      }
    }
    await page.locator(".workbench-mobile-view").first().click();
    await page.locator(".shared-settings-open-button").click();
    const dialog = await page.locator(".shared-settings-dialog").boundingBox();
    expect(dialog.x).toBe(8);
    expect(dialog.width).toBe(304);
    expect(dialog.height).toBeLessThanOrEqual(624);
    await expect(page.locator(".shared-settings-dialog .input").first()).toHaveCSS("font-size", "16px");
    await page.screenshot({ path: test.info().outputPath("phone-settings.png") });
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    let releaseSubmission;
    await page.route("**/api/v1/runs", async route => {
      await new Promise(resolve => { releaseSubmission = resolve; });
      await route.abort();
    });
    await page.locator(".run-submit-button").click();
    await expect(page.locator(".run-stop-button")).toBeVisible();
    const execution = await page.locator(".execution-actions").boundingBox();
    const files = await page.locator(".package-actions").boundingBox();
    expect(execution.x + execution.width).toBeLessThanOrEqual(files.x);
    await expect(page.locator(".execution-actions > button")).toHaveCount(3);
    for (const button of await page.locator(".execution-actions > button").all()) {
      const box = await button.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: test.info().outputPath("phone-running.png") });
    releaseSubmission();
    await expect(page.locator(".run-submit-button")).toBeEnabled();
    await openSaved(page, await savedRun(page));
    await page.setViewportSize({ width: 320, height: 844 });
    await page.locator(".comparison-table .result-select").first().tap();
    await page.locator(".chart-overlay").scrollIntoViewIfNeeded();
    const marker = page.locator(".chart-trade-hit-area").first();
    const target = await marker.boundingBox();
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.screenshot({ path: test.info().outputPath("phone-touch-results.png") });
  } finally { await context.close(); }
});
