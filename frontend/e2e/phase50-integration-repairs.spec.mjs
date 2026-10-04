import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { importPackage, installRunFixture } from "./helpers/runtime.mjs";

test("partial failure JSON exports frozen values, imports offline and requires field correction", async ({ page }) => {
  const response = await page.request.post("/api/v1/runs", { headers: { "Idempotency-Key": `partial-files-${Date.now()}` }, data: {
    draft: { shared: { run: { symbol: "QQQ", startDate: "2024-01-31", endDate: "2024-03-01" } },
      strategies: [{ id: "file-vix", presetId: "vix_dca", params: { "vix.buyThreshold": "not-numeric" } },
        { id: "file-custom", presetId: "composite_dca", params: {}, rules: {
          buy: { type: "condition", id: "buy-vix", kind: "vix", enabled: true, params: { "vix.symbol": "^VIX", "vix.buyThreshold": 25 } }, sell: null,
        } }] }, scope: "all_enabled",
  } });
  expect(response.status()).toBe(202);
  const { runId } = await response.json();
  let saved;
  await expect.poll(async () => {
    saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
    return saved.status;
  }).toBe("completed_with_warning");
  expect(saved.result.strategyRuns.filter(row => row.metrics)).toHaveLength(3);
  await installRunFixture(page, saved);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const restored = page.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith(`/api/v1/runs/${saved.runId}`));
  await page.goto("/");
  await restored;
  await expect(page.locator(".run-submit-button")).toHaveAttribute("aria-busy", "false");
  await page.locator(".package-menu summary").click();
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: /結果を保存/ }).click();
  const file = JSON.parse(await readFile(await (await waiting).path(), "utf8"));
  expect(file.result).toEqual(saved);
  expect(file.config.strategies[0].params["vix.buyThreshold"]).toBe("not-numeric");
  await page.route("**/api/v1/runs/**", route => route.request().url().endsWith("/active")
    ? route.fulfill({ json: null }) : route.abort());
  await importPackage(page, file);
  const prior = await page.locator(".comparison-table").textContent();
  await page.locator(".strategy-card-open").first().click();
  const dialog = page.locator(".strategy-dialog");
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-parameter-key="vix.buyThreshold"]')).toHaveAttribute("aria-invalid", "true");
  await dialog.locator('[data-parameter-key="vix.buyThreshold"]').fill("25");
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".comparison-table")).toHaveText(prior);
  expect(errors).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
