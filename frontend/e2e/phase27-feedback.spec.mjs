import { openSaved, selectHeaderLocale } from "./helpers/runtime.mjs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function savedRun(page) {
  const accepted = await page.request.post("/api/v1/runs", { headers: { "Idempotency-Key": `feedback-${Date.now()}` }, data: {
    draft: { shared: { run: { symbol: "QQQ", startDate: "2024-02-01", endDate: "2024-03-01" }, contribution: { amount: 100, day: 1 } },
      strategies: [{ id: "strategy-vix_dca-1", presetId: "vix_dca", params: {} }] }, scope: "all_enabled",
  } });
  expect(accepted.status()).toBe(202);
  const { runId } = await accepted.json();
  let saved;
  await expect.poll(async () => { saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json(); return saved.status; }).toBe("completed");
  return saved;
}

async function selectVix(page) {
  const control = page.locator(".comparison-table").getByRole("button", { name: /ボラティリティ積立/ });
  if (await control.getAttribute("aria-pressed") === "false") await control.click();
}

test("buy and sell markers use distinct fills and borders with narrow isosceles geometry", async ({ page }) => {
  const saved = await savedRun(page);
  const strategy = saved.result.strategyRuns[0];
  strategy.trades = strategy.dailyAssets.slice(0, 2).map((asset, index) => ({
    date: asset.date, side: index ? "sell" : "buy", reason: index ? "signal_sell" : "signal_buy",
    quantity: "1", price: asset.simulationPrice, cashAmount: asset.simulationPrice, currency: "USD", signalId: "feedback.trade",
  }));
  await openSaved(page, saved);
  await expect(page.locator(".chart-trade-marker")).toHaveCount(0);
  await selectVix(page);
  await expect(page.locator(".chart-trade-marker")).toHaveCount(2);
  const legend = page.locator(`.chart-series-control[data-result-id="${strategy.id}"]`);
  await legend.hover();
  const read = selector => page.locator(selector).evaluate(node => ({
    fill: getComputedStyle(node).fill, stroke: getComputedStyle(node).stroke,
    points: [...node.points].map(point => ({ x: point.x, y: point.y })),
  }));
  const buy = await read(".chart-trade-marker-buy");
  const sell = await read(".chart-trade-marker-sell");
  expect(buy.fill).not.toBe(sell.fill);
  expect(buy.stroke).not.toBe(sell.stroke);
  for (const marker of [buy, sell]) {
    const [tip, left, right] = marker.points;
    expect(left.y).toBe(right.y);
    expect((left.x + right.x) / 2).toBeCloseTo(tip.x);
    expect(Math.abs(tip.y - left.y)).toBeGreaterThan((right.x - left.x) * 1.5);
  }
  expect(buy.points[0].y).toBeGreaterThan(buy.points[1].y);
  expect(sell.points[0].y).toBeLessThan(sell.points[1].y);
  // Edge trades must retain their full triangle, including the half outside the plot.
  expect(await page.locator(".chart-trade-marker").evaluateAll(markers =>
    markers.every(marker => marker.closest("[clip-path]") === null))).toBe(true);
  await legend.focus();
  await page.locator(".chart-overlay").screenshot({ path: test.info().outputPath("buy-sell-markers.png") });
  await expect(page.locator(".chart-trade-marker")).toHaveCount(2);
  await page.mouse.move(0, 0);
  await legend.blur();
  await expect(page.locator(".chart-trade-marker")).toHaveCount(2);
  await legend.focus();
  await expect(page.locator(".chart-trade-marker")).toHaveCount(2);
  await page.getByRole("button", { name: "期間を拡大", exact: true }).click();
  await legend.focus();
  const range = await page.locator(".chart-overlay").evaluate(node => ({ start: Number(node.dataset.windowStart), end: Number(node.dataset.windowEnd) }));
  const expectedDates = strategy.trades.filter(trade => {
    const index = strategy.dailyAssets.findIndex(asset => asset.date === trade.date);
    const fraction = index / (strategy.dailyAssets.length - 1);
    return fraction >= range.start && fraction <= range.end;
  }).map(trade => trade.date);
  const visibleMarkers = page.locator(".chart-trade-marker");
  await expect(visibleMarkers).toHaveCount(expectedDates.length);
  for (const date of expectedDates) await expect(visibleMarkers.locator("title").filter({ hasText: date })).toHaveCount(1);
  for (const x of await visibleMarkers.evaluateAll(markers => markers.map(marker => marker.points[0].x))) {
    expect(x).toBeGreaterThanOrEqual(92);
    expect(x).toBeLessThanOrEqual(774);
  }
  await page.locator(".comparison-table").getByRole("button", { name: "ボラティリティ積立", exact: true }).click();
  await expect(page.locator(".chart-trade-marker")).toHaveCount(0);
});

test("saved results begin unselected and trade details visibly identify the independent focus", async ({ page }) => {
  const saved = await savedRun(page);
  await openSaved(page, saved);
  const selected = page.locator('.comparison-table .result-select[aria-pressed="true"]');
  await expect(selected).toHaveCount(0);
  await expect(page.locator(".comparison-table tbody tr.is-focused")).toHaveCount(0);
  await expect(page.locator(".comparison-table .is-selected")).toHaveCount(0);
  await expect(page.locator(".result-snapshot-info, .result-saved-context")).toHaveCount(0);
  for (const name of ["ボラティリティ積立", "毎月定額積立", "一括投資"]) {
    const row = page.locator(".comparison-table").getByRole("button", { name, exact: true });
    await row.click();
    await page.getByRole("tab", { name: "詳細", exact: true }).click();
    await expect(page.locator(".result-detail-name")).toHaveText(name);
  }
  await expect(selected).toHaveCount(3);
  await page.locator(".comparison-table").getByRole("button", { name: "毎月定額積立", exact: true }).click();
  await page.getByRole("tab", { name: "詳細", exact: true }).click();
  await expect(page.locator(".result-detail-name")).toHaveText("毎月定額積立");
  await selectHeaderLocale(page, "zh");
  await expect(page.locator(".result-detail-name")).toHaveText("每月定额定投");
  await page.reload();
  await expect(page.locator('.comparison-table .result-select[aria-pressed="true"]')).toHaveCount(0);
});

test("wheel over permanent chart readings scrolls results in either zoom mode and chains after overflow", async ({ page }) => {
  const saved = await savedRun(page);
  await openSaved(page, saved);
  await page.setViewportSize({ width: 1440, height: 600 });
  await selectVix(page);
  const readout = page.locator(".chart-core-readout-row");
  const results = page.locator(".workbench-results");
  for (const zoom of [false, true]) {
    if (zoom) await page.locator(".chart-wheel-zoom-toggle").click();
    await readout.hover();
    const before = await results.evaluate(node => node.scrollTop);
    const range = await page.locator(".chart-overlay").getAttribute("data-window-start");
    await page.mouse.wheel(0, 140);
    await expect.poll(() => results.evaluate(node => node.scrollTop)).toBeGreaterThan(before);
    await expect(page.locator(".chart-overlay")).toHaveAttribute("data-window-start", range);
    await readout.evaluate(node => {
      const row = node.firstElementChild;
      for (let index = 0; index < 10; index++) row.appendChild(row.firstElementChild.cloneNode(true));
      node.scrollTop = node.scrollHeight;
    });
    await readout.hover();
    await readout.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const edge = await results.evaluate(node => node.scrollTop);
    await page.mouse.wheel(0, 140);
    await expect.poll(() => results.evaluate(node => node.scrollTop)).toBeGreaterThan(edge);
  }
});

test("native dialogs prevent background scrolling and overscroll while their own content remains scrollable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 480 });
  await page.goto("/");
  await page.locator(".add-strategy-button").click();
  await page.locator('[data-preset-id="grid_search"]').click();
  for (const opener of [".strategy-card-open", ".shared-settings-open-button"]) {
    await page.locator(opener).last().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const content = dialog.locator(".dialog-fields");
    await expect(page.locator("html")).toHaveCSS("overscroll-behavior-y", "none");
    await expect(page.locator("body")).toHaveCSS("overflow-y", "hidden");
    await expect(content).toHaveCSS("overscroll-behavior-y", "none");
    const previous = await page.evaluate(() => ({ page: window.scrollY, results: document.querySelector(".workbench-results").scrollTop }));
    await content.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => content.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    for (const atEnd of [true, false]) {
      await content.evaluate((node, end) => { node.scrollTop = end ? node.scrollHeight : 0; }, atEnd);
      await page.mouse.wheel(0, atEnd ? 300 : -300);
      expect(await page.evaluate(() => ({ page: window.scrollY, results: document.querySelector(".workbench-results").scrollTop }))).toEqual(previous);
    }
    await page.mouse.move(5, 100);
    await page.mouse.wheel(0, 300);
    expect(await page.evaluate(() => ({ page: window.scrollY, results: document.querySelector(".workbench-results").scrollTop }))).toEqual(previous);
    await dialog.locator(".dialog-done").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("html")).not.toHaveCSS("overscroll-behavior-y", "none");
  }
});

test("touch dialog swipes remain inside the modal at both content edges", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 600 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.locator(".workbench-mobile-view").first().tap();
    await expect(page.locator(".workbench-config")).toBeVisible();
    await page.locator(".add-strategy-button").tap();
    await page.locator('[data-preset-id="grid_search"]').tap();
    await page.locator(".strategy-card-open").last().tap();
    const dialog = page.locator(".strategy-dialog");
    const content = dialog.locator(".dialog-fields");
    await expect(dialog).toBeVisible();
    await expect(page.locator("body")).toHaveCSS("overscroll-behavior-y", "none");
    const session = await context.newCDPSession(page);
    const position = () => page.evaluate(() => ({ page: window.scrollY, results: document.querySelector(".workbench-results").scrollTop }));
    const before = await position();
    for (const end of [false, true]) {
      await content.evaluate((node, atEnd) => { node.scrollTop = atEnd ? node.scrollHeight : 0; }, end);
      const bounds = await content.boundingBox();
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let offset = 10; offset <= 70; offset += 10) {
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (end ? -offset : offset) }] });
      }
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      expect(await position()).toEqual(before);
      await expect(dialog).toBeVisible();
    }
    await dialog.locator(".dialog-done").tap();
    await expect(dialog).toBeHidden();
    await expect(page.locator("body")).not.toHaveCSS("overscroll-behavior-y", "none");
  } finally {
    await context.close();
  }
});

test("all strategy dialogs keep three ordered blocks with applicable limits across locales and viewports", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const presets = ["vix_dca", "ma_trend", "ma_buy_only", "rsi_dca", "ma_deviation_dca", "bollinger_dca", "rate_dca",  "composite_dca", "grid_search"];
  for (const preset of presets.slice(1)) {
    await page.locator(".add-strategy-button").click();
    await page.locator(`.strategy-add-option[data-preset-id="${preset}"]`).click();
  }
  for (const locale of ["日本語", "中文"]) {
    await selectHeaderLocale(page, locale === "日本語" ? "ja" : locale === "中文" ? "zh" : "en");
    for (const [index, preset] of presets.entries()) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.locator(".workbench-config")).toBeVisible();
      await page.locator(".strategy-card-open").nth(index).click();
      const dialog = page.locator(".strategy-dialog");
      const blocks = dialog.locator(".strategy-editor > .strategy-parameters > .strategy-parameter-groups > section, .strategy-rule-sections > section");
      await expect(blocks).toHaveCount(3);
      const coordinates = await blocks.evaluateAll(nodes => nodes.map(node => node.offsetTop));
      expect(coordinates[0]).toBeLessThan(coordinates[1]);
      expect(coordinates[1]).toBeLessThan(coordinates[2]);
      await expect(dialog.locator('[data-rule-side="sell"]')).toBeVisible();
      if (["ma_trend", "ma_buy_only"].includes(preset)) {
        await expect(dialog.locator('input[data-parameter-key="accumulation.maxSignalBuysPerMonth"]')).toHaveAttribute("placeholder", locale === "日本語" ? "制限なし" : "不限次数");
        await expect(dialog.locator('[data-parameter-key="accumulation.cashSafetyLimit"]')).toHaveCount(0);
      }
      if (preset === "ma_buy_only") {
        await expect(blocks.last()).toContainText(locale === "日本語" ? "売却なし" : "不卖出");
        await expect(blocks.last().locator('[role="switch"], input, select')).toHaveCount(0);
      }
      if (["ma_buy_only", "composite_dca", "grid_search"].includes(preset)) {
        for (const width of [1920, 1024, 768, 320]) {
          await page.setViewportSize({ width, height: 740 });
          const bounds = await dialog.boundingBox();
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
          await expect(dialog.locator(".dialog-done")).toBeInViewport();
        }
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
        expect(axe.violations).toEqual([]);
        await page.screenshot({ path: test.info().outputPath(`${preset}-${locale}-dialog.png`) });
      }
      await dialog.locator(".dialog-done").click();
      await expect(dialog).toBeHidden();
    }
  }
  expect(errors).toEqual([]);
});
