import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("worker-resolved dates survive refresh; unsubmitted edits and completed results do not", async ({ page }) => {
  const prepared = await page.request.post("/api/v1/runs", {
    headers: { "Idempotency-Key": `resolved-ui-${Date.now()}` },
    data: { draft: {
      shared: { run: { symbol: "QQQ", startDate: "2024-01-31", endDate: "2024-03-01" }, contribution: { day: 1, amount: 100 } },
      strategies: [{ id: "strategy-vix_dca-1", presetId: "vix_dca", params: {} }],
    }, scope: "all_enabled" },
  });
  expect(prepared.status()).toBe(202);
  const { runId } = await prepared.json();
  let saved;
  await expect.poll(async () => {
    saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
    return saved.status;
  }).toBe("completed");
  // The browser exercises asynchronous resolution; SOXQ's actual
  // listing boundary, cash flows and CSV are covered by the live API gate.
  saved.snapshot.dateAdjustments = [{ field: "startDate", requestedDate: "2020-01-01", effectiveDate: "2024-01-31", reason: "market_available_from" }];
  saved.snapshot.config.shared.run.startDate = "2020-01-01";
  saved.snapshot.dataContext.dateAdjustments = structuredClone(saved.snapshot.dateAdjustments);
  const queued = structuredClone(saved);
  queued.status = queued.result.status = "queued";
  Object.assign(queued.snapshot, { dataContext: null, dataFingerprint: null, dataProvenance: {}, dateAdjustments: [] });
  queued.progress = { completedStrategies: 0, totalStrategies: 3, currentStrategyId: null };
  for (const row of queued.result.strategyRuns) Object.assign(row, { status: "queued", metrics: null, dailyAssets: [], trades: [], signals: [], technicalIndicators: [] });
  await page.route("**/api/v1/runs", route => route.fulfill({ status: 202, json: queued }));
  await page.route(`**/api/v1/runs/${runId}`, route => route.fulfill({ json: saved }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".shared-settings-open-button").click();
  await page.locator("#field-run-endDate").fill("2024-03-01");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await expect(page.locator(".shared-settings-dialog")).toBeHidden();
  const gets = [];
  page.on("request", request => {
    if (request.method() === "GET" && request.url().endsWith(`/api/v1/runs/${runId}`)) gets.push(request.url());
  });
  await page.locator(".run-submit-button").click();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await expect(page.locator(".shared-settings-summary-period")).toContainText("2024-01-31");
  await expect(page.locator(".shared-date-adjustment")).toHaveText("取得可能な 2024-01-31 から計算します。");
  expect(gets).toHaveLength(1);
  await page.locator(".locale-select").selectOption("zh");
  await expect(page.locator(".shared-date-adjustment")).toHaveText("已从可用行情日 2024-01-31 开始回测。");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.reload();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(0);
  await expect(page.locator(".shared-settings-summary-period")).toContainText("2024-01-31");
  await expect(page.locator(".shared-date-adjustment")).toHaveCount(0);
  await page.locator(".shared-settings-open-button").click();
  await page.locator("#field-run-startDate").fill("2024-02-01");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await expect(page.locator(".shared-settings-dialog")).toBeHidden();
  await expect(page.locator(".shared-settings-summary-period")).toContainText("2024-02-01");
  await page.reload();
  await expect(page.locator(".shared-settings-summary-period")).toContainText("2024-01-31");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(0);
});

test("a period before listing offers explicit recovery without running or replacing saved results", async ({ page }) => {
  const prepared = await page.request.post("/api/v1/runs", {
    headers: { "Idempotency-Key": `unavailable-ui-${Date.now()}` },
    data: { draft: { shared: { run: { symbol: "QQQ", startDate: "2024-01-31", endDate: "2024-03-01" } },
      strategies: [{ id: "strategy-vix_dca-1", presetId: "vix_dca", params: {} }] }, scope: "all_enabled" },
  });
  expect(prepared.status()).toBe(202);
  const { runId } = await prepared.json();
  let saved;
  await expect.poll(async () => {
    saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
    return saved.status;
  }).toBe("completed");
  saved.status = "unavailable";
  saved.result.status = "unavailable";
  saved.snapshot.dateAdjustments = [];
  Object.assign(saved.snapshot.config.shared.run, { symbol: "SOXQ", startDate: "2020-01-01", endDate: "2020-12-31" });
  saved.snapshot.dataContext.effectiveRun = structuredClone(saved.snapshot.config.shared.run);
  saved.snapshot.dataContext.dateAdjustments = [];
  for (const result of saved.result.strategyRuns) {
    Object.assign(result, { status: "unavailable", metrics: null, dailyAssets: [], trades: [], signals: [], technicalIndicators: [],
      diagnostics: [{ code: "required_data_unavailable", messageKey: "market.period_before_listing", fieldPath: "run.startDate",
        details: { symbol: "SOXQ", availableFrom: "2021-06-11", requestedStartDate: "2020-01-01", requestedEndDate: "2020-12-31",
          suggestedStartDate: "2021-06-11", suggestedEndDate: "2026-10-02" } }] });
  }
  let submissions = 0;
  await page.route("**/api/v1/runs", route => { submissions++; return route.fulfill({ status: 202, json: saved }); });
  await page.route(`**/api/v1/runs/${runId}`, route => route.fulfill({ json: saved }));
  await page.route("**/api/v1/instruments/SOXQ", route => route.fulfill({ json: { symbol: "SOXQ", currency: "USD", diagnostics: [] } }));
  await page.goto("/");
  await page.locator(".locale-select").selectOption("zh");
  await page.locator(".shared-settings-open-button").click();
  await page.locator("#field-run-symbol").fill("SOXQ");
  await page.locator("#field-run-endDate").fill("2020-12-31");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await expect(page.locator(".shared-settings-dialog")).toBeHidden();
  await page.locator(".run-submit-button").click();
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await expect(page.locator(".diagnostic-context")).toHaveText("SOXQ 可用行情始于 2021-06-11");
  await page.getByRole("button", { name: "调整到可用区间", exact: true }).click();
  await expect(page.locator(".shared-settings-summary-period")).toContainText("2021-06-11");
  await expect(page.locator(".shared-settings-summary-period")).toContainText("2026-10-02");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".comparison-table tbody")).not.toContainText("$100");
  expect(submissions).toBe(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  // An old suggestion never overwrites subsequent edits or starts a new run.
  await page.getByRole("button", { name: "调整到可用区间", exact: true }).click();
  await expect(page.locator(".shared-settings-dialog")).toBeVisible();
  await expect(page.locator("#field-run-startDate")).toHaveValue("2021-06-11");
  expect(submissions).toBe(1);
});
