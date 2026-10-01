import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("formal design prototype fits the viewport and mirrors dialog and chart controls", async ({ page }) => {
  const markup = await readFile(new URL("../../docs/design/backtest-ui.html", import.meta.url), "utf8");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("about:blank");
  await page.setContent(`<html lang="ja"><head><title>Workbench reference</title></head><body>${markup}</body></html>`);
  for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 720], [320, 700]]) {
    await page.setViewportSize({ width, height });
    const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(width);
    if (width >= 768) expect(geometry.scrollHeight).toBeLessThanOrEqual(height + 1);
    const chartWidths = await page.locator(".chart-figure svg, .date-axis-row svg").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
    expect(chartWidths).toHaveLength(4);
    expect(Math.max(...chartWidths) - Math.min(...chartWidths)).toBeLessThanOrEqual(1);
    await expect(page.locator(".compact-indicator figcaption")).toHaveCount(0);
    await expect(page.locator(".chart-figure figcaption .legend")).toHaveCount(1);
    const cursorLines = page.locator(".compact-indicator .cursor-example line");
    await expect(cursorLines).toHaveCount(2);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const toggle = page.locator("#prototype-config-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await page.locator("#prototype-open-settings").click();
  await expect(page.locator(".shared-dialog")).toBeVisible();
  await page.locator(".shared-dialog .dialog-done").click();
  await page.locator(".strategy-card-open").first().click();
  const dialog = page.locator(".strategy-dialog");
  await dialog.getByRole("radio", { name: "OR", exact: true }).check();
  await expect(dialog.getByRole("radio", { name: "OR", exact: true })).toBeChecked();
  const buy = dialog.getByRole("switch", { name: "VIX買付シグナル", exact: true });
  await buy.click();
  await expect(buy).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(axe.violations).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("formal-workbench-reference.png") });
});
