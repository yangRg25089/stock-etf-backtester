import { expect, test } from "@playwright/test";
import { openSaved, savedRun } from "./helpers/reports.mjs";

async function phoneRun(page, saved, width = 375) {
  await openSaved(page, saved);
  await page.setViewportSize({ width, height: 812 });
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(saved.result.strategyRuns.length);
}

test("phone chart toolbar stays in one row and folds visibility controls", async ({ page }) => {
  const saved = await savedRun(page);
  await phoneRun(page, saved, 320);
  const toolbar = page.locator(".chart-toolbar");
  expect((await toolbar.boundingBox()).height).toBeLessThanOrEqual(56);
  const toggle = page.locator(".chart-phone-menu-toggle");
  await expect(toggle).toBeVisible();
  const directActions = await page.locator(".chart-phone-action-row > button, .chart-phone-action-row .chart-touch-controls button, .chart-phone-action-row .chart-range-controls button").evaluateAll(nodes =>
    nodes.filter(node => getComputedStyle(node).display !== "none").map(node => ({ top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height })));
  expect(directActions.length).toBeGreaterThanOrEqual(6);
  expect(Math.max(...directActions.map(box => box.top + box.height)) - Math.min(...directActions.map(box => box.top))).toBeLessThanOrEqual(48);

  await toggle.click();
  await expect(page.locator(".chart-controls")).toBeVisible();
  await expect(page.locator(".chart-controls .legend-toggle")).toHaveCount(4);
  const price = page.locator('.chart-controls .legend-toggle[data-series="price"]');
  const wasPressed = await price.getAttribute("aria-pressed");
  await price.click();
  await expect(price).toHaveAttribute("aria-pressed", wasPressed === "true" ? "false" : "true");
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await expect(page.locator(".chart-controls")).toBeHidden();
  await page.setViewportSize({ width: 1024, height: 812 });
  await expect(page.locator(".chart-phone-menu-toggle")).toBeHidden();
  await expect(page.locator(".chart-range-controls button")).toHaveCount(4);
  for (const button of await page.locator(".chart-range-controls button").all()) await expect(button).toBeVisible();
  expect(await page.locator(".chart-phone-action-row").evaluate(element => getComputedStyle(element).display)).toBe("contents");
  await page.setViewportSize({ width: 320, height: 812 });
  await toolbar.evaluate(element => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: test.info().outputPath("phone-chart-toolbar.png") });
});

test("phone action menus fit their labels without leaving asymmetric padding", async ({ page }) => {
  const saved = await savedRun(page);
  await phoneRun(page, saved, 375);

  await page.locator(".topbar-menu-toggle").click();
  const nav = page.locator(".topbar-functions");
  await expect(nav).toBeVisible();
  expect((await nav.boundingBox()).width).toBeLessThanOrEqual(144);
  await page.screenshot({ path: test.info().outputPath("phone-topbar-menu.png") });
  await page.keyboard.press("Escape");

  const trigger = page.locator(".result-downloads-toggle");
  await trigger.click();
  const panel = page.locator(".result-downloads-panel");
  const buttons = panel.locator(".button");
  await expect(buttons).toHaveCount(5);
  expect((await panel.boundingBox()).width).toBeLessThanOrEqual(184);
  const padding = await panel.evaluate(element => Number.parseFloat(getComputedStyle(element).paddingLeft));
  const edges = await panel.evaluate(element => {
    const first = element.querySelector(".button").getBoundingClientRect();
    const last = [...element.querySelectorAll(".button")].at(-1).getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return { left: first.left - box.left, right: box.right - last.right };
  });
  expect(edges.left).toBeCloseTo(padding + 1, 0);
  expect(edges.right).toBeCloseTo(edges.left, 0);
  for (const button of await buttons.all()) {
    expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: test.info().outputPath("phone-download-menu.png") });
});

test("monthly return labels fit their cells and the strategy column stays compact", async ({ page }) => {
  const saved = await savedRun(page);
  const metrics = saved.result.strategyRuns[0].metrics.analysis;
  metrics.monthlyReturns = metrics.monthlyReturns.map((row, index) => index === 0 ? { ...row, navReturn: "0.0231" }
    : index === 1 ? { ...row, navReturn: "-0.9999" }
      : index === 2 ? { ...row, navReturn: "1.2345" } : row);
  metrics.annualReturns = metrics.annualReturns.map((row, index) => index === 0 ? { ...row, navReturn: "1.2345" } : row);
  await phoneRun(page, saved, 375);

  const textBoxes = await page.locator(".heatmap-cell").evaluateAll(elements => elements.map(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const text = range.getBoundingClientRect(), cell = element.getBoundingClientRect();
    return { value: element.textContent, textLeft: text.left, textRight: text.right, cellLeft: cell.left, cellRight: cell.right };
  }));
  expect(textBoxes.map(box => box.value)).toEqual(expect.arrayContaining(["+2.31%", "-99.99%", "+123.45%"]));
  for (const box of textBoxes) {
    expect(box.textLeft).toBeGreaterThanOrEqual(box.cellLeft);
    expect(box.textRight).toBeLessThanOrEqual(box.cellRight);
  }
  const heatmapColumns = await page.locator(".heatmap-table tbody tr:first-child > *").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  expect(heatmapColumns[0]).toBeGreaterThanOrEqual(44);
  expect(heatmapColumns[1]).toBeGreaterThanOrEqual(60);
  expect(heatmapColumns.at(-1)).toBeGreaterThanOrEqual(72);

  const comparison = page.locator(".comparison-table");
  await expect(comparison.locator("thead th:first-child")).toHaveCSS("width", "96px");
  expect(await comparison.locator("tbody th:first-child").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width))).toEqual([96, 96, 96]);
  await page.locator(".monthly-performance").scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("phone-monthly-returns.png") });
});

test("expanded table headings follow the measured phone navigation height", async ({ page }) => {
  const saved = await savedRun(page);
  const metrics = saved.result.strategyRuns[0].metrics.analysis;
  const sample = metrics.monthlyReturns[0];
  metrics.monthlyReturns = Array.from({ length: 16 * 12 }, (_, index) => {
    const year = 2010 + Math.floor(index / 12), month = index % 12 + 1, prefix = `${year}-${String(month).padStart(2, "0")}`;
    return { ...sample, year, month, startDate: `${prefix}-01`, endDate: `${prefix}-28`, navReturn: "0.0231" };
  });
  const annual = metrics.annualReturns[0];
  metrics.annualReturns = Array.from({ length: 16 }, (_, index) => ({
    ...annual, year: 2010 + index, startDate: `${2010 + index}-01-01`, endDate: `${2010 + index}-12-31`, navReturn: "0.0231",
  }));
  await phoneRun(page, saved, 375);

  const offsets = await page.evaluate(() => {
    const frame = document.querySelector(".app-frame"), topbar = document.querySelector(".app-topbar");
    return { frame: getComputedStyle(frame).getPropertyValue("--table-expanded-sticky-top").trim(), topbar: `${topbar.getBoundingClientRect().height}px` };
  });
  expect(offsets.frame).toBe(offsets.topbar);

  const section = page.locator(".monthly-performance");
  await section.locator(".table-expand-button").click();
  await section.evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY + 180));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const alignment = await section.evaluate(element => {
    const heading = element.querySelector(".performance-group-heading").getBoundingClientRect();
    const nav = document.querySelector(".app-topbar").getBoundingClientRect();
    const tableHead = element.querySelector("thead").getBoundingClientRect();
    return { navBottom: nav.bottom, headingTop: heading.top, headingBottom: heading.bottom, tableHeadTop: tableHead.top };
  });
  expect(alignment.headingTop).toBeCloseTo(alignment.navBottom, 0);
  expect(alignment.tableHeadTop).toBeCloseTo(alignment.headingBottom, 0);
  await section.locator(".table-expanded-overflow").evaluate(element => { element.scrollLeft = 120; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: test.info().outputPath("phone-expanded-sticky-table.png") });
});

test("maintenance UI reference reflects the phone layout and has no browser errors", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto(new URL("./fixtures/workbench-reference.html", import.meta.url).href);
  const toolbar = page.locator(".chart-toolbar");
  expect((await toolbar.boundingBox()).height).toBeLessThanOrEqual(56);
  await page.locator(".chart-phone-menu-toggle").click();
  await expect(page.locator("#prototype-chart-controls .chart-legend button").first()).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator(".topbar-menu-toggle").click();
  expect((await page.locator(".topbar-functions").boundingBox()).width).toBeLessThanOrEqual(144);
  await page.keyboard.press("Escape");
  await page.locator(".prototype-downloads-toggle").click();
  expect((await page.locator("#prototype-downloads-panel").boundingBox()).width).toBeLessThanOrEqual(184);
  await expect(page.locator("#prototype-downloads-panel button")).toHaveCount(5);
  expect(await page.locator(".comparison-table tbody tr:first-child th").evaluate(cell => cell.getBoundingClientRect().width)).toBe(96);
  expect(browserErrors).toEqual([]);
});
