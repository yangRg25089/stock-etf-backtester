import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function runWithIndicators(page, strategies) {
  const accepted = await page.request.post("/api/v1/runs", { headers: { "Idempotency-Key": `technical-${Date.now()}` }, data: {
    draft: { shared: { run: { symbol: "QQQ", startDate: "2024-02-01", endDate: "2024-03-01" }, contribution: { amount: 100, day: 1 } }, strategies }, scope: "all_enabled",
  } });
  expect(accepted.status()).toBe(202);
  const { runId } = await accepted.json();
  let saved;
  await expect.poll(async () => {
    const response = await page.request.get(`/api/v1/runs/${runId}`);
    expect(response.ok()).toBe(true);
    saved = await response.json();
    return saved.status;
  }).toBe("completed");
  for (const result of saved.result.strategyRuns) expect(result.status, JSON.stringify(result.diagnostics)).toBe("completed");
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: saved }));
  return saved;
}

test("selected saved MA, Bollinger and RSI show periods, exact readings, common price baseline and linked windows", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const saved = await runWithIndicators(page, [
    { id: "ma", presetId: "ma_trend", params: { "ma.period": 2 } },
    { id: "band", presetId: "bollinger_dca", params: { "bollinger.period": 2 } },
    { id: "strength", presetId: "rsi_dca", params: { "rsi.period": 2 } },
    { id: "same-ma", presetId: "ma_buy_only", params: { "ma.period": 2 } },
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const comparison = page.locator("#result-panel-comparison");
  await comparison.getByRole("button", { name: /移動平均トレンド（売買）/ }).click();
  const core = page.locator(".chart-overlay");
  await expect(core.locator('polyline[data-kind="ma"]')).toHaveCount(1);
  const baseline = saved.result.strategyRuns[0].dailyAssets[0].simulationPrice;
  await expect(core.locator('polyline[data-kind="ma"]')).toHaveAttribute("data-baseline", baseline);
  await comparison.getByRole("button", { name: /ボリンジャー積立/ }).click();
  await comparison.getByRole("button", { name: /RSI シグナル積立/ }).click();
  await comparison.getByRole("button", { name: /移動平均トレンド（買付のみ）/ }).click();
  await expect(core.locator('polyline[data-kind="ma"]')).toHaveCount(1);
  await expect(core.locator('polyline[data-kind="bollinger"]')).toHaveCount(3);
  await expect(page.locator(".chart-rsi.is-compact")).toHaveCount(1);
  const maLegend = core.locator(".overlay-legend-item").filter({ hasText: /^MA2$/ });
  const maIdentity = await maLegend.getAttribute("data-series");
  await maLegend.click();
  await comparison.getByRole("button", { name: /移動平均トレンド（売買）/ }).click();
  await expect(maLegend).toHaveAttribute("data-series", maIdentity);
  await expect(maLegend).toHaveAttribute("aria-pressed", "true");
  await expect(core.locator('polyline[data-kind="ma"]')).toHaveAttribute("stroke-width", "2.4");
  await expect(core.locator(".chart-core-readout-row")).toContainText("MA2");
  await expect(core.locator(".chart-core-readout-row")).toContainText("BOLL(2, 2σ)");
  await expect(core.locator(".chart-core-readout-row")).toContainText("RSI2");
  await expect(page.locator(".chart-x-axis-title")).toHaveCount(1);
  await page.locator('.legend-toggle[data-series="price"]').click();
  await expect(core.locator(".chart-technical-line")).toHaveCount(0);
  await expect(page.locator('.legend-toggle[data-series="ma"]')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".chart-rsi")).toBeVisible();
  await page.locator('.legend-toggle[data-series="ma"]').click();
  await expect(page.locator('.legend-toggle[data-series="price"]')).toHaveAttribute("aria-pressed", "true");
  await expect(core.locator('polyline[data-kind="ma"]')).toHaveCount(1);
  await page.locator('.legend-toggle[data-series="bollinger"]').click();
  await expect(core.locator('polyline[data-kind="bollinger"]')).toHaveCount(0);
  await page.locator('.legend-toggle[data-series="bollinger"]').click();
  await expect(core.locator('polyline[data-kind="bollinger"]')).toHaveCount(3);
  await page.locator('[aria-label="期間を拡大"]').click();
  const window = await core.getAttribute("data-window-start");
  for (const figure of await page.locator(".chart-linked-stack > figure").all()) await expect(figure).toHaveAttribute("data-window-start", window);
  const svg = core.locator("svg.result-chart");
  await svg.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  const date = await core.locator(".chart-crosshair-readout").getAttribute("data-date");
  const ma = saved.result.strategyRuns[0].technicalIndicators[0].samples.find(sample => sample.date === date);
  await expect(core.locator(".chart-cursor-reading").filter({ hasText: "MA2" })).toContainText(`${Number(ma.value).toFixed(2)} USD`);
  await page.keyboard.press("Escape");
  await comparison.getByRole("button", { name: /ボリンジャー積立/ }).click();
  await expect(core.locator('polyline[data-kind="bollinger"]')).toHaveCount(0);
  await expect(core.locator('polyline[data-kind="ma"]')).toHaveCount(1);
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 740 });
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await core.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("saved-technical-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.locator("#result-panel-comparison").getByRole("button", { name: /布林带定投/ }).click();
  await expect(core.locator('polyline[data-kind="bollinger"]')).toHaveCount(3);
  await page.locator("#result-chart-panel-content").scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("saved-technical-indicators.png") });
});

test("grid candidates show their own saved MA and Bollinger parameters after switching", async ({ page }) => {
  const saved = await runWithIndicators(page, [{ id: "grid", presetId: "grid_search", params: {
    "vix.buyEnabled": false, "ma.buyEnabled": true, "ma.period": 2, "bollinger.buyEnabled": true, "bollinger.period": 2, "rsi.buyEnabled": true, "rsi.period": 2, "search.dimensions": ["rsi.buyThreshold"], "search.values.rsi.buyThreshold": [25, 35],
  } }]);
  await page.goto("/");
  const grid = saved.result.strategyRuns.find(result => result.id === "grid");
  await page.getByRole("tab", { name: "検索結果", exact: true }).click();
  const rows = page.locator(".search-table tbody tr");
  for (const candidate of grid.searchResult.candidates) {
    const button = rows.getByRole("button", { name: String(candidate.sequence), exact: true });
    const response = page.waitForResponse(result => result.ok() && decodeURIComponent(result.url()).includes(`/candidates/${candidate.candidateId}`));
    await button.click();
    const detail = await (await response).json();
    const band = detail.technicalIndicators.find(indicator => indicator.kind === "bollinger");
    await expect(page.locator(".chart-overlay .overlay-legend")).toContainText("MA2");
    await expect(page.locator(".chart-overlay .overlay-legend")).toContainText(`BOLL(2, ${band.deviations}σ)`);
    await expect(page.locator('.chart-overlay polyline[data-kind="ma"]')).toHaveCount(1);
    await expect(page.locator('.chart-overlay polyline[data-kind="bollinger"]')).toHaveCount(3);
  }
});

test("long histories retain all technical lines and responsive interactions without aggregation errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const saved = await runWithIndicators(page, [{ id: "long", presetId: "ma_trend", params: { "ma.period": 2 } }]);
  const result = saved.result.strategyRuns[0];
  // Expand a saved fixture response to stress rendering; this is not a calculation or provider check.
  const history = Array.from({ length: 9000 }, (_, index) => ({ ...result.dailyAssets[0],
    date: new Date(Date.UTC(1990, 0, index + 1)).toISOString().slice(0, 10), simulationPrice: String(100 + index % 20) }));
  result.dailyAssets = history;
  result.trades = [];
  result.signals = [];
  result.technicalIndicators = ["ma", "rsi"].flatMap(kind => Array.from({ length: 18 }, (_, index) => ({ kind, period: index + 2,
    samples: history.map(asset => ({ date: asset.date, value: kind === "rsi" ? "50" : asset.simulationPrice })) })));
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: saved }));
  await page.goto("/");
  await page.locator("#result-panel-comparison").getByRole("button", { name: /移動平均トレンド（売買）/ }).click();
  const core = page.locator(".chart-overlay");
  await expect(core.locator(".chart-technical-line")).toHaveCount(18);
  await expect(page.locator(".chart-rsi .chart-series-line")).toHaveCount(18);
  await expect(core.locator(".chart-core-readout-row")).toContainText("MA19");
  await expect(core.locator(".chart-core-readout-row")).toContainText("RSI19");
  await page.locator('[aria-label="期間を拡大"]').click();
  await expect.poll(async () => Number(await core.getAttribute("data-window-end")) - Number(await core.getAttribute("data-window-start"))).toBeLessThan(1);
  await core.locator("svg.result-chart").focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(core.locator(".chart-crosshair")).toBeVisible();
  await page.locator('.legend-toggle[data-series="price"]').click();
  await expect(core.locator(".chart-technical-line")).toHaveCount(0);
  await page.locator('.legend-toggle[data-series="ma"]').click();
  await expect(core.locator(".chart-technical-line")).toHaveCount(18);
  expect(errors).toEqual([]);
});
