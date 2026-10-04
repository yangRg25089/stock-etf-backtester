import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { backtestFile, importPackage, installRunFixture } from "./helpers/runtime.mjs";

async function savedRun(page) {
  const accepted = await page.request.post("/api/v1/runs", {
    headers: { "Idempotency-Key": `explain-${Date.now()}-${test.info().title}` },
    data: { draft: { shared: { run: { symbol: "QQQ", startDate: "2024-01-31", endDate: "2024-03-01" }, contribution: { amount: 100, day: 1 } },
      strategies: [{ id: "explain-vix", presetId: "vix_dca", params: { "vix.buyThreshold": 10 } }] }, scope: "all_enabled" },
  });
  expect(accepted.status()).toBe(202);
  const { runId } = await accepted.json();
  let saved;
  await expect.poll(async () => {
    saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
    return saved.status;
  }).toBe("completed");
  const result = saved.result.strategyRuns[0];
  expect(result.trades.length).toBeGreaterThan(0);
  expect(result.unexecutedSignals.length).toBeGreaterThan(0);
  await installRunFixture(page, saved);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  return { saved, result };
}

test("trade rows and chart markers open the same saved balances and T+1 observation without panning", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const { result } = await savedRun(page);
  const trade = result.trades[0];
  const dateIndex = result.dailyAssets.findIndex(asset => asset.date === trade.date);
  const signalDate = result.dailyAssets[dateIndex - 1].date;
  const signal = result.signals.find(signal => signal.date === signalDate && signal.conditionKind === "vix");
  await page.locator("#result-tab-trades").click();
  const entry = page.locator(".trade-table .table-cell-action").first();
  await entry.click();
  const dialog = page.locator(".result-inspector-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".explanation-signal-date")).toContainText(signalDate);
  await expect(dialog.locator(".explanation-observation")).toContainText(`${signal.observedValue} ≥ 10`);
  await expect(dialog.locator(".explanation-values").last()).toContainText("$100.00");
  await expect(dialog.locator(".explanation-values").last()).toContainText("$0.00");
  const tableExplanation = await dialog.locator(".result-inspector-content").innerText();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(entry).toBeFocused();
  await page.locator("#result-tab-comparison").click();
  await page.locator(".comparison-table").getByRole("button", { name: "ボラティリティ積立", exact: true }).click();
  const chart = page.locator(".chart-overlay");
  await chart.locator(".chart-strategy-readout").click();
  const windowBefore = await chart.getAttribute("data-window-start");
  const marker = chart.locator(".chart-trade-action").first();
  await marker.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  expect(await dialog.locator(".result-inspector-content").innerText()).toBe(tableExplanation);
  await page.keyboard.press("Escape");
  await expect(marker).toBeFocused();
  await marker.click();
  await expect(dialog).toBeVisible();
  expect(await chart.getAttribute("data-window-start")).toBe(windowBefore);
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("unexecuted signals retain their saved reason in bilingual narrow accessible dialogs", async ({ page }) => {
  const { result } = await savedRun(page);
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await page.locator("#result-tab-trades").click();
  await page.locator(".unexecuted-signals summary").click();
  const entry = page.locator(".unexecuted-signals .table-cell-action").first();
  await entry.click();
  const dialog = page.locator(".result-inspector-dialog");
  await expect(dialog).toContainText("回测期间内没有下一个交易日");
  await expect(dialog.locator(".explanation-summary")).toContainText(result.unexecutedSignals[0].signalDate);
  await expect(dialog.locator(".explanation-values")).toHaveCount(0);
  for (const width of [1440, 768, 320]) {
    await page.setViewportSize({ width, height: 700 });
    const bounds = await dialog.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  }
  await dialog.screenshot({ path: test.info().outputPath("unexecuted-dialog.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("the compact data tool reports saved coverage and dates, keeps draft edits separate and restores focus", async ({ page }) => {
  const { saved, result } = await savedRun(page);
  const button = page.getByRole("button", { name: "保存データ", exact: true });
  await button.click();
  const dialog = page.locator(".result-inspector-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".saved-data-values")).toContainText(saved.snapshot.config.shared.run.startDate);
  await expect(dialog.locator(".saved-data-values")).toContainText(result.dailyAssets[0].date);
  await expect(dialog.locator(".saved-data-values")).toContainText("USD");
  await expect(dialog.locator(".saved-data-series")).toContainText("^VIX");
  await expect(dialog.locator(".saved-data-series")).toContainText("100%");
  const before = await dialog.locator(".result-inspector-content").innerText();
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
  await page.locator(".shared-settings-summary").click();
  const field = page.locator(".shared-settings-dialog #field-run-startDate");
  await field.fill("2024-02-01");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await expect(page.locator(".shared-settings-dialog")).toHaveCount(0);
  await button.click();
  expect(await dialog.locator(".result-inspector-content").innerText()).toBe(before);
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 700 });
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  }
  await dialog.screenshot({ path: test.info().outputPath("saved-data-dialog.png") });
});

test("imported explanations remain usable without the original job or supplier services", async ({ page }) => {
  const { saved, result } = await savedRun(page);
  let requests = 0;
  await page.route("**/api/v1/runs/**", route => { requests += 1; return route.abort(); });
  await importPackage(page, backtestFile(saved));
  await page.locator("#result-tab-trades").click();
  await page.locator(".trade-table .table-cell-action").first().click();
  const dialog = page.locator(".result-inspector-dialog");
  await expect(dialog).toContainText(result.trades[0].date);
  await expect(dialog.locator(".explanation-observation")).toContainText("≥ 10");
  await expect(dialog.locator(".explanation-values").last()).toContainText("$100.00");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "保存データ", exact: true }).click();
  await expect(dialog.locator(".saved-data-series")).toContainText("100%");
  expect(requests).toBe(0);
});
