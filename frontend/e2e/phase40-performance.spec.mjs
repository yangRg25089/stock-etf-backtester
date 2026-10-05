import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { installRunFixture } from "./helpers/runtime.mjs";
import { strategyForRequest } from "./helpers/reports.mjs";

async function savedRun(page, presetId = "vix_dca") {
  const catalog = await (await page.request.get("/api/v1/catalog")).json();
  const strategy = strategyForRequest(catalog, "vix_dca", presetId === "grid_search"
    ? { "search.dimensions": ["vix.buyThreshold"] } : { "vix.buyThreshold": 10 });
  const accepted = await page.request.post("/api/v1/runs", {
    headers: { "Idempotency-Key": `performance-${Date.now()}-${test.info().title}` },
    data: { draft: { shared: { run: { symbol: "QQQ", startDate: "2024-01-31", endDate: "2024-03-01" }, contribution: { amount: 100, day: 1 },
      analysis: { riskFreeAnnualRatePct: 5 } }, strategies: [{ ...strategy, id: "saved-analysis", presetId }] }, scope: "all_enabled" },
  });
  expect(accepted.status()).toBe(202);
  const { runId } = await accepted.json();
  let saved;
  await expect.poll(async () => {
    saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
    return saved.status;
  }).toBe("completed");
  for (const row of saved.result.strategyRuns) expect(row.metrics.analysis.riskFreeAnnualRate).toBe("0.05");
  await installRunFixture(page, saved);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await page.locator("#result-tab-performance").click();
  return saved;
}

test("saved NAV analysis is bilingual, accessible and independent of draft rate edits", async ({ page }) => {
  const saved = await savedRun(page);
  const panel = page.locator("#result-panel-performance");
  await expect(panel.locator(".performance-stat")).toHaveCount(11);
  await expect(panel.locator(".performance-basis")).toContainText("5%");
  await expect(panel.locator(".performance-stat").filter({ hasText: "買付回数" }).locator("dd")).toHaveText(String(saved.result.strategyRuns[0].metrics.analysis.buyCount));
  const original = await panel.innerText();
  const runButton = page.getByRole("button", { name: "バックテストを実行", exact: true });
  await expect(runButton).toBeEnabled();
  const originalRunControl = await runButton.evaluate(node => node.outerHTML);
  await page.locator(".shared-settings-summary").click();
  const dialog = page.locator(".shared-settings-dialog");
  await dialog.locator("#field-analysis-riskFreeAnnualRatePct").fill("7");
  expect(await runButton.evaluate(node => node.outerHTML)).toBe(originalRunControl);
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toHaveCount(0);
  expect(await panel.innerText()).toBe(original);
  await expect(runButton).toBeEnabled();
  expect(await runButton.evaluate(node => node.outerHTML)).toBe(originalRunControl);
  for (const locale of ["日本語", "中文"]) {
    await page.locator(".locale-select").selectOption(locale === "日本語" ? "ja" : locale === "中文" ? "zh" : "en");
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 800 });
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  }
  await panel.screenshot({ path: test.info().outputPath("performance-narrow.png") });
});

test("grid candidate details keep the saved risk-free assumption and exact trade counts", async ({ page }) => {
  const saved = await savedRun(page, "grid_search");
  await page.locator("#result-tab-search").click();
  const button = page.locator(".search-table .result-select").last();
  const sequence = Number(await button.innerText());
  await button.click();
  await expect(page.locator(".search-table .result-select[aria-pressed='true']")).toHaveCount(1);
  const candidate = saved.result.strategyRuns[0].searchResult.candidates.find(item => item.sequence === sequence);
  await page.locator("#result-tab-performance").click();
  const panel = page.locator("#result-panel-performance");
  await expect(panel.locator(".performance-basis")).toContainText("5%");
  await expect(panel.locator(".performance-stat").filter({ hasText: "買付回数" }).locator("dd")).toHaveText(String(candidate.metrics.analysis.buyCount));
  await expect(page.locator(".result-detail-name")).toContainText(`#${candidate.sequence}`);
});
