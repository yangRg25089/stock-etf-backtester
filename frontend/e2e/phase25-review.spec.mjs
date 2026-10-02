import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("catalog failure and retry report actual initialization state before offering run actions", async ({ page }) => {
  let unavailable = true;
  let releaseRetry;
  const retryGate = new Promise(resolve => { releaseRetry = resolve; });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: null }));
  await page.route("**/api/v1/catalog", async route => {
    if (unavailable) {
      await route.fulfill({ status: 503, json: { detail: "catalog temporarily unavailable" } });
      return;
    }
    await retryGate;
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await page.goto("/");
  await expect(page.locator(".catalog-error")).toBeVisible();
  await expect(page.locator(".run-submit-button")).toHaveCount(0);
  await expect(page.getByText(/READY|準備完了/)).toHaveCount(0);
  unavailable = false;
  await page.locator(".catalog-error button").click();
  await expect(page.locator(".catalog-notice .loading-indicator")).toBeVisible();
  await expect(page.locator(".run-submit-button")).toHaveCount(0);
  releaseRetry();
  await expect(page.locator(".catalog-error, .catalog-notice")).toHaveCount(0);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await expect(page.locator(".strategy-nav-card")).toHaveCount(1);
  expect(errors).toEqual([]);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});
