import { installRunFixture, openSaved } from "./helpers/runtime.mjs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function computed(page, extraStrategies = []) {
  const response = await page.request.post("/api/v1/runs", {
    headers: { "Idempotency-Key": `phase30-${test.info().title}-${Date.now()}` },
    data: {
      draft: {
        shared: { run: { symbol: "QQQ", startDate: "2024-01-31", endDate: "2024-03-01" }, contribution: { amount: 100, day: 1 } },
        strategies: [{ id: "volatility", presetId: "vix_dca", params: {} }, ...extraStrategies],
      }, scope: "all_enabled",
    },
  });
  expect(response.status()).toBe(202);
  const { runId } = await response.json();
  let saved;
  await expect.poll(async () => {
    saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
    return saved.status;
  }).toMatch(/^completed/);
  return saved;
}

const selectResult = (page, name) => page.locator(".comparison-table").getByRole("button", { name, exact: true }).click();
const legend = (page, id) => page.locator(`.chart-series-control[data-result-id="${id}"]`);

async function leaveLegend(page) {
  await page.mouse.move(0, 0);
  await page.locator("#result-details-toggle").focus();
}

async function appearance(page) {
  return page.locator(".chart-overlay").evaluate(node => ({
    lines: [...node.querySelectorAll("polyline.is-highlighted")].map(line => ({ points: line.getAttribute("points"), stroke: line.getAttribute("stroke"), width: line.getAttribute("stroke-width") })),
    areas: [...node.querySelectorAll(".chart-highlight-area")].map(area => area.getAttribute("d")),
    markers: [...node.querySelectorAll(".chart-trade-marker")].map(marker => ({ owner: marker.dataset.resultId, points: marker.getAttribute("points"), side: marker.classList.contains("chart-trade-marker-buy") ? "buy" : "sell" })),
  }));
}

test("legend identifies the underlying closing price in both languages", async ({ page }) => {
  await openSaved(page, await computed(page));
  const price = page.locator('.chart-series-control[data-series="price"]');
  await expect(price).toHaveAccessibleName("銘柄の終値 (USD)");
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(price).toHaveAccessibleName("标的收盘价 (USD)");
});

test("legend hover and click use identical curves, fills and trade points with clear pinned styling", async ({ page }) => {
  const saved = await computed(page);
  const primary = saved.result.strategyRuns[0];
  primary.trades = primary.dailyAssets.filter(asset => Number(asset.totalContributed) > 0).slice(0, 2).map((asset, index) => ({
    date: asset.date, side: index ? "sell" : "buy", reason: index ? "signal_sell" : "signal_buy", quantity: "1",
    price: asset.simulationPrice, cashAmount: asset.simulationPrice, currency: "USD", signalId: "vix.buy",
  }));
  await openSaved(page, saved);
  await selectResult(page, "ボラティリティ積立");
  const pinned = legend(page, primary.id);
  await expect(page.locator(".chart-trade-marker")).toHaveCount(0);
  await pinned.hover();
  const hovering = await appearance(page);
  expect(hovering.lines).toHaveLength(1);
  expect(hovering.areas).toHaveLength(1);
  expect(hovering.markers).toHaveLength(2);
  await pinned.click();
  await leaveLegend(page);
  await expect(pinned).toHaveAttribute("aria-pressed", "true");
  expect(await appearance(page)).toEqual(hovering);
  await expect(pinned).toHaveClass(/is-selected/);
  const price = page.locator('.chart-series-control[data-series="price"]');
  await price.hover();
  expect((await appearance(page)).markers).toHaveLength(0);
  await leaveLegend(page);
  expect(await appearance(page)).toEqual(hovering);
  await pinned.click();
  await leaveLegend(page);
  await expect(pinned).toHaveAttribute("aria-pressed", "false");
  await expect(pinned).not.toHaveClass(/is-selected/);
  expect(await appearance(page)).toEqual({ lines: [], areas: [], markers: [] });
  await pinned.focus();
  await page.keyboard.press("Space");
  await leaveLegend(page);
  expect(await appearance(page)).toEqual(hovering);
  await pinned.focus();
  await page.keyboard.press("Enter");
  await leaveLegend(page);
  expect((await appearance(page)).markers).toHaveLength(0);
});

test("legend pin cannot return after its strategy or core series is hidden", async ({ page }) => {
  const saved = await computed(page);
  await openSaved(page, saved);
  await selectResult(page, "ボラティリティ積立");
  const primary = legend(page, saved.result.strategyRuns[0].id);
  await primary.click();
  await leaveLegend(page);
  await selectResult(page, "ボラティリティ積立");
  await expect(primary).toHaveCount(0);
  await selectResult(page, "ボラティリティ積立");
  await expect(primary).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".chart-highlight-area, .chart-trade-marker")).toHaveCount(0);
  const price = page.locator('.chart-series-control[data-series="price"]');
  await price.click();
  await page.locator('.chart-legend button[data-series="price"]').click();
  await expect(price).toHaveCount(0);
  await page.locator('.chart-legend button[data-series="price"]').click();
  await expect(price).toHaveAttribute("aria-pressed", "false");
});

test("permanent readings group market data first and follow the selected comparison ranking", async ({ page }) => {
  const saved = await computed(page, [{ id: "ma", presetId: "ma_trend", params: { "ma.period": 1 } }]);
  await openSaved(page, saved);
  for (const name of ["毎月定額積立", "ボラティリティ積立", "一括投資", "移動平均トレンド（売買）"]) await selectResult(page, name);
  const market = page.locator(".chart-market-readout");
  const strategyRows = page.locator(".chart-strategy-readout");
  await expect(market).toHaveCount(1);
  await expect(market).toContainText("銘柄の終値");
  await expect(market).toContainText("ドローダウン");
  await expect(market).toContainText("VIX");
  await expect(strategyRows).toHaveCount(4);
  const expectOrder = async () => {
    const expected = await page.locator('.comparison-table tbody .result-select[aria-pressed="true"]').allTextContents();
    expect(await strategyRows.locator(".chart-strategy-name").allTextContents()).toEqual(expected);
    const ids = await strategyRows.evaluateAll(rows => rows.map(row => row.dataset.resultId));
    for (let index = 0; index < ids.length; index++) {
      const result = saved.result.strategyRuns.find(result => result.id === ids[index]);
      const amount = result.dailyAssets.at(-1).totalAsset;
      expect(await strategyRows.nth(index).innerText()).toContain(Number(amount).toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    }
  };
  await expectOrder();
  for (const column of ["戦略", "期末資産", "投入額に対する利益率"]) {
    await page.locator(".comparison-sort").filter({ hasText: column }).click();
    await expectOrder();
  }
  const beforeHeight = await page.locator(".chart-core-readout-row").evaluate(node => node.clientHeight);
  await page.locator(".chart-overlay .result-chart").focus();
  await page.keyboard.press("Shift+ArrowLeft");
  const dates = await page.locator(".chart-market-readout, .chart-strategy-readout").evaluateAll(rows => rows.map(row => row.dataset.date));
  expect(new Set(dates).size).toBe(1);
  expect(dates).toHaveLength(5);
  expect(await page.locator(".chart-core-readout-row").evaluate(node => node.clientHeight)).toBe(beforeHeight);
  await selectResult(page, "毎月定額積立");
  await expect(strategyRows).toHaveCount(3);
  await expect(market).not.toContainText("毎月定額積立");
  await page.locator(".chart-overlay").screenshot({ path: test.info().outputPath("ranked-readings.png") });
});

test("comparison and trade tables expand all rows vertically and retain their widths", async ({ page }) => {
  const extra = Array.from({ length: 10 }, (_, index) => ({ id: `custom-${index}`, presetId: "composite_dca", params: {} }));
  const saved = await computed(page, extra);
  const primary = saved.result.strategyRuns[0];
  primary.trades = Array.from({ length: 80 }, (_, index) => ({ ...saved.result.strategyRuns.find(result => result.presetId === "monthly_dca").trades[0], date: primary.dailyAssets[index % primary.dailyAssets.length].date }));
  await openSaved(page, saved);
  let runRequests = 0;
  page.on("request", request => { if (request.url().includes("/api/v1/runs")) runRequests++; });
  const comparison = page.locator(".comparison-table-scroll");
  const check = async (container, table, name) => {
    const expand = container.getByRole("button", { name: `${name}を全行表示`, exact: true });
    const before = await container.boundingBox();
    const total = await table.evaluate(node => node.getBoundingClientRect().height);
    expect(before.height).toBeLessThan(total);
    await expand.click();
    const restore = container.getByRole("button", { name: `${name}の高さを戻す`, exact: true });
    await expect(restore).toHaveAttribute("aria-expanded", "true");
    await expect.poll(async () => (await container.boundingBox()).height).toBeGreaterThanOrEqual(total);
    expect((await container.boundingBox()).width).toBeCloseTo(before.width, 1);
    expect(await container.evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(2);
    await restore.press("Enter");
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    expect((await container.boundingBox()).height).toBeCloseTo(before.height, 1);
    const buttonBox = await expand.boundingBox();
    const parentBox = await container.boundingBox();
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(parentBox.x + parentBox.width);
    expect(buttonBox.y).toBeLessThanOrEqual(parentBox.y + 8);
  };
  await check(comparison, comparison.locator("table"), "戦略比較");
  await page.getByRole("tab", { name: "取引明細", exact: true }).click();
  const trades = page.locator(".trade-table-scroll");
  await check(trades, trades.locator("table"), "取引明細");
  expect(runRequests).toBe(0);
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(trades.getByRole("button", { name: "展开全部交易明细", exact: true })).toBeVisible();
});

test("blue and orange theme keeps selected controls and text accessible at all layout sizes", async ({ page }) => {
  await openSaved(page, await computed(page));
  await selectResult(page, "ボラティリティ積立");
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ["--app-foreground", "--app-accent", "--app-focus", "--app-action"].map(token => style.getPropertyValue(token).trim().toLowerCase());
  });
  expect(tokens).toEqual(["#253c6d", "#30497d", "#455b8a", "#f2842f"]);
  for (const width of [1920, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 1080 });
    if (width === 320) await page.locator(".workbench-mobile-view").last().click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(report.violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`blue-orange-${width}.png`), fullPage: true });
  }
});

test("touch legend selection and release never leave a synthetic hover behind", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 375, height: 900 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    const saved = await computed(page);
    await installRunFixture(page, saved);
    await page.goto("/");
    await page.locator(".comparison-table").getByRole("button", { name: "ボラティリティ積立", exact: true }).tap();
    const control = legend(page, saved.result.strategyRuns[0].id);
    await control.tap();
    await expect(control).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".chart-highlight-area")).toHaveCount(1);
    await control.tap();
    await expect(control).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".chart-highlight-area, .chart-trade-marker")).toHaveCount(0);
    await control.tap();
    await expect(control).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".chart-highlight-area")).toHaveCount(1);
    const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(report.violations).toEqual([]);
  } finally { await context.close(); }
});

test("table height controls stay visible through horizontal scroll and saved-run replacement resets preferences", async ({ page }) => {
  const saved = await computed(page);
  const replacement = structuredClone(saved);
  replacement.runId = replacement.snapshot.runId = replacement.result.runId = "phase30-replacement";
  await installRunFixture(page, saved);
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/");
  const comparison = page.locator(".comparison-table-scroll");
  const toggle = comparison.locator(".table-expand-button");
  for (const scroll of [0, 300, 10000]) {
    await comparison.evaluate((node, left) => { node.scrollLeft = left; }, scroll);
    const control = await toggle.boundingBox();
    const region = await comparison.boundingBox();
    expect(control.x).toBeGreaterThanOrEqual(region.x);
    expect(control.x + control.width).toBeLessThanOrEqual(region.x + region.width);
  }
  await comparison.evaluate(node => { node.scrollLeft = 0; });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await selectResult(page, "ボラティリティ積立");
  await legend(page, saved.result.strategyRuns[0].id).click();
  await page.locator(".comparison-sort").first().click();
  await installRunFixture(page, replacement);
  await page.reload();
  await expect(page.locator('.comparison-table .result-select[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator(".comparison-table-scroll .table-expand-button")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".comparison-table th[aria-sort]")).toContainText("投入額に対する利益率");
  await expect(page.locator('.chart-series-control[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator(".chart-highlight-area, .chart-trade-marker, .chart-strategy-readout")).toHaveCount(0);
});
