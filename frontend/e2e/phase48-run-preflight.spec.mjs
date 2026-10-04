import { expect, test } from "@playwright/test";

test("committed drafts preflight; modal buffers leave run availability and saved results intact", async ({ page }) => {
  const requests = [];
  page.on("request", request => { if (request.url().endsWith("/api/v1/config/validate")) requests.push(request.postDataJSON()); });
  await page.goto("/");
  await expect.poll(() => requests.some(request => request.draft.shared.contribution.amount === "100")).toBe(true);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  const before = requests.length;
  await page.locator(".shared-settings-open-button").click();
  await page.locator("#field-contribution-amount").fill("");
  await page.waitForTimeout(400);
  expect(requests.length).toBe(before);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await page.locator("#field-contribution-amount").fill("150");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await expect.poll(() => requests.filter(request => request.draft.shared.contribution.amount === "150").length).toBeGreaterThan(1);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(0);
});

test("stale preflight errors do not disable the latest confirmed draft", async ({ page }) => {
  let rejected = false;
  await page.route("**/api/v1/config/validate", async route => {
    const amount = route.request().postDataJSON().draft.shared.contribution.amount;
    if (amount === "100") {
      rejected = true;
      await new Promise(resolve => setTimeout(resolve, 1200));
      await route.fulfill({ json: { sharedSettings: null, diagnostics: [{ code: "invalid_parameter", severity: "error", messageKey: "diagnostics.configuration.invalid_type", fieldPath: "contribution.amount" }], strategies: [], dataRequirements: [] } });
    } else await route.continue();
  });
  await page.goto("/");
  await expect.poll(() => rejected).toBe(true);
  await page.locator(".shared-settings-open-button").click();
  await page.locator("#field-contribution-amount").fill("150");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await page.waitForTimeout(1300);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
});

test("unchanged dialog confirmation preserves availability without another preflight", async ({ page }) => {
  const requests = [];
  page.on("request", request => { if (request.url().endsWith("/api/v1/config/validate")) requests.push(request.postDataJSON()); });
  await page.goto("/");
  const run = page.locator(".run-submit-button");
  await expect(run).toBeEnabled();
  const before = await run.evaluate(node => node.outerHTML);
  for (const [open, dialog] of [[".shared-settings-open-button", ".shared-settings-dialog"], [".strategy-card-open", ".strategy-dialog"]]) {
    const count = requests.length;
    await page.locator(open).click();
    await page.locator(`${dialog} .dialog-done`).click();
    await expect(page.locator(dialog)).toBeHidden();
    expect(await run.evaluate(node => node.outerHTML)).toBe(before);
    await page.waitForTimeout(400);
    expect(requests.length).toBe(count + 1);
  }
});
