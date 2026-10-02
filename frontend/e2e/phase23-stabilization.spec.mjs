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

test("selected comparison rows lift forward without shifting table columns or row layout", async ({ page }) => {
  const saved = await savedRun(page);
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: saved }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const rows = page.locator("#result-panel-comparison tbody tr");
  const monthly = rows.filter({ hasText: "毎月定額積立" });
  const initial = rows.filter({ hasText: "ボラティリティ積立" });
  await expect(initial).toHaveCSS("translate", "0px -1px");
  const selectedColor = await initial.evaluate(node => getComputedStyle(node).backgroundColor);
  const before = await monthly.evaluate(node => ({ top: node.offsetTop, height: node.offsetHeight, color: getComputedStyle(node).backgroundColor }));
  const columns = await monthly.locator("th, td").evaluateAll(cells => cells.map(cell => ({ left: cell.getBoundingClientRect().left, width: cell.getBoundingClientRect().width })));
  await monthly.locator(".result-select").click();
  await page.mouse.move(1400, 850);
  await expect(monthly).toHaveCSS("translate", "0px -1px");
  await expect(initial).toHaveCSS("translate", "0px -1px");
  await expect(initial).toHaveCSS("background-color", selectedColor);
  await initial.hover();
  await expect(initial).toHaveCSS("background-color", selectedColor);
  await page.mouse.move(1400, 850);
  expect(await monthly.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe("none");
  const after = await monthly.evaluate(node => ({ top: node.offsetTop, height: node.offsetHeight, color: getComputedStyle(node).backgroundColor }));
  expect(after.top).toBe(before.top);
  expect(after.height).toBe(before.height);
  expect(after.color).not.toBe(before.color);
  expect(await monthly.locator("th, td").evaluateAll(cells => cells.map(cell => ({ left: cell.getBoundingClientRect().left, width: cell.getBoundingClientRect().width })))).toEqual(columns);
  await monthly.locator(".result-select").click();
  await expect(monthly).toHaveCSS("translate", "0px");
  await expect(monthly).toHaveCSS("box-shadow", "none");
  await monthly.locator(".result-select").focus();
  await page.keyboard.press("Enter");
  await expect(monthly.locator(".result-select")).toHaveAttribute("aria-pressed", "true");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(monthly).toHaveCSS("transition-duration", "0s");
  await page.getByRole("button", { name: "中文" }).click();
  const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(report.violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("selected-comparison-forward.png") });
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

test("invalid disabled rules keep their field errors visible and reachable", async ({ page }) => {
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: null }));
  await page.goto("/");
  const runBefore = await page.locator(".run-submit-button").evaluate(node => node.outerHTML);
  await page.locator(".strategy-card-open").click();
  const dialog = page.locator(".strategy-dialog");
  const buy = dialog.locator('[data-rule-side="buy"]');
  const threshold = buy.locator('input[id$="-vix-buyThreshold"]');
  await threshold.fill("-1");
  await buy.locator(".condition-heading").getByRole("switch").click();
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeVisible();
  const rootError = buy.locator(".condition-collapsed-errors").first();
  await expect(rootError).toBeVisible();
  await expect(rootError).toContainText("しきい値");
  await expect(rootError.locator("li")).toHaveCount(1);
  await expect(rootError).toBeFocused();
  await expect(threshold).toBeHidden();
  await buy.locator(".condition-heading").getByRole("switch").click();
  await expect(threshold).toHaveValue("-1");
  await threshold.fill("25.005");
  await buy.locator(".condition-heading").getByRole("switch").click();
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeVisible();
  await expect(rootError).toBeVisible();
  await expect(rootError).toBeFocused();
  await expect(rootError.locator("li")).toHaveCount(1);
  await buy.locator(".condition-heading").getByRole("switch").click();
  await expect(threshold).toHaveValue("25.005");
  await threshold.fill("25");
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeHidden();
  expect(await page.locator(".run-submit-button").evaluate(node => node.outerHTML)).toBe(runBefore);

  await page.getByRole("button", { name: "中文" }).click();
  await page.locator(".add-strategy-button").click();
  await page.locator('[data-preset-id="composite_dca"]').click();
  await page.locator(".strategy-card-open").last().click();
  await buy.locator(".condition-add-select").first().selectOption("rsi");
  const rsi = buy.locator('[data-condition-kind="rsi"]');
  const period = rsi.locator('input[id$="-rsi-period"]');
  await period.fill("0");
  await rsi.getByRole("switch").click();
  await dialog.locator(".dialog-done").click();
  const leafError = rsi.locator(".condition-collapsed-errors");
  await expect(leafError).toBeVisible();
  await expect(leafError).toContainText("RSI 周期");
  await expect(leafError).toBeFocused();
  await buy.locator(".condition-add-select").first().selectOption("group");
  const group = buy.locator(".condition-group:not(.is-root)");
  await rsi.getByRole("switch").click();
  await period.fill("14");
  await group.locator(".condition-add-select").selectOption("ma_deviation");
  const maPeriod = group.locator('input[id$="-ma-period"]');
  await maPeriod.fill("0");
  await group.locator(".condition-card-heading").first().getByRole("switch").click();
  await dialog.locator(".dialog-done").click();
  const groupError = group.locator(".condition-collapsed-errors").first();
  await expect(groupError).toBeVisible();
  await expect(groupError).toContainText("移动平均周期");
  await expect(groupError).toBeFocused();
  await page.setViewportSize({ width: 320, height: 760 });
  await expect(groupError).toContainText("移动平均周期");
  await expect(groupError).toBeInViewport();
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(report.violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("disabled-condition-error.png") });
  await group.locator(".condition-card-heading").first().getByRole("switch").click();
  await expect(maPeriod).toHaveValue("0");
  await maPeriod.fill("200");
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeHidden();
});

test("volatility condition names remain accurate for VXN and VXD", async ({ page }) => {
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: null }));
  await page.goto("/");
  await page.locator(".strategy-card-open").click();
  const dialog = page.locator(".strategy-dialog");
  const buy = dialog.locator('[data-rule-side="buy"]');
  await buy.locator('select[data-parameter-key="vix.symbol"]').selectOption("^VXN");
  await expect(buy.locator(".condition-heading")).toContainText("ボラティリティ");
  await expect(buy.getByLabel("指数買付しきい値", { exact: true })).toBeVisible();
  const sell = dialog.locator('[data-rule-side="sell"]');
  await sell.locator(".condition-heading").getByRole("switch").click();
  await sell.locator('select[data-parameter-key="vix.symbol"]').selectOption("^VXD");
  await expect(sell.getByLabel("売却しきい値 1", { exact: true })).toBeVisible();
  await expect(sell.getByLabel("売却しきい値 2", { exact: true })).toBeVisible();
  await dialog.locator(".dialog-done").click();
  await expect(page.locator(".strategy-nav-card").first()).toContainText("VXN ≥ 25");
  await expect(page.locator(".strategy-nav-card").first()).not.toContainText("VIX:");
  await page.getByRole("button", { name: "中文" }).click();
  await page.locator(".strategy-card-open").click();
  await expect(buy.locator(".condition-heading")).toContainText("波动率");
  await expect(buy.getByLabel("指数买入阈值", { exact: true })).toBeVisible();
  await expect(sell.getByLabel("卖出阈值 1", { exact: true })).toBeVisible();
  await expect(sell.getByLabel("卖出阈值 2", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await sell.getByLabel("卖出阈值 2", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("volatility-tier-labels.png") });
  await dialog.locator(".dialog-done").click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".add-strategy-button").click();
  await page.locator('[data-preset-id="bollinger_dca"]').click();
  await page.locator(".strategy-card-open").last().click();
  await sell.locator(".condition-heading").getByRole("switch").click();
  await sell.locator('select[data-parameter-key="vix.symbol"]').selectOption("^VXN");
  await expect(sell.getByLabel("指数上限", { exact: true })).toBeVisible();
  await expect(sell).toContainText("此条件使用的指数。");
  await dialog.locator(".dialog-done").click();
});

test("custom group choices reserve space for a usable child at catalog limits", async ({ page }) => {
  let maxNodes;
  const countNodes = node => !node ? 0 : 1 + (node.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
  await page.route("**/api/v1/catalog", async route => {
    const response = await route.fetch();
    const catalog = await response.json();
    catalog.conditionLimits.maxDepth = 3;
    maxNodes = Math.max(...catalog.presets.map(preset => countNodes(preset.defaultRules?.buy) + countNodes(preset.defaultRules?.sell))) + 2;
    catalog.conditionLimits.maxNodes = maxNodes;
    await route.fulfill({ json: catalog });
  });
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: null }));
  await page.goto("/");
  await page.locator(".add-strategy-button").click();
  await page.locator('[data-preset-id="composite_dca"]').click();
  await page.locator(".strategy-card-open").last().click();
  const dialog = page.locator(".strategy-dialog");
  const buy = dialog.locator('[data-rule-side="buy"]');
  const rootSelect = buy.locator(".condition-group.is-root > .condition-group-content > .condition-add > .condition-add-select");
  await rootSelect.selectOption("group");
  const nested = buy.locator(".condition-group:not(.is-root)").first();
  await expect(nested.locator('.condition-add-select option[value="group"]')).toBeDisabled();
  await expect(nested.locator('.condition-add-select option[value="rsi"]')).toBeEnabled();
  await nested.locator(".condition-add-select").selectOption("rsi");
  await nested.locator(".condition-remove").last().click();
  const nodeCount = () => dialog.locator(".condition-card, .condition-group").count();
  for (let count = await nodeCount(); count < maxNodes - 1; count++) {
    await rootSelect.selectOption("group");
    await expect.poll(nodeCount).toBe(count + 1);
  }
  await expect(rootSelect.locator('option[value="group"]')).toBeDisabled();
  await expect(rootSelect.locator('option[value="rsi"]')).toBeEnabled();
  await rootSelect.selectOption("rsi");
  await expect(rootSelect).toBeDisabled();
  await buy.locator('[data-condition-kind="rsi"] .condition-remove').click();
  await expect(rootSelect).toBeEnabled();
  await expect(rootSelect.locator('option[value="group"]')).toBeDisabled();
  await buy.locator(".condition-group:not(.is-root)").last().locator(".condition-remove").click();
  await expect(rootSelect.locator('option[value="group"]')).toBeEnabled();
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeHidden();
});

test("buy-only templates omit the unused sell section while custom strategies keep both", async ({ page }) => {
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: null }));
  await page.goto("/");
  await page.locator(".add-strategy-button").click();
  await page.locator('[data-preset-id="ma_buy_only"]').click();
  await page.locator(".strategy-card-open").last().click();
  const dialog = page.locator(".strategy-dialog");
  await expect(dialog.locator('[data-rule-side="buy"]')).toBeVisible();
  await expect(dialog.locator('[data-rule-side="sell"]')).toHaveCount(0);
  await expect(dialog.locator(".strategy-parameter-group").first()).toContainText("買付の上限");
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeHidden();
  await page.locator(".add-strategy-button").click();
  await page.locator('[data-preset-id="composite_dca"]').click();
  await page.locator(".strategy-card-open").last().click();
  await expect(dialog.locator(".strategy-rule-section")).toHaveCount(2);
  await expect(dialog.locator('[data-rule-side="sell"] .condition-heading [role="switch"]')).toBeVisible();
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeHidden();
});

test("editable grid values freeze into search results, candidate curves and CSV", async ({ page }) => {
  await page.goto("/");
  await page.locator(".shared-settings-open-button").click();
  await page.locator('input[data-parameter-key="run.startDate"]').fill("2024-01-31");
  await page.locator('input[data-parameter-key="run.endDate"]').fill("2024-03-01");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await expect(page.locator(".shared-settings-dialog")).toBeHidden();
  await page.locator(".add-strategy-button").click();
  await page.locator('[data-preset-id="grid_search"]').click();
  await page.locator(".strategy-card-open").last().click();
  const dialog = page.locator(".strategy-dialog");
  const editor = dialog.locator(".search-dimension-editor");
  // This fixture provides prices and VIX; the real-data gate covers suppliers.
  for (const card of await dialog.locator('[data-rule-side="buy"] .condition-card').all()) {
    const toggle = card.getByRole("switch");
    if (await card.getAttribute("data-condition-kind") !== "vix" && await toggle.getAttribute("aria-checked") === "true") await toggle.click();
  }
  await expect(editor.locator(".search-dimension-toggle")).toHaveCount(3);
  await editor.locator('[data-dimension-key="rsi.buyThreshold"]').click();
  await editor.locator('[data-dimension-key="accumulation.cashSafetyLimit"]').click();
  const values = editor.locator('input[data-parameter-key="search.values.vix.buyThreshold"]');
  await expect(values).toHaveCount(4);
  await values.nth(0).fill("29");
  await values.nth(1).fill("31");
  await values.nth(3).locator("xpath=../..").getByRole("button").click();
  await values.nth(2).locator("xpath=../..").getByRole("button").click();
  await expect(editor.locator(".search-combination-count")).toContainText("2");
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeHidden();
  const finished = page.waitForResponse(r => r.ok() && r.request().method() === "GET" && /\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(r.url()));
  await page.locator(".run-submit-button").click();
  const saved = await (await finished).json();
  const grid = saved.result.strategyRuns.find(item => item.presetId === "grid_search");
  expect(grid.searchResult.totalCandidateCount).toBe(2);
  expect(grid.searchResult.dimensions[0].values.map(Number)).toEqual([29, 31]);
  const frozen = saved.snapshot.config.strategies.find(item => item.presetId === "grid_search");
  expect(frozen.params["search.values.vix.buyThreshold"].map(Number)).toEqual([29, 31]);
  await page.locator(".comparison-table tbody tr").filter({ hasText: "グリッド検索" }).click();
  await page.getByRole("tab", { name: "検索結果", exact: true }).click();
  await expect(page.locator(".search-table tbody tr")).toHaveCount(2);
  await page.locator(".search-table tbody tr").last().locator("button").click();
  await expect(page.locator(".chart-overlay polyline.overlay-totalAsset")).toHaveAttribute("points", /\d+[.,\d ]+/);
  const csv = await page.request.get(`/api/v1/runs/${saved.runId}/export/search-results?focusedResultId=${encodeURIComponent(grid.id)}`);
  expect(csv.ok()).toBe(true);
  const lines = (await csv.text()).trim().split(/\r?\n/);
  const valueColumn = lines[0].split(",").indexOf("vix.buyThreshold");
  expect(valueColumn).toBeGreaterThan(0);
  expect(lines.slice(1).map(line => Number(line.split(",")[valueColumn]))).toEqual([29, 31]);
  await page.locator(".strategy-card-open").last().click();
  await values.first().fill("45");
  const stillSaved = await (await page.request.get(`/api/v1/runs/${saved.runId}`)).json();
  expect(stillSaved.result.strategyRuns.find(item => item.presetId === "grid_search").searchResult.dimensions[0].values.map(Number)).toEqual([29, 31]);
});

test("grid value errors focus their input and inactive dimensions retain edits", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await page.locator(".add-strategy-button").click();
  await page.locator('[data-preset-id="grid_search"]').click();
  await page.locator(".strategy-card-open").last().click();
  const dialog = page.locator(".strategy-dialog");
  const editor = dialog.locator(".search-dimension-editor");
  const card = editor.locator(".search-value-card").filter({ has: page.locator('input[data-parameter-key="search.values.vix.buyThreshold"]') });
  await card.locator(".text-button").click();
  const added = card.locator('input[type="number"]').last();
  await dialog.locator(".dialog-done").click();
  await expect(added).toBeFocused();
  await expect(card.locator(".field-error")).toBeVisible();
  await added.fill("40");
  const toggle = editor.locator('[data-dimension-key="vix.buyThreshold"]');
  await toggle.click();
  await expect(added).toHaveCount(0);
  await toggle.click();
  await expect(added).toHaveValue("40");
  const maximum = editor.locator('input[data-parameter-key="search.maxCombinations"]');
  await maximum.fill("1");
  await dialog.locator(".dialog-done").click();
  await expect(maximum).toBeFocused();
  await expect(editor.locator(".field-error")).toBeVisible();
  await maximum.fill("1000");
  await page.setViewportSize({ width: 320, height: 740 });
  const geometry = await dialog.evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: innerWidth }));
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  await expect(dialog.locator(".dialog-done")).toBeInViewport();
  const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(report.violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("grid-values-320.png") });
  await dialog.locator(".dialog-done").click();
  await expect(dialog).toBeHidden();
});
