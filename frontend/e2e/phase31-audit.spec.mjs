import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("final whole-page and strategy dialog audit includes all accessibility rules", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/api/v1/runs/active", route => route.fulfill({ json: null }));
  const catalog = await (await page.request.get("/api/v1/catalog")).json();
  const presets = catalog.presets.filter(preset => !["monthly_dca", "lump_sum"].includes(preset.id));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  for (const preset of presets.filter(preset => preset.id !== "vix_dca")) {
    await page.locator(".add-strategy-button").click();
    await page.locator(`.strategy-add-option[data-preset-id="${preset.id}"]`).click();
  }
  for (const locale of ["日本語", "中文"]) {
    await page.getByRole("button", { name: locale, exact: true }).click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    for (let index = 0; index < presets.length; index++) {
      await page.locator(".strategy-card-open").nth(index).click();
      await expect(page.locator(".strategy-dialog")).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.locator(".strategy-dialog .dialog-done").click();
      await expect(page.locator(".strategy-dialog")).toBeHidden();
    }
    await page.locator(".shared-settings-open-button").click();
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 740 });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`shared-settings-${locale}-${width}.png`) });
    }
    await page.locator(".shared-settings-dialog .dialog-done").click();
    await expect(page.locator(".shared-settings-dialog")).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  expect(errors).toEqual([]);
});
