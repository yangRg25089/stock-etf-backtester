import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openSaved, strategyFile } from "./helpers/runtime.mjs";
import { savedRun } from "./helpers/reports.mjs";

test("phone header keeps brand, execution and strategy choices while preferences are collapsed", async ({ page }) => {
  const saved = await savedRun(page);
  await openSaved(page, saved);
  await page.locator(".comparison-table .result-select").first().click();
  for (const width of [320, 360, 390, 767]) {
    await page.setViewportSize({ width, height: 740 });
    await expect(page.locator(".topbar-brand")).toBeVisible();
    await expect(page.locator(".selected-strategies")).toBeVisible();
    await expect(page.locator(".topbar-menu-toggle")).toBeVisible();
    await expect(page.locator(".app-topbar > .execution-actions")).toBeVisible();
    for (const selector of [".package-actions", ".theme-select", ".locale-select", ".return-color-control"]) {
      await expect(page.locator(selector)).toBeHidden();
    }
    expect((await page.locator(".app-topbar").boundingBox()).height).toBeLessThanOrEqual(112);
    if (width === 320) await page.screenshot({ path: test.info().outputPath("phone-navigation-closed.png") });
    await page.locator(".topbar-menu-toggle").click();
    await expect(page.locator(".topbar-menu-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".run-submit-button")).toBeVisible();
    await expect(page.locator(".package-actions")).toBeVisible();
    await expect(page.locator(".theme-select")).toBeVisible();
    const panel = await page.locator(".topbar-functions").boundingBox();
    expect(panel.x).toBeGreaterThanOrEqual(8);
    expect(panel.x + panel.width).toBeLessThanOrEqual(width - 8 + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if (width === 320) await page.screenshot({ path: test.info().outputPath("phone-navigation-menu.png") });
    await page.keyboard.press("Escape");
    await expect(page.locator(".topbar-menu-toggle")).toBeFocused();
    await expect(page.locator(".topbar-functions")).toBeHidden();
  }
  await page.setViewportSize({ width: 1024, height: 740 });
  await expect(page.locator(".topbar-menu-toggle")).toBeHidden();
  await expect(page.locator(".execution-actions")).toBeVisible();
});

test("phone menu works by keyboard and retains focus across nested import dialogs", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  const toggle = page.locator(".topbar-menu-toggle");
  await toggle.focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await page.keyboard.press("Tab");
  await expect(page.locator(".package-actions button").first()).toBeFocused();
  for (const locale of ["ja", "zh", "en"]) {
    await page.locator(".locale-select").selectOption(locale);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  }
  const file = strategyFile(await savedRun(page));
  await page.locator(".file-import-input").setInputFiles({ name: "valid.strategy.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.locator(".package-preview")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".package-preview")).toHaveCount(0);
  await expect(page.locator(".package-actions button").last()).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await toggle.click();
  await page.mouse.click(4, 300);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.focus();
  const choosingFile = page.waitForEvent("filechooser");
  await page.keyboard.press("Control+i");
  await (await choosingFile).setFiles({ name: "shortcut.strategy.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.locator(".package-preview")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".package-preview")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  const choosingInvalidFile = page.waitForEvent("filechooser");
  await page.keyboard.press("Control+i");
  await (await choosingInvalidFile).setFiles({ name: "invalid.strategy.json", mimeType: "application/json", buffer: Buffer.from("{") });
  await expect(page.locator(".package-error")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.locator(".package-error button").click();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("phone strategy list grows with content, caps its height and chains both scroll boundaries", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto("/");
  await page.locator(".workbench-mobile-view").first().click();
  const list = page.locator(".strategy-card-list");
  const initial = await list.evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(initial.height).toBeLessThan(150);
  expect(initial.scrollHeight).toBeLessThanOrEqual(initial.height + 1);
  await page.screenshot({ path: test.info().outputPath("phone-config-single.png") });
  for (let index = 1; index < 10; index++) {
    await page.locator(".add-strategy-button").click();
    await page.locator(".strategy-add-option:not(:disabled)").first().click();
  }
  const grown = await list.evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, overscroll: getComputedStyle(element).overscrollBehaviorY }));
  expect(grown.height).toBeLessThanOrEqual(264);
  expect(grown.scrollHeight).toBeGreaterThan(grown.height);
  expect(grown.overscroll).toBe("auto");
  await page.evaluate(() => window.scrollTo(0, 0));
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await list.hover(); await page.mouse.wheel(0, 180);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await list.evaluate(element => { element.scrollTop = 0; });
  await list.hover(); await page.mouse.wheel(0, -1000);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: test.info().outputPath("phone-config-compact.png") });
});

test("touch swipes at strategy list edges continue into the surrounding page", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 480 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.locator(".workbench-mobile-view").first().tap();
    for (let index = 1; index < 10; index++) {
      await page.locator(".add-strategy-button").tap();
      await page.locator(".strategy-add-option:not(:disabled)").first().tap();
    }
    const list = page.locator(".strategy-card-list");
    const session = await context.newCDPSession(page);
    const swipe = async (direction, distance = 120) => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const bounds = await list.boundingBox();
      const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      await session.send("Input.synthesizeScrollGesture", { x, y, yDistance: distance * direction, gestureSourceType: "touch", speed: 300 });
    };
    const documentSize = await page.evaluate(() => ({ content: document.documentElement.scrollHeight, viewport: window.innerHeight }));
    expect(documentSize.content).toBeGreaterThan(documentSize.viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await list.evaluate(node => { node.scrollTop = 0; });
    await swipe(-1);
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await swipe(-1);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await list.evaluate(node => { node.scrollTop = 0; });
    await swipe(1, 150);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    const bounds = await list.boundingBox();
    await session.send("Input.synthesizeScrollGesture", { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2,
      xDistance: -80, yDistance: 0, gestureSourceType: "touch", speed: 300 });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await list.evaluate(node => node.scrollTop)).toBe(0);
    await list.locator(".strategy-card-open").first().tap();
    await expect(page.locator(".strategy-dialog")).toBeVisible();
    await page.locator(".strategy-dialog .dialog-done").tap();
    await expect(page.locator(".strategy-dialog")).toHaveCount(0);
  } finally { await context.close(); }
});

test("phone result actions and chart controls are compact and table expansion shares its title row", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await openSaved(page, await savedRun(page));
    await page.setViewportSize({ width: 320, height: 740 });
    const heading = await page.locator("#result-details .collapsible-panel-heading").boundingBox();
    const png = await page.locator("[data-report-kind=png]").boundingBox();
    expect(Math.abs(heading.y + heading.height / 2 - png.y - png.height / 2)).toBeLessThan(2);
    const exports = await page.locator("#result-details .collapsible-panel-header").boundingBox();
    expect(exports.height).toBeLessThanOrEqual(152);
    const toolbar = await page.locator(".chart-toolbar").boundingBox();
    expect(toolbar.height).toBeLessThanOrEqual(164);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: test.info().outputPath("phone-results-overview.png") });
    const trades = page.locator(".trade-table-region");
    await trades.scrollIntoViewIfNeeded();
    const title = trades.locator(".table-height-controls-title"), expand = trades.locator(".table-expand-button");
    await expect(title).toBeVisible();
    const text = await title.boundingBox(), button = await expand.boundingBox();
    expect(Math.abs(text.y + text.height / 2 - button.y - button.height / 2)).toBeLessThan(2);
    expect(button.height).toBeGreaterThanOrEqual(44);
    await expand.tap();
    await expect(trades).toHaveClass(/is-height-expanded/);
    await expect(expand).toHaveAttribute("aria-expanded", "true");
    await expand.tap();
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.screenshot({ path: test.info().outputPath("phone-results-compact.png") });
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  } finally { await context.close(); }
});
