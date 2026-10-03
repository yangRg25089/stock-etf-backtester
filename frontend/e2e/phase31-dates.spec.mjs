import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("accepted date resolution is announced, saved and never reapplied by result restoration", async ({ page }) => {
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
  // The browser exercises the accepted-response contract; SOXQ's actual
  // listing boundary, cash flows and CSV are covered by the live API gate.
  saved.snapshot.dateAdjustments = [{ field: "startDate", requestedDate: "2020-01-01", effectiveDate: "2024-01-31", reason: "market_available_from" }];
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: null }));
  await page.route("**/api/v1/runs", route => route.fulfill({ status: 202, json: saved }));
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
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.locator(".shared-date-adjustment")).toHaveText("已从可用行情日 2024-01-31 开始回测。");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.reload();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".shared-settings-summary-period")).toContainText("2024-01-31");
  await expect(page.locator(".shared-date-adjustment")).toHaveCount(0);
  await page.locator(".shared-settings-open-button").click();
  await page.locator("#field-run-startDate").fill("2024-02-01");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await expect(page.locator(".shared-settings-dialog")).toBeHidden();
  await expect(page.locator(".shared-settings-summary-period")).toContainText("2024-02-01");
  await page.reload();
  await expect(page.locator(".shared-settings-summary-period")).toContainText("2024-02-01");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
});
