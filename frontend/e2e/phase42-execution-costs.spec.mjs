import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { savedRun } from "./helpers/reports.mjs";
import { fetchSavedRecord, restoreSavedRecord, installRunFixture, selectHeaderLocale } from "./helpers/runtime.mjs";

test("saved execution costs, net fills and offline CSV stay independent of draft changes", async ({ page }) => {
  const execution = { commission: 2, slippagePct: 1, spreadPct: 2, fractionalShares: false };
  const saved = await savedRun(page, "vix_dca", {}, undefined, { execution, contribution: { amount: 304, day: 1 } });
  const benchmark = saved.result.strategyRuns.find(row => row.role === "benchmark" && row.presetId === "monthly_dca");
  const costs = benchmark.metrics.tradingCosts;
  expect(Number(costs.totalTradingCost)).toBeGreaterThan(0);
  expect(benchmark.trades.length).toBeGreaterThan(0);
  expect(benchmark.trades.every(trade => Number.isInteger(Number(trade.quantity)))).toBe(true);
  const exports = {};
  for (const kind of ["summary", "daily-assets", "trades"]) {
    const response = await page.request.get(`/api/v1/runs/${saved.runId}/export/${kind}`, { params: { focusedResultId: benchmark.id } });
    expect(response.ok()).toBe(true);
    exports[kind] = await response.text();
  }
  await installRunFixture(page, saved);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".comparison-table").getByRole("button", { name: "毎月定額積立", exact: true }).click();
  await page.locator("#result-tab-details").click();
  const costPanel = page.locator("#result-panel-performance .trading-costs-panel");
  const currency = (value, locale = "ja-JP") => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(value));
  await expect(costPanel.locator("dd")).toHaveText([costs.commission, costs.slippageCost, costs.spreadCost,
    costs.capitalGainsTax, costs.totalTradingCost].map(value => currency(value)));
  const original = await costPanel.innerText();
  const play = page.getByRole("button", { name: "バックテストを実行", exact: true });
  await expect(play).toBeEnabled();
  const disabled = await play.isDisabled();
  await page.locator(".shared-settings-summary").click();
  const dialog = page.locator(".shared-settings-dialog");
  await expect(dialog.locator(".shared-settings-group")).toHaveCount(5);
  await dialog.locator("#field-execution-commission").fill("99");
  await dialog.locator("#field-execution-slippagePct").fill("60");
  await dialog.locator("#field-execution-spreadPct").fill("80");
  await dialog.locator(".dialog-done").click();
  await expect(dialog.locator("#field-execution-spreadPct")).toHaveAttribute("aria-invalid", "true");
  await expect(dialog).toBeVisible();
  expect(await play.isDisabled()).toBe(disabled);
  await dialog.locator("#field-execution-slippagePct").fill("0.1");
  await dialog.locator("#field-execution-spreadPct").fill("0.2");
  await dialog.getByRole("switch", { name: "端株を許可", exact: true }).click();
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toHaveCount(0);
  expect(await costPanel.innerText()).toBe(original);
  await page.locator("#result-tab-details").click();
  await page.locator(".trade-table .table-cell-action").first().click();
  const explanation = page.locator(".result-inspector-dialog");
  await expect(explanation.locator(".trading-costs-panel dd")).toHaveCount(5);
  await expect(explanation).toContainText(currency(benchmark.trades[0].grossAmount));
  await page.keyboard.press("Escape");
  for (const name of ["日本語", "中文"]) {
    await selectHeaderLocale(page, name === "日本語" ? "ja" : "zh");
    await page.locator("#result-tab-details").click();
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 850 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    }
  }
  await costPanel.screenshot({ path: test.info().outputPath("costs-narrow.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  let requests = 0;
  await page.route("**/api/v1/runs/**", route => { requests++; return route.abort(); });
  await restoreSavedRecord(page, await fetchSavedRecord(page, saved));
  await page.locator(".comparison-table").getByRole("button", { name: "每月定额定投", exact: true }).click();
  await page.locator("#result-tab-details").click();
  await expect(costPanel.locator("dd").last()).toHaveText(currency(costs.totalTradingCost, "zh-CN"));
  for (const kind of ["summary", "daily-assets", "trades"]) {
    const waiting = page.waitForEvent("download");
    await page.locator(`[data-export-kind='${kind}']`).click();
    const csv = await readFile(await (await waiting).path(), "utf8");
    expect(csv.split("\n")[0]).toContain("commission,slippageCost,spreadCost,capitalGainsTax,totalTradingCost");
    expect(csv).toBe(exports[kind]);
  }
  expect(requests).toBe(0);
});
