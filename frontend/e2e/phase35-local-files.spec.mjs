import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { savedRun } from "./helpers/reports.mjs";
import { importPackage, openSaved, strategyFile } from "./helpers/runtime.mjs";

async function downloadStrategy(page) {
  const waiting = page.waitForEvent("download");
  await page.locator(".package-actions button").first().click();
  const download = await waiting;
  expect(download.suggestedFilename()).toMatch(/\.strategy\.json$/);
  return JSON.parse(await readFile(await download.path(), "utf8"));
}

test("preview cancel preserves the result; strategy import clears results without writing last accepted inputs", async ({ page }) => {
  const saved = await savedRun(page);
  await openSaved(page, saved);
  const initial = await downloadStrategy(page);
  const altered = structuredClone(initial);
  altered.draft.shared.run.symbol = "SPY"; altered.draft.shared.currency = "USD";
  const before = await page.evaluate(() => localStorage.getItem("stock-etf-backtester.last-run-strategy.v1"));
  await importPackage(page, altered, false);
  await expect(page.locator(".package-preview")).toContainText("SPY");
  await page.locator(".package-preview .shared-settings-dialog-footer").getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.locator(".shared-settings-summary-symbol")).toContainText("QQQ");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await importPackage(page, altered);
  await expect(page.locator(".shared-settings-summary-symbol")).toContainText("SPY");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("stock-etf-backtester.last-run-strategy.v1"))).toBe(before);
});

test("strategy download follows draft edits while CSV and frozen API results remain unchanged", async ({ page }) => {
  const saved = await savedRun(page);
  await openSaved(page, saved);
  const csv = await (await page.request.get(`/api/v1/runs/${saved.runId}/export/summary`, { params: { focusedResultId: saved.result.strategyRuns[0].id } })).text();
  await page.locator(".strategy-card-open").first().click();
  await page.locator('[data-parameter-key="vix.buyThreshold"]').fill("31");
  await page.locator(".strategy-dialog .dialog-done").click();
  const strategy = await downloadStrategy(page);
  expect(Number(strategy.draft.strategies[0].rules.buy.params["vix.buyThreshold"])).toBe(31);
  const waiting = page.waitForEvent("download");
  await page.locator('[data-export-kind="summary"]').click();
  expect(await readFile(await (await waiting).path(), "utf8")).toBe(csv);
  expect((await page.request.get(`/api/v1/runs/${saved.runId}/package`)).status()).toBe(404);
  await expect(page.locator(".package-actions button")).toHaveCount(2);
  await importPackage(page, strategy);
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(0);
});

test("invalid, oversized and removed result files cannot replace the workspace", async ({ page }) => {
  const saved = await savedRun(page);
  await openSaved(page, saved);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  for (const mutate of [file => { file.schemaVersion = 99; }, file => { file.type = "backtest"; },
    file => { file.draft.strategies[0].rules.buy.params["vix.buyThreshold"] = "bad"; },
    file => { file.draft.strategies[0].params["unknown.parameter"] = true; }]) {
    const file = strategyFile(saved); mutate(file);
    await page.locator(".file-import-input").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
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

for (const kind of ["search", "signal", "aggregate", "candidate"]) test(`malformed ${kind} API success is rejected without a page crash`, async ({ page }) => {
  const saved = await savedRun(page, "grid_search", { "search.dimensions": ["vix.buyThreshold"], "search.values.vix.buyThreshold": [20, 30] },
    rules => { rules.buy = rules.buy.children.find(node => node.kind === "vix"); rules.sell = null; });
  saved.status = "running";
  const primary = saved.result.strategyRuns[0];
  if (kind === "search") primary.searchResult = {};
  else if (kind === "signal") delete primary.signals[0].signalId;
  else if (kind === "candidate") primary.searchResult.candidates[0].parameterValues = null;
  else { saved.status = "completed"; saved.result.status = "queued"; }
  await page.route("**/api/v1/runs/active", route => route.fulfill({ json: saved }));
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("API の応答を読み取れませんでした。", { exact: true })).toBeVisible();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(0);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  expect(errors).toEqual([]);
});

test("strategy preview and visible file controls work across layouts and all locales", async ({ page }) => {
  const saved = await savedRun(page); const file = strategyFile(saved);
  await page.goto("/");
  for (const locale of ["ja", "zh", "en"]) {
    await page.locator(".locale-select").selectOption(locale);
    for (const width of [1920, 1024, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await importPackage(page, file, false);
      const geometry = await page.locator(".package-preview").boundingBox();
      expect(geometry.x).toBeGreaterThanOrEqual(0); expect(geometry.x + geometry.width).toBeLessThanOrEqual(width);
      await expect(page.locator(".package-preview .button-primary")).toBeInViewport();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape"); await expect(page.locator(".package-preview")).toHaveCount(0);
    }
  }
});
