import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function savedRun(page, presetId = "vix_dca", params = {}, editRules = () => {}) {
  const catalog = await (await page.request.get("/api/v1/catalog")).json();
  const preset = catalog.presets.find(item => item.id === presetId);
  const numericKeys = new Set(catalog.parameters.filter(item => ["decimal", "integer", "ratio", "percent_point"].includes(item.type)).map(item => item.key));
  const numericListKeys = new Set(catalog.parameters.filter(item => item.type === "number_list").map(item => item.key));
  const numericParams = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key,
    numericKeys.has(key) && value !== null ? Number(value) : numericListKeys.has(key) ? value.map(Number) : value]));
  const rules = structuredClone(preset.defaultRules);
  const wireRules = node => {
    if (!node) return;
    if (node.kind) node.params = numericParams(node.params ?? {});
    else (node.children ?? []).forEach(wireRules);
  };
  wireRules(rules?.buy); wireRules(rules?.sell); editRules(rules);
  const response = await page.request.post("/api/v1/runs", {
    headers: { "Idempotency-Key": `report-${presetId}-${Date.now()}` },
    data: { draft: {
      shared: { run: { symbol: "QQQ", startDate: "2024-02-01", endDate: "2024-03-01" }, contribution: { amount: 100, day: 1 } },
      strategies: [{ id: "report-strategy", presetId, params: numericParams({ ...preset.defaultParams, ...params }), rules }],
    }, scope: "all_enabled" },
  });
  expect(response.status()).toBe(202);
  const { runId } = await response.json();
  let saved;
  await expect.poll(async () => {
    saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
    return saved.status;
  }).toMatch(/^completed(?:_with_warning)?$/);
  const primary = saved.result.strategyRuns.find(row => row.id === "report-strategy");
  expect(primary.status, JSON.stringify(primary.diagnostics)).toMatch(/^completed(?:_with_warning)?$/);
  return saved;
}

async function openSaved(page, saved) {
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: saved }));
  await page.addInitScript(() => {
    window.reportAudit = { text: [], bitmaps: [], downloads: 0, revoked: 0 };
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      window.reportAudit.text.push(args[0]); return fillText.apply(this, args);
    };
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      window.reportAudit.bitmaps.push([this.width, this.height]); return encode.apply(this, args);
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download.endsWith(".png")) window.reportAudit.downloads++;
      return click.call(this);
    };
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = function (url) { window.reportAudit.revoked++; return revoke.call(this, url); };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
}

async function pngDownload(page, name) {
  const waiting = page.waitForEvent("download");
  await page.locator("[data-report-kind=png]").click();
  const download = await waiting;
  expect(download.suggestedFilename()).toMatch(/^QQQ-.*\.png$/);
  const path = test.info().outputPath(name);
  await download.saveAs(path);
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  expect(width).toBeGreaterThan(1000);
  expect(height).toBeGreaterThan(1200);
  expect(width * height).toBeLessThanOrEqual(16_000_000);
  expect(height).toBeLessThanOrEqual(16384);
  return download;
}

test("PNG contains frozen full-range results in both locales and survives draft edits", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const saved = await savedRun(page);
  const primary = saved.result.strategyRuns.find(row => row.id === "report-strategy");
  await openSaved(page, saved);
  // Focus is independent of the initially empty curve selection.
  await expect(page.locator(".comparison-table .result-select[aria-pressed=true]")).toHaveCount(0);
  await expect(page.locator("[data-report-kind=png]")).toBeEnabled();
  await page.locator(".comparison-table .result-select").filter({ hasText: "ボラティリティ積立" }).click();
  await page.locator(".shared-settings-open-button").click();
  await page.locator("#field-contribution-amount").fill("999");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await pngDownload(page, "report-ja.png");
  const reportText = await page.evaluate(() => window.reportAudit.text.join("\n"));
  expect(reportText).toContain("バックテスト結果レポート");
  expect(reportText).toContain(`${primary.dailyAssets[0].date} → ${primary.dailyAssets.at(-1).date}`);
  expect(reportText).toContain("毎月 $100.00 USD");
  expect(reportText).not.toContain("999");
  expect(reportText).toContain(new Intl.NumberFormat("ja-JP", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(primary.metrics.endingEquity)));
  expect(reportText).toContain(saved.runId);
  await expect.poll(() => page.evaluate(() => window.reportAudit.revoked)).toBe(1);
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await pngDownload(page, "report-zh.png");
  expect(await page.evaluate(() => window.reportAudit.text.join("\n"))).toContain("回测结果报告");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.locator("[data-report-kind=png]")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("report-controls-320.png") });
  expect(errors).toEqual([]);
});

test("PNG encoding errors are visible and retry succeeds, including zero trades", async ({ page }) => {
  const saved = await savedRun(page, "vix_dca", {}, rules => { rules.buy.enabled = false; });
  const primary = saved.result.strategyRuns.find(row => row.id === "report-strategy");
  expect(primary.trades).toEqual([]);
  await openSaved(page, saved);
  await page.locator(".comparison-table .result-select").filter({ hasText: "ボラティリティ積立" }).click();
  await page.evaluate(() => {
    const real = HTMLCanvasElement.prototype.toBlob;
    let first = true;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      if (first) { first = false; callback(null); } else real.call(this, callback, ...args);
    };
  });
  await page.locator("[data-report-kind=png]").click();
  await expect(page.locator(".report-download-error")).toBeVisible();
  await expect(page.locator("[data-report-kind=png]")).toBeEnabled();
  await pngDownload(page, "zero-trades-report.png");
  await expect(page.locator(".report-download-error")).toHaveCount(0);
  expect(await page.evaluate(() => window.reportAudit.text.join("\n"))).toContain("買付 0 · 売却 0");
});

test("switching focus cancels an image waiting for fonts and does not download the old strategy", async ({ page }) => {
  await openSaved(page, await savedRun(page));
  await page.locator(".comparison-table .result-select").filter({ hasText: "ボラティリティ積立" }).click();
  await page.evaluate(() => {
    const ready = new Promise(resolve => { window.releaseReportFonts = resolve; });
    Object.defineProperty(document.fonts, "ready", { configurable: true, get: () => ready });
  });
  await page.locator("[data-report-kind=png]").click();
  await expect(page.locator("[data-report-kind=png]")).toHaveAttribute("aria-busy", "true");
  await page.locator(".comparison-table .result-select").filter({ hasText: "毎月定額積立" }).click();
  await page.evaluate(() => window.releaseReportFonts());
  await expect(page.locator("[data-report-kind=png]")).toHaveAttribute("aria-busy", "false");
  expect(await page.evaluate(() => window.reportAudit.downloads)).toBe(0);
  await pngDownload(page, "baseline-report.png");
  expect(await page.evaluate(() => window.reportAudit.text.join("\n"))).toContain("毎月定額積立");
});

test("a saved search candidate downloads its own rank, condition and metrics", async ({ page }) => {
  const saved = await savedRun(page, "grid_search", {
    "search.dimensions": ["vix.buyThreshold"], "search.values.vix.buyThreshold": [20, 30],
  }, rules => rules.buy.children.forEach(node => { if (node.kind !== "vix") node.enabled = false; }));
  const primary = saved.result.strategyRuns.find(row => row.id === "report-strategy");
  const entry = primary.searchResult.candidates.find(candidate => candidate.sequence === 2);
  expect(entry.status).toMatch(/^completed(?:_with_warning)?$/);
  await openSaved(page, saved);
  await page.locator(".comparison-table .result-select").filter({ hasText: "グリッド検索" }).click();
  await page.locator("#result-tab-search").click();
  await page.locator(".search-results").getByRole("button", { name: "2", exact: true }).click();
  await expect(page.locator(".search-results .result-select[aria-pressed=true]")).toHaveText("2");
  const download = await pngDownload(page, "candidate-report.png");
  expect(download.suggestedFilename()).toContain(entry.candidateId.replace(/[^a-zA-Z0-9_-]/g, "-"));
  const text = await page.evaluate(() => window.reportAudit.text.join("\n"));
  expect(text).toContain("#2");
  expect(text).toContain("30");
  expect(text).toContain(new Intl.NumberFormat("ja-JP", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(entry.metrics.endingEquity)));
});
