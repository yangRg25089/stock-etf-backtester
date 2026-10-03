import { expect, test } from "@playwright/test";
import { savedRun, openSaved, pngDownload } from "./helpers/reports.mjs";

test("a delayed CSV failure from the previous focus cannot contaminate the new strategy", async ({ page }) => {
  await openSaved(page, await savedRun(page));
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  let requested;
  await page.route("**/export/summary**", async route => {
    requested = route.request().url();
    await delayed;
    await route.fulfill({ status: 500, json: { error: { code: "provider_request_failed", messageKey: "api.errors.connection_failed", diagnostics: [] } } });
  });
  await page.locator("[data-export-kind=summary]").click();
  await expect.poll(() => requested).toContain("focusedResultId=report-strategy");
  await page.locator(".comparison-table .result-select").filter({ hasText: "毎月定額積立" }).click();
  release();
  await expect(page.locator("[data-export-kind=summary]")).toBeEnabled();
  await expect(page.locator(".export-error")).toHaveCount(0);
});

test("cancelling a stale successful CSV and retrying binds the new saved identity", async ({ page }) => {
  await openSaved(page, await savedRun(page));
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  let requested;
  let downloads = 0;
  page.on("download", () => { downloads++; });
  await page.route("**/export/trades**", async route => {
    requested = route.request().url();
    if (requested.includes("report-strategy")) await delayed;
    await route.fulfill({ status: 200, body: "date,quantity\n2024-02-02,1\n", headers: {
      "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=focused.csv",
    } });
  });
  await page.locator("[data-export-kind=trades]").click();
  await expect.poll(() => requested).toContain("report-strategy");
  await page.locator(".comparison-table .result-select").filter({ hasText: "毎月定額積立" }).click();
  release();
  await expect(page.locator("[data-export-kind=trades]")).toBeEnabled();
  expect(downloads).toBe(0);
  const download = page.waitForEvent("download");
  await page.locator("[data-export-kind=trades]").click();
  await download;
  expect(requested).toContain("focusedResultId=benchmark%3Amonthly-dca");
  expect(downloads).toBe(1);
});

test("large KPI amounts remain inside each report card", async ({ page }) => {
  const saved = await savedRun(page);
  const primary = saved.result.strategyRuns.find(row => row.id === "report-strategy");
  for (const key of ["endingEquity", "totalContributed", "actualInvested", "netProfit"]) {
    primary.metrics[key] = "123456789012345.67";
  }
  saved.snapshot.config.shared.contribution.amount = "1000000000000";
  await openSaved(page, saved);
  await page.evaluate(() => {
    window.reportCardWidths = [];
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (String(args[0]).includes("123,456,789,012,345")) {
        window.reportCardWidths.push({ text: args[0], width: this.measureText(args[0]).width });
      }
      return fill.apply(this, args);
    };
  });
  await pngDownload(page, "large-kpi.png");
  const cards = await page.evaluate(() => window.reportCardWidths);
  expect(cards).toHaveLength(4);
  expect(cards.every(row => row.width <= 240)).toBe(true);
});

test("long historical condition text is retained while the native PNG stays within its pixel budget", async ({ page }) => {
  const saved = await savedRun(page);
  const note = "SOURCE_VALIDATION_".repeat(1500) + "END_OF_HISTORICAL_NOTE";
  // Unknown historical fields are retained by the report, not accepted as new strategy configuration.
  const buy = saved.snapshot.config.strategies[0].rules.buy;
  const leaf = buy.kind ? buy : buy.children.find(node => node.kind);
  leaf.params["future.note"] = note;
  await openSaved(page, saved);
  await pngDownload(page, "long-historical-report.png", 0);
  const audit = await page.evaluate(() => window.reportAudit);
  expect(audit.text.join("")).toContain(note);
  expect(audit.bitmaps).toHaveLength(1);
  const [width, height] = audit.bitmaps[0];
  // Logical width is 1200; ordinary reports use a 2× bitmap. This one must be scaled below 2×.
  expect(width).toBeLessThan(2400);
  expect(width * height).toBeLessThanOrEqual(16_000_000);
  expect(height).toBeLessThanOrEqual(16384);
});

test("rapid legend inspection preserves each selected strategy's own trade markers", async ({ page }) => {
  const saved = await savedRun(page);
  await openSaved(page, saved);
  const names = ["ボラティリティ積立", "毎月定額積立", "一括投資"];
  for (const name of names) await page.locator(".comparison-table .result-select").filter({ hasText: name }).click();
  for (const name of [...names, ...[...names].reverse()]) {
    const legend = page.locator(".chart-overlay figcaption button").filter({ hasText: name });
    await legend.hover();
    const markers = page.locator(".chart-overlay .chart-trade-marker");
    expect(await markers.count()).toBeGreaterThan(0);
    const hovering = await markers.evaluateAll(nodes => nodes.map(node => ({ owner: node.dataset.resultId, points: node.getAttribute("points") })));
    const owner = saved.result.strategyRuns.find(row => (name === "ボラティリティ積立" ? row.id === "report-strategy" :
      row.presetId === (name === "毎月定額積立" ? "monthly_dca" : "lump_sum"))).id;
    expect(hovering.every(row => row.owner === owner)).toBe(true);
    await legend.click();
    await page.locator("#result-details-toggle").focus();
    await page.locator(".chart-core-readout-row").hover();
    await expect(legend).toHaveAttribute("aria-pressed", "true");
    expect(await markers.evaluateAll(nodes => nodes.map(node => ({ owner: node.dataset.resultId, points: node.getAttribute("points") })))).toEqual(hovering);
    await legend.click();
    await page.locator("#result-details-toggle").focus();
    await page.locator(".chart-core-readout-row").hover();
    await expect(markers).toHaveCount(0);
  }
  await page.locator(".comparison-table .result-select").filter({ hasText: names[1] }).click();
  await expect(page.locator(".comparison-table .result-select[aria-pressed=true]")).toHaveCount(2);
});
