import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openSaved } from "./helpers/runtime.mjs";
import { savedRun } from "./helpers/reports.mjs";

const chipFor = (page, id) => page.locator(`.selected-strategy-chip[data-result-id="${id}"]`);

async function selectTwo(page) {
  const saved = await savedRun(page);
  await openSaved(page, saved);
  const ids = saved.result.strategyRuns.slice(0, 2).map(result => result.id);
  for (const id of ids) await page.locator(`.comparison-table tr[data-result-id="${id}"] .result-select`).click();
  await expect(page.locator(".selected-strategy-chip")).toHaveCount(2);
  return { saved, ids };
}

async function expectTarget(page, id) {
  const chip = chipFor(page, id);
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.selected-strategy-chip[aria-current="true"]')).toHaveAttribute("data-result-id", id);
  await expect(page.locator(".result-detail-name")).toContainText(await chip.locator(".selected-strategy-name").innerText());
  await expect(chip).toHaveCSS("border-top-width", "3px");
  await expect(chip.locator(".selected-strategy-detail-label")).toBeVisible();
  await expect(page.locator('.comparison-table .result-select[aria-pressed="true"]')).toHaveCount(2);
}

test("header clicks choose details and repeated clicks preserve the selected curves", async ({ page }) => {
  const { saved, ids } = await selectTwo(page);
  const before = await page.locator('.comparison-table tr.is-selected').evaluateAll(rows => rows.map(row => row.dataset.resultId));
  const chip = chipFor(page, ids[0]);
  await expect(chip).toHaveJSProperty("tagName", "BUTTON");
  let requests = 0;
  page.on("request", () => requests++);
  await chip.click();
  await expectTarget(page, ids[0]);
  await chip.click();
  await expectTarget(page, ids[0]);
  await chipFor(page, ids[1]).click();
  await expectTarget(page, ids[1]);
  expect(await page.locator('.comparison-table tr.is-selected').evaluateAll(rows => rows.map(row => row.dataset.resultId))).toEqual(before);
  expect(requests).toBe(0);
  const restored = await page.request.get(`/api/v1/runs/${saved.runId}`);
  expect((await restored.json()).snapshot).toEqual(saved.snapshot);
});

test("header choices support Enter and Space with stable accessible names in three languages", async ({ page }) => {
  const { ids } = await selectTwo(page);
  for (const locale of ["ja", "zh", "en"]) {
    await page.locator(".locale-select").selectOption(locale);
    const first = chipFor(page, ids[0]), second = chipFor(page, ids[1]);
    const name = await first.getAttribute("aria-label");
    await first.focus();
    await page.keyboard.press("Enter");
    await expectTarget(page, ids[0]);
    await expect(first).toBeFocused();
    await expect(first).toHaveAttribute("aria-label", name);
    await expect(first).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Space");
    await expectTarget(page, ids[0]);
    await second.focus();
    await page.keyboard.press("Space");
    await expectTarget(page, ids[1]);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  }
});

test("touch header choices remain on one scrollable row with full targets at 320px", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    const { ids } = await selectTwo(page);
    await page.setViewportSize({ width: 320, height: 740 });
    await page.locator(".workbench-config").scrollIntoViewIfNeeded();
    await expect(page.locator(".workbench-layout")).not.toHaveAttribute("data-mobile-panel");
    for (const id of ids) {
      const chip = chipFor(page, id);
      await chip.tap();
      await expectTarget(page, id);
      await expect(page.locator(".workbench-layout")).not.toHaveAttribute("data-mobile-panel");
      const target = await chip.boundingBox(), strip = await page.locator(".selected-strategies").boundingBox();
      expect(target.height).toBeGreaterThanOrEqual(44);
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.x).toBeGreaterThanOrEqual(strip.x - 1);
      expect(target.x + target.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
    }
    const rows = await page.locator(".selected-strategy-chip").evaluateAll(chips => new Set(chips.map(chip => Math.round(chip.getBoundingClientRect().top))).size);
    expect(rows).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.screenshot({ path: test.info().outputPath("phone-header-selection.png") });
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  } finally { await context.close(); }
});

test("header choices keep the target locked while a submission is pending", async ({ page }) => {
  const { ids } = await selectTwo(page);
  let release;
  await page.route("**/api/v1/runs", async route => {
    await new Promise(resolve => { release = resolve; });
    await route.abort();
  });
  try {
    await page.locator(".run-submit-button").click();
    await expect(page.locator(".run-stop-button")).toBeVisible();
    await expect(chipFor(page, ids[0])).toBeDisabled();
    await expect(chipFor(page, ids[1])).toBeDisabled();
    await expectTarget(page, ids[1]);
    await chipFor(page, ids[0]).evaluate(button => button.click());
    await expectTarget(page, ids[1]);
  } finally {
    if (release) release();
  }
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await expect(chipFor(page, ids[0])).toBeEnabled();
  await chipFor(page, ids[0]).click();
  await expectTarget(page, ids[0]);
});
