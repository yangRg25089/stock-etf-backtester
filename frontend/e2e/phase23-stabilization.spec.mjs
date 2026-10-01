import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function savedRun(page) {
  const accepted = await page.request.post("/api/v1/runs", { headers: { "Idempotency-Key": `phase23-${Date.now()}` }, data: {
    draft: { shared: { run: { symbol: "QQQ", startDate: "2024-01-31", endDate: "2024-03-01" }, contribution: { amount: 100, day: 1 } },
      strategies: [{ id: "strategy-vix_dca-1", presetId: "vix_dca", params: {} }] }, scope: "all_enabled",
  } });
  expect(accepted.status()).toBe(202);
  const { runId } = await accepted.json();
  let saved;
  await expect.poll(async () => { saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json(); return saved.status; }).toMatch(/^completed/);
  return saved;
}

test("selected strategy cards keep whole-card hover color and remove the unselected indent", async ({ page }) => {
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: null }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".add-strategy-button").click();
  await page.locator('[data-preset-id="ma_trend"]').click();
  const first = page.locator(".strategy-nav-card").first();
  const last = page.locator(".strategy-nav-card").last();
  await expect(first).not.toHaveClass(/is-active/);
  await expect(first).toHaveCSS("margin-inline-start", "8px");
  await expect(last).toHaveCSS("margin-inline-start", "0px");
  const baseline = await first.evaluate(node => getComputedStyle(node).backgroundColor);
  const inactiveHeight = (await first.boundingBox()).height;
  const selectedColor = await last.evaluate(node => getComputedStyle(node).backgroundColor);
  await first.locator(".strategy-card-open").hover();
  await expect(first).toHaveCSS("background-color", selectedColor);
  const hover = await first.evaluate(node => getComputedStyle(node).backgroundColor);
  expect(hover).not.toBe(baseline);
  await first.locator(".strategy-card-open").click();
  await page.locator(".strategy-dialog .dialog-done").click();
  await expect(page.locator(".strategy-dialog")).toBeHidden();
  await page.mouse.move(1400, 850);
  await expect(first).toHaveClass(/is-active/);
  await expect(first).toHaveCSS("margin-inline-start", "0px");
  await expect(first).toHaveCSS("background-color", hover);
  await expect(last).toHaveCSS("margin-inline-start", "8px");
  await expect(first.locator(".strategy-card-actions")).toHaveCSS("opacity", "0");
  const active = await first.boundingBox();
  const inactive = await last.boundingBox();
  expect(inactive.x - active.x).toBeGreaterThanOrEqual(8);
  expect(active.width).toBeGreaterThan(inactive.width);
  expect(active.height).toBeGreaterThan(inactiveHeight);
  expect(await first.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe("none");
  await page.getByRole("button", { name: "中文" }).click();
  await expect(first).toHaveCSS("background-color", hover);
  await expect(first.locator(".strategy-card-open")).toHaveAttribute("aria-current", "true");
  const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(report.violations).toEqual([]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(first).toHaveCSS("transition-duration", "0s");
  await page.screenshot({ path: test.info().outputPath("selected-whole-card.png") });
});

test("all permitted results fit a bounded comparison with a sticky header and reachable rows", async ({ page }) => {
  const saved = await savedRun(page);
  const template = saved.result.strategyRuns[0];
  // Density fixture expands saved identities, leaving calculation checks to backend tests.
  const fixed = ["rsi_dca", "ma_deviation_dca", "ma_trend", "ma_buy_only", "bollinger_dca", "rate_dca", "pe_dca", "grid_search"];
  const extra = [...fixed.map((presetId, index) => ({ ...structuredClone(template), id: `fixed-${index}`, presetId })),
    ...Array.from({ length: 10 }, (_, index) => ({ ...structuredClone(template), id: `custom-${index}`, presetId: "composite_dca", instanceNumber: index + 1 }))];
  saved.result.strategyRuns = [template, ...extra, ...saved.result.strategyRuns.slice(1)];
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: saved }));
  for (const [width, height] of [[1920, 1080], [1440, 900], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const scroller = page.locator(".comparison-table-scroll");
    await expect(scroller.locator("tbody tr")).toHaveCount(21);
    const geometry = await scroller.evaluate(node => ({ client: node.clientHeight, scroll: node.scrollHeight }));
    expect(geometry.client).toBeLessThanOrEqual(300);
    expect(geometry.scroll).toBeGreaterThan(geometry.client);
    expect((await page.locator("#result-chart-panel").boundingBox()).y).toBeLessThan(height * 0.65);
    const header = scroller.locator("thead");
    const top = (await header.boundingBox()).y;
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
    expect((await header.boundingBox()).y).toBeCloseTo(top, 0);
    await scroller.locator("tbody tr").last().locator("button").focus();
    await expect(scroller.locator("tbody tr").last().locator("button")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(scroller.locator("tbody tr").last().locator("button")).toHaveAttribute("aria-pressed", "true");
    await scroller.locator("thead th").first().locator("button").click();
    await expect(scroller.locator("thead th").first()).toHaveAttribute("aria-sort", "ascending");
    await expect(scroller).toHaveAttribute("tabindex", "0");
    await page.screenshot({ path: test.info().outputPath(`many-results-${width}.png`) });
  }
});

test("tablet topbars keep brand, run actions and locale on one row without page overflow", async ({ browser }) => {
  for (const hasTouch of [false, true]) {
    const context = await browser.newContext({ hasTouch });
    const page = await context.newPage();
    await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: null }));
    for (const width of [768, 1024, 1279]) {
      await page.setViewportSize({ width, height: 768 });
      await page.goto("/");
      await expect(page.locator(".run-submit-button")).toBeVisible();
      const header = await page.locator(".app-topbar").boundingBox();
      expect(header.height).toBeLessThanOrEqual(55);
      const brand = await page.locator(".topbar-brand").boundingBox();
      const actions = await page.locator(".execution-actions").boundingBox();
      expect(Math.abs(brand.y + brand.height / 2 - actions.y - actions.height / 2)).toBeLessThan(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      if (hasTouch) expect((await page.locator(".run-submit-button").boundingBox()).height).toBeGreaterThanOrEqual(44);
      await page.getByRole("button", { name: "中文" }).click();
      expect((await page.locator(".app-topbar").boundingBox()).height).toBeLessThanOrEqual(55);
    }
    await context.close();
  }
});

test("native numeric validation stays visible and focuses the invalid strategy input", async ({ page }) => {
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: null }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const runBefore = await page.locator(".run-submit-button").evaluate(node => node.outerHTML);
  await page.locator(".strategy-card-open").click();
  const dialog = page.locator(".strategy-dialog");
  const threshold = dialog.locator('input[id$="-vix-buyThreshold"]');
  await threshold.fill("25.005");
  expect(await threshold.evaluate(node => node.validity.stepMismatch)).toBe(true);
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeVisible();
  await expect(threshold).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.locator(".field").filter({ has: page.locator('input[id$="-vix-buyThreshold"]') }).locator(".field-error")).toBeVisible();
  await expect(threshold).toBeFocused();
  expect(await page.locator(".run-submit-button").evaluate(node => node.outerHTML)).toBe(runBefore);
  await threshold.fill("25.01");
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeHidden();
});

test("dialog validation has a busy indicator and prevents duplicate closing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  for (const kind of ["shared-settings", "strategy"]) {
    await page.locator(kind === "strategy" ? ".strategy-card-open" : ".shared-settings-open-button").click();
    const dialog = page.locator(`.${kind}-dialog`);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let requests = 0;
    await page.route("**/api/v1/config/validate", async route => {
      requests++;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    try {
      await dialog.locator(".dialog-done").click();
      await expect(dialog.locator(".dialog-fields")).toHaveAttribute("disabled", "");
      await expect(dialog.locator("input").first()).toBeDisabled();
      await expect(dialog.locator(".dialog-done")).toHaveAttribute("aria-busy", "true");
      await expect(dialog.locator(".dialog-done .run-button-spinner")).toBeVisible();
      await expect(dialog.locator(`.${kind}-dialog-close`)).toBeDisabled();
      await page.keyboard.press("Escape");
      expect(requests).toBe(1);
    } finally { release(); }
    await expect(dialog).toBeHidden();
    await page.unroute("**/api/v1/config/validate");
  }
});

test("native errors remain attached to their condition when another side has the same parameter error", async ({ page }) => {
  await page.goto("/");
  await page.locator(".add-strategy-button").click();
  await page.locator('[data-preset-id="composite_dca"]').click();
  await page.locator(".strategy-card-open").last().click();
  const dialog = page.locator(".strategy-dialog");
  const buy = dialog.locator('[data-rule-side="buy"]');
  const sell = dialog.locator('[data-rule-side="sell"]');
  await buy.locator(".condition-add-select").first().selectOption("rsi");
  await sell.locator(".condition-heading").getByRole("switch").click();
  await sell.locator(".condition-add-select").first().selectOption("rsi");
  const buyPeriod = buy.locator('input[id$="-rsi-period"]');
  const sellPeriod = sell.locator('input[id$="-rsi-period"]');
  await buyPeriod.fill("14.5");
  await sellPeriod.fill("0");
  await dialog.locator(".dialog-done").click();
  await expect(buyPeriod).toHaveAttribute("aria-invalid", "true");
  await expect(sellPeriod).toHaveAttribute("aria-invalid", "true");
  await expect(buyPeriod).toBeFocused();
  await buyPeriod.fill("14");
  await sellPeriod.fill("14");
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeHidden();
});

test("disabled rules stay compact, retain their parameters and expand from their switches", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".strategy-card-open").click();
  const dialog = page.locator(".strategy-dialog");
  const sell = dialog.locator('[data-rule-side="sell"]');
  await expect(sell.locator(".strategy-parameter-grid")).toBeHidden();
  const switchButton = sell.locator(".condition-heading").getByRole("switch");
  await switchButton.click();
  const threshold = sell.locator('input[id$="-exit-vix-low1"]');
  await threshold.fill("11");
  await switchButton.click();
  await expect(sell.locator(".strategy-parameter-grid")).toBeHidden();
  await switchButton.click();
  await expect(threshold).toBeVisible();
  await expect(threshold).toHaveValue("11");
  await switchButton.click();
  const geometry = await dialog.locator(".strategy-dialog-content").evaluate(node => ({ client: node.clientHeight, scroll: node.scrollHeight }));
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeHidden();
  await page.locator(".add-strategy-button").click();
  await page.locator('[data-preset-id="composite_dca"]').click();
  await page.locator(".strategy-card-open").last().click();
  const card = dialog.locator('[data-rule-side="buy"] .condition-card').first();
  await card.getByRole("switch").click();
  await expect(card.locator(".strategy-parameter-grid")).toBeHidden();
  expect((await card.boundingBox()).height).toBeLessThanOrEqual(80);
  await card.getByRole("switch").click();
  await expect(card.locator('input[id$="-vix-buyThreshold"]')).toBeVisible();
  await expect(card.locator('input[id$="-vix-buyThreshold"]')).toHaveValue("25");
  const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(report.violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("compact-strategy-dialog.png") });
});
