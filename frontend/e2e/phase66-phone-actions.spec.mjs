import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { savedRun } from "./helpers/reports.mjs";

test("touch phone keeps run, reset and active Stop directly in the navigation", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
  let release;
  try {
    const page = await context.newPage();
    const saved = await savedRun(page);
    const active = structuredClone(saved);
    active.status = active.result.status = "running";
    active.progress.completedStrategies = 1;
    active.progress.currentStrategyId = active.result.strategyRuns[1].id;
    for (const row of active.result.strategyRuns.slice(1)) row.status = "running";
    const stopped = structuredClone(active);
    stopped.status = stopped.result.status = "cancelled";
    stopped.progress.completedStrategies = stopped.result.strategyRuns.length;
    stopped.progress.currentStrategyId = null;
    for (const row of stopped.result.strategyRuns.slice(1)) row.status = "cancelled";
    const stopGate = new Promise(resolve => { release = resolve; });
    let stopRequests = 0;
    await page.route("**/api/v1/runs", route => route.fulfill({ status: 202, json: active }));
    await page.route(`**/api/v1/runs/${saved.runId}`, route => route.fulfill({ json: stopped }));
    await page.route(`**/api/v1/runs/${saved.runId}/events`, async route => {
      await stopGate;
      await route.fulfill({ contentType: "text/event-stream", body: `event: terminal\ndata: ${JSON.stringify({
        runId: saved.runId, status: stopped.status, progress: stopped.progress,
        strategyStatuses: Object.fromEntries(stopped.result.strategyRuns.map(row => [row.id, row.status])),
      })}\n\n` });
    });
    await page.route(`**/api/v1/runs/${saved.runId}/stop`, async route => {
      stopRequests++; await route.fulfill({ json: stopped }); release();
    });
    await page.goto(baseURL);
    await expect(page.locator(".app-topbar > .execution-actions")).toBeVisible();
    await expect(page.locator(".run-submit-button")).toBeEnabled();
    await expect(page.locator(".run-reset-button")).toBeVisible();
    await expect(page.locator(".run-stop-button")).toHaveCount(0);
    await expect(page.locator(".topbar-functions")).toBeHidden();
    await page.locator(".run-submit-button").tap();
    await expect(page.locator(".run-stop-button")).toBeEnabled();
    await expect(page.locator(".run-submit-button")).toBeDisabled();
    await expect(page.locator(".run-reset-button")).toBeDisabled();
    for (const width of [320, 360, 390, 767]) {
      await page.setViewportSize({ width, height: 640 });
      const brand = await page.locator(".topbar-brand").boundingBox();
      const actions = await page.locator(".execution-actions").boundingBox();
      const toggle = await page.locator(".topbar-menu-toggle").boundingBox();
      expect(brand.x + brand.width).toBeLessThanOrEqual(actions.x);
      expect(actions.x + actions.width).toBeLessThanOrEqual(toggle.x);
      expect(Math.abs(actions.y + actions.height / 2 - toggle.y - toggle.height / 2)).toBeLessThan(2);
      expect((await page.locator(".app-topbar").boundingBox()).height).toBeLessThanOrEqual(56);
      for (const button of await page.locator(".execution-actions > button").all()) {
        const box = await button.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await expect(page.locator(".topbar-menu-toggle")).toHaveAttribute("aria-expanded", "false");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
    await page.setViewportSize({ width: 320, height: 640 });
    await page.screenshot({ path: test.info().outputPath("phone-nav-running.png") });
    await page.locator(".run-stop-button").tap();
    await expect(page.locator(".run-submit-button")).toBeEnabled();
    await expect(page.locator(".run-stop-button")).toHaveCount(0);
    expect(stopRequests).toBe(1);
    await expect(page.locator(".run-reset-button")).toBeEnabled();
    await page.locator(".run-reset-button").tap();
    await expect(page.locator(".empty-results")).toBeVisible();
    await expect(page.locator(".run-reset-button")).toBeDisabled();
    await expect(page.locator(".topbar-functions")).toBeHidden();
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  } finally { release?.(); await context.close(); }
});

test("phone preferences unfold as labeled vertical rows and leave execution visible", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  const toggle = page.locator(".topbar-menu-toggle");
  await toggle.focus(); await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.locator(".package-actions button").first()).toBeFocused();
  for (const locale of ["ja", "zh", "en"]) {
    await page.locator(".locale-select").selectOption(locale);
    await expect(page.locator(".topbar-setting-label")).toHaveCount(3);
    await expect(page.locator(".topbar-functions .execution-actions")).toHaveCount(0);
    await expect(page.locator(".app-topbar > .execution-actions")).toBeVisible();
    const rows = await page.locator(".package-actions button, .topbar-setting").evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
    }));
    expect(rows).toHaveLength(5);
    for (let index = 1; index < rows.length; index++) {
      expect(rows[index].top).toBeGreaterThanOrEqual(rows[index - 1].bottom);
      expect(rows[index].left).toBeCloseTo(rows[0].left, 1);
      expect(rows[index].right).toBeCloseTo(rows[0].right, 1);
    }
    const panel = await page.locator(".topbar-functions").boundingBox();
    expect(panel.y + panel.height).toBeLessThanOrEqual(640);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  }
  await page.screenshot({ path: test.info().outputPath("phone-nav-vertical-menu.png") });
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await expect(page.locator(".topbar-functions")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("phone-nav-closed.png") });
  await page.setViewportSize({ width: 1024, height: 740 });
  await expect(toggle).toBeHidden();
  await expect(page.locator(".theme-select")).toBeVisible();
  await expect(page.locator(".locale-select")).toBeVisible();
  for (const label of await page.locator(".topbar-setting-label").all()) await expect(label).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1024);
});
