import { expect, test } from "@playwright/test";

for (const [fieldPath, dialog, field, returnFocus] of [
  ["run.symbol", ".shared-settings-dialog", "#field-run-symbol", ".shared-settings-open-button"],
  ["strategies[0].rules.buy.params.vix.buyThreshold", ".strategy-dialog", '[data-parameter-key="vix.buyThreshold"]', ".strategy-card-open"],
]) {
  test(`diagnostic ${fieldPath} reveals and focuses its editor without submitting a job`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    let injectError = true;
    let submissions = 0;
    await page.route("**/api/v1/runs", route => { submissions++; return route.abort(); });
    await page.route("**/api/v1/config/validate", async route => {
      const response = await route.fetch();
      const payload = await response.json();
      if (injectError) {
        injectError = false;
        payload.valid = false;
        payload.diagnostics = [{ code: "invalid_parameter", severity: "error", messageKey: "diagnostics.configuration.out_of_range", fieldPath }];
      }
      await route.fulfill({ response, json: payload });
    });
    await page.goto("/");
    await expect(page.locator(".config-diagnostics")).toBeVisible();
    await expect(page.locator(".run-submit-button")).toBeDisabled();
    await page.locator(".config-diagnostics summary").click();
    await page.locator(".config-diagnostics .diagnostic-field-link").click();
    await expect(page.locator(dialog)).toBeVisible();
    await expect(page.locator(dialog).locator(field)).toBeFocused();
    await page.locator(`${dialog} .dialog-done`).click();
    await expect(page.locator(dialog)).toBeHidden();
    await expect(page.locator(returnFocus).first()).toBeFocused();
    await expect(page.locator(".run-submit-button")).toBeEnabled();
    expect(submissions).toBe(0);
    await expect(page.locator(".run-controls, .run-status-panel")).toHaveCount(0);
  });
}
