import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function shared(page) {
  await page.locator(".shared-settings-open-button").click();
  await expect(page.locator(".shared-settings-dialog")).toBeVisible();
}
async function done(page, selector) {
  const dialog = page.locator(selector);
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeHidden();
}
async function add(page, preset) {
  await page.locator(".add-strategy-button").click();
  await page.locator(`.strategy-add-option[data-preset-id="${preset}"]`).click();
}
async function period(page) {
  await shared(page);
  await page.locator("#field-run-startDate").fill("2024-01-31");
  await page.locator("#field-run-endDate").fill("2024-03-01");
  await done(page, ".shared-settings-dialog");
}
async function runSaved(page) {
  const response = page.waitForResponse(r => r.ok() && r.request().method() === "GET" && /\/api\/v1\/runs\/(?!active$)[^/]+$/.test(r.url()));
  await page.locator(".run-submit-button").click();
  return (await response).json();
}

test("today, ETF choices and quote currency stay inside the validated dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  const runBefore = await page.locator(".run-submit-button").evaluate(node => node.outerHTML);
  await page.route("**/api/v1/instruments/7203.T", route => route.fulfill({ json: { symbol: "7203.T", currency: "JPY", diagnostics: [] } }));
  await shared(page);
  const today = await page.evaluate(() => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; });
  await expect(page.locator("#field-run-endDate")).toHaveValue(today);
  await expect(page.getByRole("checkbox", { name: /最新/ })).toHaveCount(0);
  for (const symbol of ["QQQ", "SPY", "VOO", "VTI", "IVV"]) await expect(page.locator(".etf-choice").filter({ hasText: symbol })).toBeVisible();
  await page.locator(".etf-choice").filter({ hasText: "SPY" }).click();
  await expect(page.locator("#field-run-symbol")).toHaveValue("SPY");
  await expect(page.locator(".shared-settings-summary-symbol")).toContainText("QQQ");
  await page.locator("#field-run-symbol").fill("7203.T");
  await expect(page.locator("#field-contribution-amount-unit")).toHaveText("JPY");
  expect(await page.locator(".run-submit-button").evaluate(node => node.outerHTML)).toBe(runBefore);
  await done(page, ".shared-settings-dialog");
  await expect(page.locator(".shared-settings-summary-funding")).toContainText("JPY");
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await page.locator(".strategy-card-open").first().click();
  await expect(page.locator(".strategy-parameter-group").first()).toContainText("買付上限");
  await expect(page.locator('span[id$="-accumulation-cashSafetyLimit-unit"]')).toHaveText("JPY");
  await done(page, ".strategy-dialog");
  await shared(page);
  await page.locator("#field-run-startDate").fill("2030-01-01");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await expect(page.locator(".shared-settings-dialog")).toBeVisible();
  await expect(page.locator(".shared-settings-dialog-footer .diagnostic-list")).toBeVisible();
  expect(await page.locator(".run-submit-button").evaluate(node => node.outerHTML)).toBe(runBefore);
  await page.locator("#field-run-startDate").fill("2020-01-01");
  await done(page, ".shared-settings-dialog");
});

test("strategy ordinals survive deletion, per-type limits combine up to ten user strategies, and duplicate conditions stay blocked", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const heading = await page.locator(".strategy-navigator-heading").boundingBox();
  const plus = await page.locator(".add-strategy-button").boundingBox();
  expect(plus.x + plus.width).toBeCloseTo(heading.x + heading.width, 0);
  await expect(page.locator(".strategy-navigator-heading")).toContainText("戦略一覧");
  await expect(page.locator(".strategy-card [role='switch'], .strategy-card .status-tag")).toHaveCount(0);
  for (let index = 0; index < 5; index++) await add(page, "composite_dca");
  for (let index = 0; index < 4; index++) await add(page, "rsi_dca");
  await expect(page.locator(".strategy-card")).toHaveCount(10);
  await expect(page.locator(".strategy-card-name").nth(1)).toHaveText("カスタム戦略");
  await expect(page.locator(".strategy-card-name").nth(5)).toHaveText("カスタム戦略5");
  await expect(page.locator(".strategy-card-name").last()).toHaveText("RSI シグナル積立4");
  await page.locator(".add-strategy-button").click();
  await expect(page.locator('[data-preset-id="composite_dca"]')).toBeDisabled();
  await expect(page.locator('[data-preset-id="vix_dca"]')).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.locator(".strategy-card").nth(1).hover();
  await page.locator(".strategy-card .strategy-remove").nth(1).click();
  await add(page, "composite_dca");
  await expect(page.locator(".strategy-card-name").nth(1)).toHaveText("カスタム戦略2");
  await expect(page.locator(".strategy-card-name").last()).toHaveText("カスタム戦略6");
  await page.locator(".strategy-card-open").last().click();
  await expect(page.locator("#strategy-editor-heading")).toHaveText("カスタム戦略6");
  const buy = page.locator('[data-rule-side="buy"]');
  await buy.locator(".condition-add-select").first().selectOption("rsi");
  await buy.locator(".condition-add-select").first().selectOption("group");
  const nested = buy.locator(".condition-group:not(.is-root) .condition-add-select");
  for (const kind of ["vix", "rsi"]) await expect(nested.locator(`option[value="${kind}"]`)).toBeDisabled();
  await nested.selectOption("ma_trend");
  await done(page, ".strategy-dialog");
  await expect(page.locator(".strategy-card .status-tag, .strategy-enabled-control")).toHaveCount(0);
});

test("no strategies disables execution with an accessible reason and submits no job", async ({ page }) => {
  await page.route("**/api/v1/runs/active", route => route.fulfill({ json: null }));
  await page.goto("/");
  await page.locator(".strategy-card").hover();
  await page.locator(".strategy-remove").click();
  await expect(page.locator(".strategy-card")).toHaveCount(0);
  const jobs = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/api/v1/runs")) jobs.push(request); });
  await expect(page.locator(".run-submit-button")).toBeDisabled();
  await expect(page.locator(".run-submit-button")).toHaveAttribute("title", /戦略/);
  await expect(page.locator("#run-disabled-reason")).toContainText("戦略");
  await page.keyboard.press("Meta+Enter");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".result-details .field-error")).toHaveCount(0);
  expect(jobs).toEqual([]);
});

test("grid best and non-best candidates display saved curves and export the selected data", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await period(page);
  await add(page, "grid_search");
  await page.locator(".strategy-card-open").last().click();
  const buyCards = page.locator('[data-rule-side="buy"] .condition-card');
  for (const card of await buyCards.all()) {
    if (await card.getAttribute("data-condition-kind") !== "vix") {
      const toggle = card.getByRole("switch");
      if (await toggle.getAttribute("aria-checked") === "true") await toggle.click();
    }
  }
  await done(page, ".strategy-dialog");
  const saved = await runSaved(page);
  const grid = saved.result.strategyRuns.find(row => row.presetId === "grid_search");
  expect(grid.dailyAssets.length).toBeGreaterThan(0);
  await page.locator(".comparison-table tbody tr").filter({ hasText: "グリッド検索" }).click();
  await expect(page.locator(".chart-overlay polyline.overlay-totalAsset")).toBeVisible();
  await page.getByRole("tab", { name: "検索結果", exact: true }).click();
  const candidates = page.locator(".search-table .result-select:not(:disabled)");
  await expect(candidates).toHaveCount(grid.searchResult.rankedCandidateIds.length);
  let recalculations = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/api/v1/runs")) recalculations++; });
  let selected;
  for (const index of [0, grid.searchResult.rankedCandidateIds.length-1]) {
    const response = page.waitForResponse(r => r.ok() && r.url().includes("/candidates/"));
    await candidates.nth(index).click();
    selected = await (await response).json();
    await expect(candidates.nth(index)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".chart-overlay svg")).toBeVisible();
    const curve = page.locator(".chart-overlay polyline.overlay-totalAsset");
    await expect(curve).toHaveAttribute("points", /\d+[.,\d ]+/);
    // A candidate with no purchases has a horizontal 100 line (zero SVG height).
    expect(await curve.evaluate(node => node.getBBox().width)).toBeGreaterThan(0);
    expect(selected.dailyAssets.length).toBe(grid.dailyAssets.length);
    const candidate = grid.searchResult.candidates.find(item => item.candidateId === selected.id);
    await page.getByRole("tab", { name: "取引明細", exact: true }).click();
    await expect(page.locator(".result-detail-name")).toHaveText(`グリッド検索 · #${candidate.sequence}`);
    await page.getByRole("tab", { name: "検索結果", exact: true }).click();
  }
  const downloadPromise = page.waitForEvent("download");
  await page.locator('[data-export-kind="daily-assets"]').click();
  const download = await downloadPromise;
  const csv = await readFile(await download.path(), "utf8");
  expect(csv).toContain(selected.id);
  expect(csv).toContain(selected.dailyAssets.at(-1).totalAsset);
  await expect(page.locator('[data-export-kind="search-results"]')).toBeEnabled();
  expect(recalculations).toBe(0);
  await page.screenshot({ path: test.info().outputPath("grid-candidate-workbench.png") });
  const previousCurve = await page.locator(".chart-overlay polyline.overlay-totalAsset").getAttribute("points");
  await page.route("**/api/v1/runs/*/candidates/*", route => route.fulfill({ status: 404, json: { error: { code: "result_not_found", messageKey: "api.errors.result_not_found", diagnostics: [] } } }));
  await candidates.first().click();
  await expect(page.locator(".search-results .field-error")).toHaveText("保存した結果が見つかりません。再実行してください。");
  await expect(page.locator(".search-results .field-error")).not.toContainText("接続");
  await expect(page.locator(".chart-overlay polyline.overlay-totalAsset")).toHaveAttribute("points", previousCurve);
  await page.unroute("**/api/v1/runs/*/candidates/*");
  await candidates.first().click();
  await expect(candidates.first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".search-results .field-error")).toHaveCount(0);
  expect(recalculations).toBe(0);
});

test("stop action preserves completed rows and presents running and waiting indicators", async ({ page }) => {
  const computed = await page.request.post("/api/v1/runs", { headers: { "Idempotency-Key": `stop-ui-${Date.now()}` }, data: { draft: { shared: { run: { symbol: "QQQ", startDate: "2024-01-31", endDate: "2024-03-01" }, contribution: { amount: 100, day: 1 } }, strategies: [{ id: "strategy-vix_dca-1", presetId: "vix_dca", params: {} }] }, scope: "all_enabled" } });
  expect(computed.status()).toBe(202);
  const accepted = await computed.json();
  let saved;
  await expect.poll(async () => { saved = await (await page.request.get(`/api/v1/runs/${accepted.runId}`)).json(); return saved.status; }).toMatch(/^completed/);
  const pending = structuredClone(saved);
  pending.status = "running";
  pending.result.status = "running";
  pending.progress = { ...pending.progress, completedStrategies: 1, currentStrategyId: "benchmark:lump-sum" };
  for (const row of pending.result.strategyRuns) if (row.id !== "benchmark:monthly-dca") { row.status = row.id === "benchmark:lump-sum" ? "running" : "queued"; row.metrics = null; row.dailyAssets = []; row.trades = []; row.signals = []; }
  const stopped = structuredClone(pending);
  stopped.status = "cancelled";
  stopped.result.status = "cancelled";
  stopped.progress = { ...stopped.progress, completedStrategies: 3, currentStrategyId: null };
  for (const row of stopped.result.strategyRuns) if (row.id !== "benchmark:monthly-dca") row.status = "cancelled";
  let release;
  const stopGate = new Promise(resolve => { release = resolve; });
  let stopRequests = 0;
  await page.route("**/api/v1/runs/active", route => route.fulfill({ json: null }));
  await page.route("**/api/v1/runs", route => route.fulfill({ status: 202, json: pending }));
  await page.route(`**/api/v1/runs/${saved.runId}`, route => route.fulfill({ json: stopped }));
  await page.route(`**/api/v1/runs/${saved.runId}/events`, async route => { await stopGate; await route.fulfill({ contentType: "text/event-stream", body: `event: terminal\ndata: ${JSON.stringify({ runId: saved.runId, status: "cancelled", progress: stopped.progress, strategyStatuses: Object.fromEntries(stopped.result.strategyRuns.map(row => [row.id,row.status])) })}\n\n` }); });
  await page.route(`**/api/v1/runs/${saved.runId}/stop`, async route => { stopRequests++; await route.fulfill({ json: stopped }); release(); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await period(page);
  const play = page.locator(".run-submit-button");
  const bounds = await play.boundingBox();
  await play.click();
  const rows = page.locator(".comparison-table tbody tr");
  await expect(rows.filter({ hasText: "一括投資" }).locator(".run-button-spinner")).toBeVisible();
  await expect(rows.filter({ hasText: "ボラティリティ積立" }).locator(".result-waiting")).toBeVisible();
  await expect(rows.filter({ hasText: "毎月定額積立" })).toContainText("$");
  expect(await play.boundingBox()).toEqual(bounds);
  await page.locator(".run-stop-button").click();
  await expect(play).toBeEnabled();
  await expect(page.locator(".result-stopped")).toHaveCount(2);
  await expect(rows.filter({ hasText: "毎月定額積立" })).toContainText("$");
  expect(stopRequests).toBe(1);
  await expect(page.locator(".run-status-panel, .run-controls")).toHaveCount(0);
  await expect(page.locator(".run-stop-button")).toBeDisabled();
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(axe.violations).toEqual([]);
});
