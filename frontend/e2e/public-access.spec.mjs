import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { selectHeaderLocale } from "./helpers/runtime.mjs";
import { openSaved, savedRun } from "./helpers/reports.mjs";

const waiting = {
  ja: "37 秒後に再試行してください。",
  zh: "请等待 37 秒后重试。",
  en: "Try again in 37 seconds.",
};

for (const locale of ["ja", "zh", "en"]) {
  test(`public rate refusal is visible, translated and unlocks controls: ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: locale === "zh" ? 320 : 1024, height: 900 });
    await page.route("**/api/v1/runs", route => route.fulfill({ status: 429,
      headers: { "Retry-After": "37", "Cache-Control": "no-store" },
      json: { error: { code: "rate_limited", messageKey: "api.errors.rate_limited",
        diagnostics: [], retryAfterSeconds: 37 } },
    }));
    await page.goto("/");
    await selectHeaderLocale(page, locale);
    const run = page.locator(".run-submit-button");
    await expect(run).toBeEnabled();
    await run.click();
    await expect(page.locator("#result-details .field-error")).toContainText(waiting[locale]);
    await expect(run).toBeEnabled();
    await expect(page.locator(".run-stop-button")).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("stock-etf-backtester.active-run-id.v1"))).toBeNull();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}

test("a rate refusal preserves a previous frozen result and its export", async ({ page }) => {
  const saved = await savedRun(page);
  await openSaved(page, saved);
  await selectHeaderLocale(page, "zh");
  const rows = page.locator(".comparison-table tbody tr");
  await expect(rows).toHaveCount(saved.result.strategyRuns.length);
  const before = await rows.allTextContents();
  await page.route("**/api/v1/runs", route => route.fulfill({ status: 429,
    json: { error: { code: "rate_limited", messageKey: "api.errors.rate_limited",
      diagnostics: [], retryAfterSeconds: 21 } },
  }));
  await page.locator(".run-submit-button").click();
  await expect(page.locator("#result-details .field-error")).toContainText("请等待 21 秒后重试。");
  expect(await rows.allTextContents()).toEqual(before);
  await expect(page.locator('[data-export-kind="summary"]')).toBeEnabled();
});
