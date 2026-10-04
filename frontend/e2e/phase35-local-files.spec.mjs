import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { savedRun } from "./helpers/reports.mjs";
import { importPackage, backtestFile } from "./helpers/runtime.mjs";

async function downloadFile(page, kind) {
  const waiting = page.waitForEvent("download");
  await page.locator(".package-menu summary").click();
  await page.getByRole("button", { name: kind === "strategy" ? /戦略を保存/ : /結果を保存/ }).click();
  const download = await waiting;
  expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${kind}\\.json$`));
  return JSON.parse(await readFile(await download.path(), "utf8"));
}

test("file preview cancel is inert; strategy import resets results without writing last-run inputs", async ({ page }) => {
  const saved = await savedRun(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(0);
  await importPackage(page, backtestFile(saved));
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  const initial = await downloadFile(page, "strategy");
  const altered = structuredClone(initial);
  altered.draft.shared.run.symbol = "SPY";
  altered.draft.shared.currency = "USD";
  const before = await page.evaluate(() => localStorage.getItem("stock-etf-backtester.last-run-strategy.v1"));
  await importPackage(page, altered, false);
  await expect(page.locator(".package-preview")).toContainText("SPY");
  await page.locator(".package-preview footer").getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.locator(".shared-settings-summary-symbol")).toContainText("QQQ");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await importPackage(page, altered);
  await expect(page.locator(".shared-settings-summary-symbol")).toContainText("SPY");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("stock-etf-backtester.last-run-strategy.v1"))).toBe(before);
});

test("imported search candidates, four CSVs and PNG work without a run server", async ({ page }) => {
  const saved = await savedRun(page, "grid_search", { "search.dimensions": ["vix.buyThreshold"], "search.values.vix.buyThreshold": [20, 30] },
    rules => rules.buy.children.forEach(node => { if (node.kind !== "vix") node.enabled = false; }));
  const response = await page.request.get(`/api/v1/runs/${saved.runId}/package`);
  expect(response.status()).toBe(200);
  const file = await response.json();
  const primary = saved.result.strategyRuns[0];
  const entry = primary.searchResult.candidates[1];
  const expectedCsv = {};
  for (const kind of ["summary", "daily-assets", "trades", "search-results"]) {
    expectedCsv[kind] = await (await page.request.get(`/api/v1/runs/${saved.runId}/export/${kind}`, {
      params: { focusedResultId: kind === "search-results" ? primary.id : entry.candidateId },
    })).text();
  }
  const unexpected = [];
  await page.route("**/api/v1/runs/**", route => {
    if (route.request().url().endsWith("/active")) return route.fulfill({ json: null });
    unexpected.push(route.request().url()); return route.fulfill({ status: 404, json: {} });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await importPackage(page, file);
  await page.locator("#result-tab-search").click();
  await page.locator(".search-results").getByRole("button", { name: "2", exact: true }).click();
  await expect(page.locator(".search-results").getByRole("button", { name: "2", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".chart-overlay svg.result-chart")).toBeVisible();
  await expect(page.locator(".chart-overlay polyline.overlay-totalAsset")).toHaveAttribute("points", /[\d.]+,[\d.]+(?: [\d.]+,[\d.]+)+/);
  for (const kind of ["summary", "daily-assets", "trades", "search-results"]) {
    const waiting = page.waitForEvent("download");
    await page.locator(`[data-export-kind='${kind}']`).click();
    const content = await readFile(await (await waiting).path(), "utf8");
    expect(content).toBe(expectedCsv[kind]);
  }
  const waiting = page.waitForEvent("download");
  await page.locator("[data-report-kind=png]").click();
  const png = await readFile(await (await waiting).path());
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const reexported = await downloadFile(page, "backtest");
  expect(reexported.config).toEqual(file.config);
  expect(reexported.result).toEqual(file.result);
  expect(reexported.candidateDetails).toEqual(file.candidateDetails);
  expect(unexpected).toEqual([]);
});

test("result file exports the frozen run rather than later dialog edits, then rerun becomes live", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".shared-settings-open-button").click();
  await page.locator("#field-run-startDate").fill("2024-02-01");
  await page.locator("#field-run-endDate").fill("2024-03-01");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await page.locator(".run-submit-button").click();
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await page.locator(".strategy-card-open").first().click();
  await page.locator("#field-strategy-vix_dca-1-vix-buyThreshold").fill("31");
  await page.locator(".strategy-dialog .dialog-done").click();
  const strategy = await downloadFile(page, "strategy");
  const result = await downloadFile(page, "backtest");
  expect(strategy.draft.strategies[0].rules.buy.params["vix.buyThreshold"]).toBe(31);
  expect(Number(result.config.strategies[0].rules.buy.params["vix.buyThreshold"])).toBe(25);
  await importPackage(page, result);
  await expect(page.locator(".imported-result-label")).toBeVisible();
  await page.locator(".run-submit-button").click();
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await expect(page.locator(".imported-result-label")).toHaveCount(0);
});

test("bad import never replaces the workbench and oversize files are rejected before parsing", async ({ page }) => {
  const saved = await savedRun(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await importPackage(page, backtestFile(saved));
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const mutate of [file => { file.schemaVersion = 99; }, file => { file.result.result.strategyRuns[0].searchResult = {}; },
    file => { delete file.result.result.strategyRuns[0].signals[0].signalId; }]) {
    const file = backtestFile(structuredClone(saved)); mutate(file);
    await page.locator(".file-import-input").setInputFiles({ name: "invalid.backtest.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
    await expect(page.locator(".package-error")).toBeVisible();
    await expect(page.locator(".package-preview")).toHaveCount(0);
    await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  }
  const oversized = test.info().outputPath("oversized.json");
  await writeFile(oversized, Buffer.alloc(64 * 1024 * 1024 + 1, 32));
  await page.locator(".file-import-input").setInputFiles(oversized);
  await expect(page.locator(".package-error")).toContainText("64 MB");
  expect(errors).toEqual([]);
});

test("corrupt candidate mappings and terminal envelopes are rejected before changing saved charts", async ({ page }) => {
  const saved = await savedRun(page, "grid_search", { "search.dimensions": ["vix.buyThreshold"], "search.values.vix.buyThreshold": [20, 30] },
    rules => rules.buy.children.forEach(node => { if (node.kind !== "vix") node.enabled = false; }));
  const response = await page.request.get(`/api/v1/runs/${saved.runId}/package`);
  const valid = await response.json();
  await page.goto("/");
  await importPackage(page, valid);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const before = await page.locator(".comparison-table").innerText();
  for (const mutate of [
    file => { file.result.result.strategyRuns[0].searchResult.candidates[0].parameterValues = null; },
    file => { file.result.result.strategyRuns = []; },
    file => { file.result.result.status = "queued"; },
    file => { file.result.result.strategyRuns.splice(0, 1); },
  ]) {
    const file = structuredClone(valid);
    mutate(file);
    await page.locator(".file-import-input").setInputFiles({ name: "invalid.backtest.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
    await expect(page.locator(".package-error")).toBeVisible();
    await expect(page.locator(".package-preview")).toHaveCount(0);
    expect(await page.locator(".comparison-table").innerText()).toBe(before);
  }
  await page.locator("#result-tab-search").click();
  const download = page.waitForEvent("download");
  await page.locator('[data-export-kind="search-results"]').click();
  expect(await readFile(await (await download).path(), "utf8")).toContain("candidateId");
  expect(errors).toEqual([]);
});

for (const kind of ["search", "signal"]) test(`malformed HTTP success with a broken ${kind} is rejected without a page crash`, async ({ page }) => {
  const saved = await savedRun(page);
  saved.status = "running";
  const primary = saved.result.strategyRuns[0];
  if (kind === "search") primary.searchResult = {};
  else delete primary.signals[0].signalId;
  await page.route("**/api/v1/runs/active", route => route.fulfill({ json: saved }));
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("API の応答を読み取れませんでした。", { exact: true })).toBeVisible();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(0);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  expect(errors).toEqual([]);
});

test("file controls and import dialogs remain readable and accessible across layouts and locales", async ({ page }) => {
  const saved = await savedRun(page);
  await page.goto("/");
  for (const language of ["日本語", "中文"]) {
    await page.getByRole("button", { name: language, exact: true }).click();
    for (const width of [1920, 1024, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await importPackage(page, backtestFile(saved), false);
      const geometry = await page.locator(".package-preview").boundingBox();
      expect(geometry.x).toBeGreaterThanOrEqual(0);
      expect(geometry.x + geometry.width).toBeLessThanOrEqual(width);
      await expect(page.locator(".package-preview .button-primary")).toBeInViewport();
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`file-preview-${language}-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(page.locator(".package-preview")).toHaveCount(0);
    }
  }
});
