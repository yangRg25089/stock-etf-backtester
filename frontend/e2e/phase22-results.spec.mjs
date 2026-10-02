import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function computed(page, strategies = [{ id: "strategy-vix_dca-1", presetId: "vix_dca", params: {} }]) {
  const accepted = await page.request.post("/api/v1/runs", { headers: { "Idempotency-Key": `phase22-${Date.now()}` }, data: {
    draft: { shared: { run: { symbol: "QQQ", startDate: "2024-01-31", endDate: "2024-03-01" }, contribution: { amount: 100, day: 1 } }, strategies }, scope: "all_enabled",
  } });
  expect(accepted.status()).toBe(202);
  const { runId } = await accepted.json();
  let saved;
  await expect.poll(async () => { saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json(); return saved.status; }).toMatch(/^completed/);
  return saved;
}
async function openSaved(page, saved) {
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: saved }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".chart-overlay")).toBeVisible();
  await page.locator(".comparison-table").getByRole("button", { name: /ボラティリティ積立/ }).click();
}

test("selected volatility survives focus, column sorting preserves colors and asset names", async ({ page }) => {
  const saved = await computed(page, [{ id:"strategy-vix_dca-1", presetId:"vix_dca", params:{} }, { id:"ma", presetId:"ma_trend", params:{"ma.period":1} }]);
  await openSaved(page, saved);
  const row = name => page.locator(".comparison-table tbody tr").filter({ hasText:name });
  const vix = row("ボラティリティ積立");
  const ma = row("移動平均トレンド");
  const originalPoints = await page.locator(".chart-vix .chart-vix-line").getAttribute("points");
  await ma.locator(".result-select").click();
  await expect(vix.locator(".result-select")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".chart-vix .chart-vix-line")).toHaveAttribute("points", originalPoints);
  await expect(page.locator(".overlay-legend")).toContainText("ボラティリティ積立");
  await expect(page.locator(".overlay-legend")).toContainText("移動平均トレンド");
  await expect(page.locator(".overlay-legend")).not.toContainText("総資産");
  const color = await ma.evaluate(node => node.style.getPropertyValue("--result-color"));
  await expect(page.locator("polyline.overlay-totalAsset")).toHaveAttribute("stroke", color);
  const headers = page.locator(".comparison-table thead th");
  for (let index=0; index<9; index++) {
    await headers.nth(index).locator("button").click();
    await expect(headers.nth(index)).toHaveAttribute("aria-sort", /ascending|descending/);
    const firstDirection = await headers.nth(index).getAttribute("aria-sort");
    await headers.nth(index).locator("button").press("Enter");
    await expect(headers.nth(index)).toHaveAttribute("aria-sort", firstDirection === "ascending" ? "descending" : "ascending");
    await expect(page.locator(".comparison-table th[aria-sort]")).toHaveCount(1);
    expect(await ma.evaluate(node => node.style.getPropertyValue("--result-color"))).toBe(color);
  }
  await vix.locator(".result-select").click();
  await expect(page.locator(".chart-vix")).toHaveCount(0);
  await vix.locator(".result-select").click();
  await expect(page.locator(".chart-vix .chart-vix-line")).toHaveAttribute("points", originalPoints);
  const axes = await page.locator(".chart-overlay .chart-y-tick").first().evaluate(node => node.getBoundingClientRect().height);
  expect(axes).toBeGreaterThan(9);
  expect(axes).toBeLessThan(16);
  const report = await new AxeBuilder({ page }).withTags(["wcag2a","wcag2aa","wcag21aa"]).analyze();
  expect(report.violations).toEqual([]);
  await page.screenshot({ path:test.info().outputPath("multi-result-sorted.png"), fullPage:true });
});

test("all timing dialogs expose buy limits first and selected cards retain hover styling", async ({ page }) => {
  await page.setViewportSize({ width:1440, height:900 });
  await page.goto("/");
  const presets = ["ma_trend","ma_buy_only","rsi_dca","ma_deviation_dca","bollinger_dca","rate_dca","pe_dca","composite_dca","grid_search"];
  for (const preset of presets) {
    await page.locator(".add-strategy-button").click();
    await page.locator(`.strategy-add-option[data-preset-id="${preset}"]`).click();
    const card = page.locator(".strategy-card-open").last();
    await card.hover();
    const hoverBackground = await card.evaluate(node => getComputedStyle(node).backgroundColor);
    await card.click();
    const dialog = page.locator(".strategy-dialog");
    await expect(dialog.locator(".strategy-parameter-group").first()).toContainText("買付上限");
    await expect(dialog.locator('input[id$="-accumulation-maxSignalBuysPerMonth"]')).toBeVisible();
    await expect(dialog.locator("input:invalid, select:invalid")).toHaveCount(0);
    if (preset.startsWith("ma_") && preset !== "ma_deviation_dca") {
      await expect(dialog.locator('input[id$="-accumulation-cashSafetyLimit"]')).toHaveCount(0);
      await expect(dialog.locator('input[id$="-accumulation-maxSignalBuysPerMonth"]')).toHaveAttribute("placeholder", "制限なし");
    }
    await dialog.locator(".dialog-done").click();
    await expect(dialog).toBeHidden();
    await page.mouse.move(1350,850);
    expect(await card.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(hoverBackground);
    await expect(card.locator("..")).toHaveClass(/is-active/);
  }
  await page.screenshot({ path:test.info().outputPath("all-strategy-buy-limits.png"), fullPage:true });
});

test("fresh runs reset preferences, lock unsafe actions and progressively rank completed rows", async ({ page }) => {
  const saved = await computed(page);
  await openSaved(page, saved);
  const selected = page.locator('.comparison-table .result-select[aria-pressed="true"]');
  await page.locator(".comparison-table tbody tr").filter({ hasText:"毎月定額積立" }).locator(".result-select").click();
  await expect(selected).toHaveCount(2);
  await page.locator('.chart-legend button[data-series="vix"]').click();
  await page.locator(".chart-wheel-zoom-toggle").click();
  await page.locator(".chart-range-controls button").filter({ hasText:"+" }).click();
  await page.locator(".comparison-sort").first().click();
  const pending = structuredClone(saved);
  pending.runId = pending.snapshot.runId = pending.result.runId = "phase22-new-run";
  pending.status = pending.result.status = "running";
  pending.progress = { ...pending.progress, completedStrategies:0, currentStrategyId:null };
  for (const row of pending.result.strategyRuns) { row.status="queued"; row.metrics=null; row.dailyAssets=[]; row.trades=[]; row.signals=[]; }
  const final = structuredClone(saved);
  final.runId = final.snapshot.runId = final.result.runId = pending.runId;
  const init = await page.evaluate(({ runId }) => {
    const originalFetch = window.fetch;
    window.fetch = (input, options) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.includes(`/runs/${runId}/events`)) return originalFetch(input, options);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.phase22Stream = { send(event,data) { controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }, close() { controller.close(); } };
      } }), { headers:{ "Content-Type":"text/event-stream" } }));
    };
    return true;
  }, { runId:pending.runId });
  expect(init).toBe(true);
  await page.route("**/api/v1/runs", route => route.fulfill({ status:202, json:pending }));
  await page.route(`**/api/v1/runs/${pending.runId}`, route => route.fulfill({ json:final }));
  await page.locator(".run-submit-button").click();
  await expect(page.locator(".run-stop-button")).toBeEnabled();
  for (const selector of [".shared-settings-open-button", ".add-strategy-button", ".strategy-card-open", ".comparison-sort", ".comparison-table .result-select"]) {
    for (const control of await page.locator(selector).all()) await expect(control).toBeDisabled();
  }
  await expect(selected).toHaveCount(0);
  await expect(page.locator('.comparison-table th[aria-sort="descending"]')).toContainText("投入額に対する利益率");
  const ids = pending.result.strategyRuns.map(row=>row.id);
  const completedIds = [];
  const send = async (id, profit, completed) => {
    completedIds.push(id);
    const real = saved.result.strategyRuns.find(row=>row.id===id);
    const metrics = { ...real.metrics, returnOnContributions:String(profit) };
    await page.evaluate(({ id, metrics, completed, runId, ids, completedIds }) => window.phase22Stream.send("progress", {
      runId, status:"running", progress:{ completedStrategies:completed,totalStrategies:ids.length,currentStrategyId:id },
      strategyStatuses:Object.fromEntries(ids.map(key=>[key,completedIds.includes(key)?"completed":"queued"])), strategySummaries:{[id]:{ metrics,diagnostics:[] }},
    }), { id, metrics, completed, runId:pending.runId, ids, completedIds });
  };
  await expect.poll(()=>page.evaluate(()=>Boolean(window.phase22Stream))).toBe(true);
  await send(ids[2],0.2,1);
  const expected = saved.result.strategyRuns[2].presetId === "lump_sum" ? "一括投資" : "毎月定額積立";
  await expect(page.locator(".comparison-table tbody tr").first()).toContainText(expected);
  await send(ids[0],0.5,2);
  await expect(page.locator(".comparison-table tbody tr").first()).toContainText("ボラティリティ積立");
  await page.evaluate(({ final }) => { window.phase22Stream.send("terminal", {
    runId:final.runId,status:final.status,progress:final.progress,strategyStatuses:Object.fromEntries(final.result.strategyRuns.map(row=>[row.id,row.status])),
  }); window.phase22Stream.close(); }, { final });
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await expect(selected).toHaveCount(0);
  await page.locator(".comparison-table").getByRole("button", { name: /ボラティリティ積立/ }).click();
  await expect(page.locator('.chart-legend button[data-series="vix"]')).toHaveAttribute("aria-pressed","true");
  await expect(page.locator(".chart-wheel-zoom-toggle")).toHaveAttribute("aria-pressed","false");
  await expect(page.locator(".chart-overlay")).toHaveAttribute("data-window-start","0");
  await expect(page.locator(".chart-overlay")).toHaveAttribute("data-window-end","1");
  await expect(page.locator(".run-controls, .run-status-panel")).toHaveCount(0);
});

test("rank animations only follow layout moves and respect reduced motion", async ({ page }) => {
  const saved = await computed(page);
  await page.addInitScript(() => {
    window.phase22RankAnimations = [];
    const originalAnimate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      if (this.matches(".comparison-table tbody tr")) window.phase22RankAnimations.push(args[0]);
      return originalAnimate.apply(this, args);
    };
  });
  await openSaved(page, saved);
  const counts = await page.evaluate(async () => {
    const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.querySelectorAll(".comparison-sort")[5].click();
    await painted();
    const before = window.phase22RankAnimations.length;
    document.querySelector(".comparison-table .result-select").click();
    await painted();
    return { before, after: window.phase22RankAnimations.length };
  });
  expect(counts.before).toBeGreaterThan(0);
  expect(counts.after).toBe(counts.before);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await page.evaluate(async () => {
    window.phase22RankAnimations = [];
    document.querySelectorAll(".comparison-sort")[5].click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return window.phase22RankAnimations.length;
  });
  expect(reduced).toBe(0);
});
