import { expect, test } from "@playwright/test";
import { savedRun, openSaved } from "./helpers/reports.mjs";

test("strategy dialogs show directional rules, calculation windows, and live parameter values", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".strategy-card-open").first().click();
  const vix = page.locator('.strategy-dialog [data-rule-side="buy"] [data-condition-kind="vix"]');
  const vixRule = vix.locator(".condition-expression-summary");
  await expect(vixRule).toContainText("≥");
  await expect(vixRule).toContainText("25");
  const vixThreshold = vix.locator('input[data-parameter-key="vix.buyThreshold"]');
  const vixLabel = page.locator(`label[for="${await vixThreshold.getAttribute("id")}"]`);
  await expect(vixLabel).toContainText("≥");
  await vixThreshold.fill("29");
  await expect(vixRule).toContainText("29");
  await page.locator(".strategy-dialog .dialog-done").click();

  await page.locator(".add-strategy-button").click();
  await page.locator('.strategy-add-option[data-preset-id="rsi_dca"]').click();
  await page.locator(".strategy-card-open").last().click();
  const rsi = page.locator('.strategy-dialog [data-rule-side="buy"] [data-condition-kind="rsi"]');
  await expect(rsi.locator(".condition-expression-summary")).toContainText("RSI（14取引日） ≤ 30");
  const period = rsi.locator('input[data-parameter-key="rsi.period"]');
  const periodLabel = page.locator(`label[for="${await period.getAttribute("id")}"]`);
  await expect(periodLabel).toContainText("取引日単位の計算期間");
});

test("the date-row closing-price control and chart legend share independent visibility", async ({ page }) => {
  const saved = await savedRun(page);
  await openSaved(page, saved);
  const resultSelection = page.locator(".comparison-table .result-select").first();
  if (await resultSelection.getAttribute("aria-pressed") !== "true") await resultSelection.click();

  const chart = page.locator(".chart-overlay");
  const toolbarPrice = page.locator('.chart-controls [data-series="price"]');
  const dateRowPrice = chart.locator('.chart-market-readout [data-series="price"]');
  const toolbarAsset = page.locator('.chart-controls [data-series="totalAsset"]');
  await expect(toolbarPrice).toHaveAttribute("aria-pressed", "true");
  await expect(dateRowPrice).toHaveAttribute("aria-pressed", "true");

  await toolbarPrice.click();
  await expect(toolbarPrice).toHaveAttribute("aria-pressed", "false");
  await expect(dateRowPrice).toHaveAttribute("aria-pressed", "false");
  await expect(chart.locator("polyline.overlay-price")).toHaveCount(0);

  await dateRowPrice.click();
  await expect(toolbarPrice).toHaveAttribute("aria-pressed", "true");
  await expect(dateRowPrice).toHaveAttribute("aria-pressed", "true");
  await expect(chart.locator("polyline.overlay-price")).toHaveCount(1);

  await toolbarPrice.click();
  await toolbarAsset.click();
  await expect(chart.locator(".chart-empty-main")).toBeVisible();
  await expect(dateRowPrice).toHaveAttribute("aria-pressed", "false");
  await dateRowPrice.click();
  await expect(toolbarPrice).toHaveAttribute("aria-pressed", "true");
  await expect(chart.locator(".chart-empty-main")).toHaveCount(0);
  await expect(chart.locator("polyline.overlay-price")).toHaveCount(1);

  const chartHeight = () => chart.locator("svg[data-chart-id=overlay]").evaluate(svg => svg.getBoundingClientRect().height);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(chartHeight).toBeGreaterThan(400);
  await expect.poll(chartHeight).toBeLessThanOrEqual(440);
  await page.setViewportSize({ width: 375, height: 900 });
  await expect.poll(chartHeight).toBeGreaterThanOrEqual(275);
  await expect.poll(chartHeight).toBeLessThanOrEqual(280);
});
