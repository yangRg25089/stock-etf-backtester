import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { installRunFixture } from "./helpers/runtime.mjs";

async function savedRun(page, extraStrategies = []) {
  const accepted = await page.request.post("/api/v1/runs", {
    headers: { "Idempotency-Key": `readout-${test.info().title}-${Date.now()}` },
    data: { draft: {
      shared: { run: { symbol: "QQQ", startDate: "2024-01-31", endDate: "2024-03-01" }, contribution: { amount: 100, day: 1 } },
      strategies: [{ id: "volatility", presetId: "vix_dca", params: {} }, ...extraStrategies],
    }, scope: "all_enabled" },
  });
  expect(accepted.status()).toBe(202);
  const { runId } = await accepted.json();
  let saved;
  await expect.poll(async () => {
    saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
    return saved.status;
  }).toBe("completed");
  return saved;
}

async function openRun(page, saved) {
  await installRunFixture(page, saved);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(saved.result.strategyRuns.length);
}

test("the persistent readout replaces the caption and owns hover, pin, release and trade identity", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const saved = await savedRun(page);
  const primary = saved.result.strategyRuns[0];
  primary.trades = primary.dailyAssets.filter(asset => Number(asset.totalContributed) > 0).slice(0, 2).map((asset, index) => ({
    date: asset.date, side: index ? "sell" : "buy", reason: index ? "signal_sell" : "signal_buy", quantity: "1",
    price: asset.simulationPrice, cashAmount: asset.simulationPrice, currency: "USD", signalId: "vix.buy",
  }));
  await openRun(page, saved);
  await page.locator(".comparison-table").getByRole("button", { name: "ボラティリティ積立", exact: true }).click();
  const core = page.locator(".chart-overlay");
  const readout = core.locator(".chart-core-readout-row");
  await expect(core.locator("figcaption")).toHaveCount(0);
  await expect(core.locator(".overlay-legend, .overlay-legend-item")).toHaveCount(0);
  const price = readout.getByRole("button", { name: "銘柄の終値 (USD)", exact: true });
  await expect(price).toContainText("USD");
  const strategy = readout.getByRole("button", { name: "ボラティリティ積立", exact: true });
  await expect(strategy).toContainText("元本");
  await expect(strategy).toHaveAttribute("aria-pressed", "true");
  await expect(core.locator(".chart-trade-marker")).toHaveCount(2);
  await strategy.hover();
  const appearance = () => core.evaluate(node => ({
    lines: [...node.querySelectorAll("polyline.is-highlighted")].map(line => line.getAttribute("points")),
    areas: [...node.querySelectorAll(".chart-highlight-area")].map(area => area.getAttribute("d")),
    markers: [...node.querySelectorAll(".chart-trade-marker")].map(marker => ({ owner: marker.dataset.resultId, points: marker.getAttribute("points") })),
  }));
  const hovering = await appearance();
  expect(hovering.markers).toHaveLength(2);
  expect(hovering.markers.every(marker => marker.owner === primary.id)).toBe(true);
  await strategy.click();
  await page.mouse.move(0, 0);
  await page.locator("#result-details-toggle").focus();
  await expect(strategy).toHaveAttribute("aria-pressed", "false");
  await expect(strategy).not.toHaveClass(/is-selected/);
  await expect(core.locator(".chart-trade-marker, .chart-highlight-area")).toHaveCount(0);
  await price.click();
  await page.mouse.move(0, 0);
  await page.locator("#result-details-toggle").focus();
  await expect(price).toHaveAttribute("aria-pressed", "true");
  await expect(strategy).toHaveAttribute("aria-pressed", "false");
  await expect(core.locator(".chart-trade-marker")).toHaveCount(0);
  await price.click();
  await page.mouse.move(0, 0);
  await page.locator("#result-details-toggle").focus();
  await expect(core.locator(".chart-highlight-area")).toHaveCount(0);
  await strategy.focus();
  await page.keyboard.press("Space");
  await page.locator("#result-details-toggle").focus();
  await expect(strategy).toHaveAttribute("aria-pressed", "true");
  expect(await appearance()).toEqual(hovering);
  await page.locator(".locale-select").selectOption("zh");
  await expect(readout.getByRole("button", { name: "标的收盘价 (USD)", exact: true })).toBeVisible();
  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 320) await page.locator(".workbench-mobile-view").last().click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 1080 });
  await core.scrollIntoViewIfNeeded();
  await core.screenshot({ path: test.info().outputPath("integrated-readout.png") });
  expect(errors).toEqual([]);
});

test("comparison and trade tables pass vertical scrolling to the results area only at their boundaries", async ({ page }) => {
  const saved = await savedRun(page, [
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `custom-${index}`, presetId: "composite_dca", params: {},
      rules: { buy: { type: "condition", id: `custom-vix-${index}`, kind: "vix", params: { "vix.symbol": "^VIX", "vix.buyThreshold": 25 } }, sell: null },
    })),
    ...Array.from({ length: 4 }, (_, index) => ({ id: `volatility-copy-${index}`, presetId: "vix_dca", params: {} })),
  ]);
  const primary = saved.result.strategyRuns[0];
  primary.trades = Array.from({ length: 80 }, (_, index) => ({
    date: primary.dailyAssets[index % primary.dailyAssets.length].date, side: "buy", reason: "signal_buy", quantity: "1",
    price: "100", cashAmount: "100", currency: "USD", signalId: "vix.buy",
  }));
  await openRun(page, saved);
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(12);
  await expect(page.locator(".result-interactions")).not.toBeDisabled();
  const results = page.locator(".workbench-results");
  const outerTop = () => results.evaluate(node => node.scrollTop);
  const checkScroll = async selector => {
    const table = page.locator(selector);
    await table.scrollIntoViewIfNeeded();
    // The last details card can already be at the parent's lower boundary.
    await results.evaluate(node => { node.scrollTop = Math.max(0, node.scrollTop - 140); });
    expect(await results.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeGreaterThanOrEqual(140);
    await table.evaluate(node => { node.scrollTop = 0; });
    const pointAtTable = async () => {
      const box = await table.boundingBox();
      const viewport = await results.boundingBox();
      const point = { x: box.x + 140, y: Math.min(Math.max(box.y + 100, viewport.y + 10), viewport.y + viewport.height - 10) };
      await page.mouse.move(point.x, point.y);
      expect(await table.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), point)).toBe(true);
    };
    await pointAtTable();
    const before = await outerTop();
    await page.mouse.wheel(0, 120);
    await expect.poll(() => table.evaluate(node => node.scrollTop)).toBeGreaterThanOrEqual(119);
    expect(await outerTop()).toBe(before);
    await table.evaluate(node => {
      // Let the browser clamp to its true endpoint, including fractional row sizes.
      node.scrollTop = node.scrollHeight;
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect.poll(() => table.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(1);
    expect(await outerTop()).toBe(before);
    await pointAtTable();
    await page.mouse.wheel(0, 140);
    await expect.poll(outerTop).toBeGreaterThan(before);
    // Keep the pointer on the same table after its parent has moved.
    await table.evaluate(node => { node.scrollTop = 0; });
    await pointAtTable();
    const atTop = await outerTop();
    expect(atTop).toBeGreaterThan(0);
    await page.mouse.wheel(0, -140);
    await expect.poll(outerTop).toBeLessThan(atTop);
    expect(await table.locator("thead, thead th").evaluateAll(nodes => nodes.some(node => getComputedStyle(node).position === "sticky"))).toBe(true);
  };
  await checkScroll(".comparison-table-scroll");
  await expect(page.locator("#result-panel-performance")).toBeVisible();
  await checkScroll(".trade-table-scroll");
  await page.locator(".trade-table-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; });
  await results.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const tradeBox = await page.locator(".trade-table-scroll").boundingBox();
  await page.mouse.move(tradeBox.x + 140, tradeBox.y + 100);
  const end = await outerTop();
  const pageTop = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 140);
  await expect.poll(outerTop).toBe(end);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageTop);
});
