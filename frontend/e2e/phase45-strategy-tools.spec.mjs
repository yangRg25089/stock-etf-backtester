import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { savedRun } from "./helpers/reports.mjs";
import { installRunFixture } from "./helpers/runtime.mjs";

test("direct strategy copy and editor reset preserve results, identity and buffered edits", async ({ page }) => {
  const saved = await savedRun(page);
  await installRunFixture(page, saved);
  await page.setViewportSize({ width: 1440, height: 900 });
  const restored = page.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith(`/api/v1/runs/${saved.runId}`));
  await page.goto("/");
  await restored;
  await expect(page.locator(".comparison-table tbody tr").filter({ hasText: "ボラティリティ" }).locator("td").first()).not.toHaveText("—");
  const oldResults = await page.locator(".comparison-table").textContent();
  let submissions = 0;
  await page.route("**/api/v1/runs", route => { submissions++; return route.abort(); });

  await page.locator(".add-strategy-button").click();
  await page.locator('.strategy-add-option[data-preset-id="composite_dca"]').click();
  const original = page.locator(".strategy-card").nth(1);
  await original.locator(".strategy-card-open").click();
  const editor = page.locator(".strategy-dialog");
  await editor.locator('[data-parameter-key="accumulation.cashSafetyLimit"]').fill("987");
  await editor.locator('[data-parameter-key="vix.buyThreshold"]').first().fill("27");
  await editor.locator(".dialog-done").click();

  await original.hover();
  await original.locator(".strategy-copy").click();
  await expect(page.locator(".strategy-card")).toHaveCount(3);
  const copied = page.locator(".strategy-card").nth(2);
  await expect(copied).toHaveClass(/is-active/);
  await expect(copied.locator(".strategy-card-name")).toContainText(/2$/);
  await copied.locator(".strategy-card-open").click();
  await expect(editor.locator('[data-parameter-key="accumulation.cashSafetyLimit"]')).toHaveValue("987");
  await expect(editor.locator('[data-parameter-key="vix.buyThreshold"]').first()).toHaveValue("27");
  await editor.locator(".dialog-done").click();

  await original.locator(".strategy-card-open").click();
  await editor.locator('[data-parameter-key="accumulation.cashSafetyLimit"]').fill("500");
  await editor.locator(".strategy-dialog-reset").click();
  const confirmation = editor.locator(".strategy-reset-confirmation");
  await expect(confirmation).toContainText("現在の設定を初期値に戻しますか？");
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(editor.locator('[data-parameter-key="accumulation.cashSafetyLimit"]')).toHaveValue("500");
  await editor.locator(".strategy-dialog-reset").click();
  await editor.locator(".strategy-reset-confirmation .button-primary").click();
  await expect(editor.locator('[data-parameter-key="accumulation.cashSafetyLimit"]')).toHaveValue("1200");
  await expect(editor.locator('[data-parameter-key="vix.buyThreshold"]').first()).toHaveValue("25");
  await editor.locator(".dialog-done").click();

  await expect(page.locator(".comparison-table")).toHaveText(oldResults);
  expect(submissions).toBe(0);
  const downloading = page.waitForEvent("download");
  await page.locator(".package-actions button").first().click();
  const file = JSON.parse(await readFile(await (await downloading).path(), "utf8"));
  const custom = file.draft.strategies.filter(row => row.presetId === "composite_dca");
  expect(custom.map(row => row.instanceNumber)).toEqual([1, 2]);
  expect(custom[0].id).not.toBe(custom[1].id);
  expect(Number(custom[0].params["accumulation.cashSafetyLimit"])).toBe(1200);
  expect(Number(custom[1].params["accumulation.cashSafetyLimit"])).toBe(987);

  for (const [language, locale] of [["日本語", "ja"], ["中文", "zh"], ["English", "en"]]) {
    await page.locator(".locale-select").selectOption(locale);
    await page.locator(".strategy-card").first().hover();
    await expect(page.locator(".strategy-copy").first()).toBeEnabled();
    await expect(page.locator(".strategy-more,.strategy-tools-dialog")).toHaveCount(0);
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 850 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});
