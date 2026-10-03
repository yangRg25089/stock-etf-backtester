import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const VIEWPORTS = [320, 375, 767, 768, 1024, 1280, 1440, 1920];

async function themeColor(page, token) {
  return page.evaluate(name => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

async function openSharedSettings(page) {
  await expect(page.locator(".workbench-layout")).toBeVisible();
  if (!(await page.locator(".workbench-config").isVisible())) {
    const mobileConfig = page.locator(".workbench-mobile-view").first();
    if (await mobileConfig.isVisible()) await mobileConfig.click();
    else await page.locator(".workbench-config-toggle").click();
  }
  await page.locator(".shared-settings-open-button").click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function closeSharedSettings(page) {
  const dialog = page.locator(".shared-settings-dialog");
  if (await dialog.isVisible()) {
    await dialog.locator(".dialog-done").click();
    await expect(dialog).toBeHidden();
  }
}

async function closeStrategyDialog(page) {
  const dialog = page.locator(".strategy-dialog");
  if (await dialog.isVisible()) { await dialog.locator(".dialog-done").click(); await expect(dialog).toBeHidden(); }
}

async function addStrategy(page, presetId) {
  const menu = page.locator(".strategy-add-menu");
  const trigger = page.locator(".add-strategy-button");
  if (!(await menu.isVisible())) await trigger.click();
  await menu.locator(`.strategy-add-option[data-preset-id="${presetId}"]`).click();
}

async function controlWheel(page, deltaY) {
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, deltaY);
  await page.keyboard.up("Control");
}

test.describe("responsive product shell", () => {
  for (const width of VIEWPORTS) {
    for (const locale of ["ja", "zh"]) {
      test(`${width}px ${locale} has no page overflow or clipped run controls`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        if (width < 768) {
          await expect(page.locator(".workbench-mobile-views")).toBeVisible();
        } else {
          await expect(page.locator(".workbench-mobile-views")).toBeHidden();
        }
        if (width >= 768 && width <= 1279) {
          await expect(page.locator(".workbench-config")).toBeHidden();
          await expect(page.locator(".workbench-results")).toBeVisible();
        }
        if (locale === "zh") await page.getByRole("button", { name: "中文" }).click();
        await openSharedSettings(page);
        await expect(page.locator(".shared-settings-group legend")).toHaveText(
          locale === "ja" ? ["対象", "期間", "入金計画"] : ["标的", "区间", "投入计划"],
        );
        const sharedSettingsLayout = await page.locator(".shared-settings-grid").evaluate((grid) => {
          const groups = [...grid.querySelectorAll(".shared-settings-group")];
          const assetFields = grid.querySelector(".shared-settings-fields-asset");
          const rangeFields = grid.querySelector(".shared-settings-fields-range");
          const fundingFields = grid.querySelector(".shared-settings-fields-funding");
          return {
            columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
            assetColumns: assetFields ? getComputedStyle(assetFields).gridTemplateColumns.split(" ").length : 0,
            rangeColumns: rangeFields ? getComputedStyle(rangeFields).gridTemplateColumns.split(" ").length : 0,
            fundingColumns: fundingFields ? getComputedStyle(fundingFields).gridTemplateColumns.split(" ").length : 0,
            groupCount: groups.length,
            groupsInSeparateRows: groups.every((group, index) => index === 0 ||
              groups[index - 1].getBoundingClientRect().bottom <= group.getBoundingClientRect().top),
          };
        });
        expect(sharedSettingsLayout.groupCount).toBe(3);
        expect(sharedSettingsLayout.columns).toBe(1);
        expect(sharedSettingsLayout.assetColumns).toBe(1);
        expect(sharedSettingsLayout.rangeColumns).toBe(width <= 767 ? 1 : 2);
        expect(sharedSettingsLayout.fundingColumns).toBe(width <= 767 ? 1 : 2);
        expect(sharedSettingsLayout.groupsInSeparateRows).toBe(true);
        await closeSharedSettings(page);

        const layout = await page.evaluate(() => {
          const controls = [
            document.querySelector(".run-submit-button"),
            document.querySelector(".strategy-add .add-strategy-button"),
            document.querySelector(".app-topbar"),
          ].filter((element) => element instanceof HTMLElement);
          return {
            viewportWidth: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            controls: controls.map((element) => {
              const bounds = element.getBoundingClientRect();
              return {
                left: bounds.left,
                right: bounds.right,
                top: bounds.top,
                bottom: bounds.bottom,
                visible: bounds.width > 0 && bounds.height > 0,
              };
            }),
          };
        });

        expect(layout.documentWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewportWidth);
        expect(layout.controls).toHaveLength(3);
        for (const control of layout.controls) {
          expect(control.visible).toBe(true);
          expect(control.left).toBeGreaterThanOrEqual(0);
          expect(control.right).toBeLessThanOrEqual(width);
        }
        await page.screenshot({ path: test.info().outputPath(`${width}-${locale}.png`), fullPage: true });
      });
    }
  }
});

test("shared settings dialog edits the draft, restores focus, and the sidebar toggle stays fixed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const sidebarToggle = page.locator(".workbench-divider .workbench-config-toggle");
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
  await expect(sidebarToggle).toHaveCSS("background-color", await themeColor(page, "--app-bg"));
  const initialPosition = await sidebarToggle.boundingBox();
  await sidebarToggle.click();
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".workbench-config")).toBeHidden();
  await expect(sidebarToggle).toBeVisible();
  await sidebarToggle.click();
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
  const reopenedPosition = await sidebarToggle.boundingBox();
  expect(reopenedPosition?.x).toBe(initialPosition?.x);
  expect(reopenedPosition?.y).toBe(initialPosition?.y);

  const trigger = page.locator(".shared-settings-summary");
  await expect(trigger).toHaveCount(1);
  await expect(trigger.locator("button, input, select, a")).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  await expect(trigger).toHaveAttribute("aria-describedby", "shared-settings-summary-detail");
  await page.locator(".shared-settings-summary-text").click();
  const dialog = page.locator(".shared-settings-dialog");
  await expect(dialog).toBeVisible();
  await closeSharedSettings(page);
  await expect(trigger).toBeFocused();

  await expect(trigger.locator(".shared-settings-summary-icon")).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("heading", { level: 2 })).toHaveCount(1);
  expect(await dialog.evaluate((element) => element instanceof HTMLDialogElement && element.matches(":modal"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Space");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.locator(".shared-settings-dialog-close").click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.locator("#field-contribution-amount").fill("250");
  await dialog.locator(".dialog-done").click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(page.locator("#field-contribution-amount")).toHaveValue("250");
  await expect(dialog.locator(".dialog-done")).toBeVisible();
  const wideLayout = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const symbol = element.querySelector("#field-run-symbol").getBoundingClientRect();
    const startDate = element.querySelector("#field-run-startDate").getBoundingClientRect();
    const endDate = element.querySelector("#field-run-endDate").getBoundingClientRect();
    return { width: bounds.width, symbolWidth: symbol.width, startWidth: startDate.width, endWidth: endDate.width };
  });
  expect(wideLayout.width).toBeGreaterThanOrEqual(800);
  expect(wideLayout.symbolWidth).toBeGreaterThan(280);
  expect(wideLayout.startWidth).toBeGreaterThan(280);
  expect(wideLayout.endWidth).toBeGreaterThan(280);
  await page.screenshot({ path: test.info().outputPath("settings-dialog-1440.png"), fullPage: true });
  await closeSharedSettings(page);

  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 600 });
    await page.goto("/");
    if (width >= 768) {
      const tabletToggle = page.locator(".workbench-divider .workbench-config-toggle");
      const before = await tabletToggle.boundingBox();
      await tabletToggle.click();
      const after = await tabletToggle.boundingBox();
      expect(after?.x).toBeGreaterThan(before?.x);
      expect(after?.y).toBe(before?.y);
    }
    await openSharedSettings(page);
    const dialogGeometry = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const scroller = element.querySelector(".shared-settings-dialog-content");
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      };
    });
    expect(dialogGeometry.left).toBeGreaterThanOrEqual(0);
    expect(dialogGeometry.right).toBeLessThanOrEqual(dialogGeometry.viewportWidth);
    expect(dialogGeometry.top).toBeGreaterThanOrEqual(0);
    expect(dialogGeometry.bottom).toBeLessThanOrEqual(dialogGeometry.viewportHeight);
    expect(dialogGeometry.scrollHeight).toBeGreaterThan(dialogGeometry.clientHeight);
    await dialog.locator(".shared-settings-dialog-content").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(dialog.locator(".shared-settings-dialog-heading")).toBeInViewport();
    await expect(dialog.locator(".shared-settings-dialog-footer")).toBeInViewport();
    await expect(dialog.locator(".dialog-done")).toBeInViewport();
    await closeSharedSettings(page);
  }
});

test("one fixed topbar owns run and reset without a scope selector", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const topbar = page.locator(".app-topbar");
  await expect(page.locator(".page-heading")).toHaveCount(0);
  await expect(page.locator(".workbench-config-header")).toHaveCount(0);
  await expect(page.locator(".results-heading")).toHaveCount(0);
  await expect(topbar.locator(".execution-actions")).toBeVisible();
  await expect(page.locator(".run-controls, .run-status-panel")).toHaveCount(0);
  await expect(page.locator(".run-submit-button")).toHaveCount(1);

  await expect(page.locator("#run-scope-select, #run-scope-help")).toHaveCount(0);
  const toggle = page.locator(".workbench-config-toggle");
  const before = await toggle.boundingBox();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const collapsedBounds = await toggle.boundingBox();
  expect(collapsedBounds.y).toBe(before.y);
  expect(collapsedBounds.x).toBeLessThan(before.x);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  const postRequests = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/runs")) postRequests.push(request);
  });
  const submitted = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().endsWith("/api/v1/runs"),
  );
  const completed = page.waitForResponse(async (response) => {
    if (response.request().method() !== "GET" || !/\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url())) return false;
    if (!response.ok()) return false;
    return ["completed", "completed_with_warning", "unavailable", "failed"]
      .includes((await response.json()).status);
  });
  await page.getByRole("button", { name: "バックテストを実行" }).click({ clickCount: 2, delay: 60 });
  const payload = (await submitted).postDataJSON();
  expect(payload.scope).toBe("all_enabled");
  expect(payload.activeStrategyId).toBeUndefined();
  await completed;
  expect(postRequests).toHaveLength(1);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await expect(page.locator(".run-submit-button")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".run-complete-feedback, .run-controls, .run-status-panel")).toHaveCount(0);
});

test("legacy execution panels never mount during restored progress, failure, or warnings", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: null }));
  await page.goto("/");
  await openSharedSettings(page);
  await page.getByLabel("開始日").fill("2024-01-31");

  await page.locator("#field-run-endDate").fill("2024-02-02");
  await closeSharedSettings(page);
  const completedResponse = page.waitForResponse(async response => {
    if (!/\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url()) || response.url().endsWith("/runs/latest") || !response.ok()) return false;
    return ["completed", "completed_with_warning", "unavailable", "failed"].includes((await response.json()).status);
  });
  await page.locator(".run-submit-button").click();
  const saved = await (await completedResponse).json();
  expect(saved.status, JSON.stringify(saved.result.strategyRuns.map(result => result.diagnostics))).toBe("completed");
  const removed = ".run-controls, .run-status-panel, .run-control-main, .run-reason, .run-complete-feedback, .run-strategy-details, .run-strategy-statuses, .run-id, .progress-copy";
  const button = page.locator(".run-submit-button");
  await expect(button).toBeEnabled();
  const initialBounds = await button.boundingBox();
  const resultGets = [];
  page.on("request", request => {
    if (request.method() === "GET" && request.url().endsWith(`/api/v1/runs/${saved.runId}`)) resultGets.push(request.url());
  });
  for (const status of ["queued", "loading", "running"]) {
    const pending = structuredClone(saved);
    pending.status = status;
    pending.progress.completedStrategies = 1;
    pending.result.strategyRuns.forEach(result => { result.status = status; });
    await page.unroute("**/api/v1/runs/latest");
    await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: pending }));
    const eventUrl = `**/api/v1/runs/${saved.runId}/events`;
    await page.route(eventUrl, async route => {
      await new Promise(resolve => setTimeout(resolve, 2500));
      await route.fulfill({ contentType: "text/event-stream", body: `event: terminal\ndata: ${JSON.stringify({
        runId: saved.runId, status: saved.status, progress: saved.progress,
        strategyStatuses: Object.fromEntries(saved.result.strategyRuns.map(result => [result.id, result.status])),
      })}\n\n` });
    });
    const stream = page.waitForRequest(request => request.url().endsWith(`/api/v1/runs/${saved.runId}/events`));
    await page.reload({ waitUntil: "domcontentloaded" });
    await stream;
      await expect(button).toHaveAttribute("aria-busy", "true");
      await expect(button).toBeDisabled();
      await expect(button).toHaveAccessibleName(/1\/3/);
      await expect(page.locator(".run-reset-button")).toBeDisabled();
      await expect(page.locator(removed)).toHaveCount(0);
      await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
      expect(await button.boundingBox()).toEqual(initialBounds);
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(removed)).toHaveCount(0);
    await page.unroute(eventUrl);
  }
  expect(resultGets).toHaveLength(3);
  for (const status of ["completed_with_warning", "unavailable", "failed"]) {
    const terminal = structuredClone(saved);
    terminal.status = status;
    terminal.result.strategyRuns[0].status = status === "completed_with_warning" ? "failed" : status;
    terminal.result.strategyRuns[0].diagnostics = [{
      code: "calculation_failed", severity: "error", messageKey: "diagnostics.calculation_failed",
      details: { stage: "strategy", strategyId: terminal.result.strategyRuns[0].id, runId: saved.runId },
    }];
    await page.unroute("**/api/v1/runs/latest");
    await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: terminal }));
    await page.reload();
    await expect(page.locator(".diagnostic-list")).toBeVisible();
    await expect(page.locator(removed)).toHaveCount(0);
    await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
    await page.locator("#result-details-toggle").click();
    await expect(page.locator("#result-details-content")).toBeHidden();
    await expect(page.locator(".diagnostic-list")).toBeVisible();
  }
  for (const language of ["日本語", "中文"]) {
    await page.getByRole("button", { name: language, exact: true }).click();
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
  }
});

test("workbench avoids reserved blank space across width and height breakpoints", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/");
  await expect(page.locator(".workbench-layout")).toBeVisible();

  const measurements = [];
  for (const width of [768, 1024, 1150, 1280, 1440, 1920]) {
    for (const height of [600, 720, 900, 1080, 1440, 1920]) {
      await page.setViewportSize({ width, height });
      const dimensions = await page.evaluate(() => {
        const main = document.querySelector(".main-content.workbench-main").getBoundingClientRect();
        const layout = document.querySelector(".workbench-layout").getBoundingClientRect();
        const results = document.querySelector(".workbench-results");
        return {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          documentHeight: document.documentElement.scrollHeight,
          topbarHeight: document.querySelector(".app-topbar").getBoundingClientRect().height,
          mainTop: main.top,
          mainBottom: main.bottom,
          mainHeight: main.height,
          layoutBottom: layout.bottom,
          resultsClientHeight: results.clientHeight,
          resultsContentHeight: results.scrollHeight,
          unusedAfterResults: Math.max(0, layout.bottom - results.getBoundingClientRect().bottom),
        };
      });
      measurements.push(dimensions);
      expect(dimensions.resultsClientHeight, JSON.stringify(dimensions)).toBeGreaterThan(0);
      expect(dimensions.unusedAfterResults, JSON.stringify(dimensions)).toBeLessThanOrEqual(1);
      expect(dimensions.documentHeight, JSON.stringify(dimensions)).toBeLessThanOrEqual(height + 2);
      expect(dimensions.mainBottom, JSON.stringify(dimensions)).toBeLessThanOrEqual(height + 2);
    }
  }
  expect(measurements).toHaveLength(36);
});

test("touch tablets keep the configuration and results in two in-flow columns", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  await page.goto("/");
  await page.locator(".workbench-divider .workbench-config-toggle").click();
  const geometry = await page.evaluate(() => ({
    coarse: window.matchMedia("(pointer: coarse)").matches,
    columns: getComputedStyle(document.querySelector(".workbench-layout")).gridTemplateColumns.split(" ").length,
    dividerDisplay: getComputedStyle(document.querySelector(".workbench-divider")).display,
    configRight: document.querySelector(".workbench-config").getBoundingClientRect().right,
    resultsLeft: document.querySelector(".workbench-results").getBoundingClientRect().left,
  }));
  expect(geometry.coarse).toBe(true);
  expect(geometry.columns).toBe(3);
  expect(geometry.dividerDisplay).toBe("grid");
  expect(geometry.configRight).toBeLessThanOrEqual(geometry.resultsLeft);
  await context.close();
});

test("mobile views switch between configuration and results while keeping the page contained", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const views = page.getByRole("group", { name: "メイン画面" });
  const configView = page.getByRole("button", { name: "設定", exact: true });
  const resultsView = page.getByRole("button", { name: "結果", exact: true });
  await expect(views).toBeVisible();
  await expect(resultsView).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".workbench-results")).toBeVisible();
  await expect(page.locator(".workbench-config")).toBeHidden();

  await configView.click();
  await expect(configView).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".workbench-config")).toBeVisible();
  await expect(page.locator(".workbench-results")).toBeHidden();
  await expect(page.locator(".strategy-card-open")).toHaveCount(1);
  const stickyHeader = await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    return document.querySelector(".app-topbar").getBoundingClientRect().top;
  });
  expect(stickyHeader).toBe(0);

  await resultsView.click();
  await expect(resultsView).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".workbench-results")).toBeVisible();
  await expect(page.locator(".workbench-config")).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Japanese and Chinese first screens pass axe and expose a semantic Chromium accessibility tree", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  for (const locale of ["ja", "zh"]) {
    if (locale === "zh") {
      await page.getByRole("button", { name: "中文" }).click();
    }
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

    const devtools = await page.context().newCDPSession(page);
    const { nodes } = await devtools.send("Accessibility.getFullAXTree");
    expect(nodes.some(({ role }) => role?.value === "main")).toBe(true);
    const headingName = locale === "ja" ? "バックテスト" : "历史回测";
    expect(nodes.some(({ name, role }) =>
      role?.value === "heading" && name?.value === headingName,
    )).toBe(true);
    expect(nodes.some(({ role }) => role?.value === "button")).toBe(true);
    await devtools.detach();
  }
});

test("catalog lists all presets, independent condition toggles, and locale changes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".strategy-add-option")).toHaveCount(10);
  await expect(page.locator(".strategy-add-menu")).toBeHidden();
  await expect(page.locator(".strategy-parameter-group")).toHaveCount(0);
  await page.locator(".strategy-card-open").first().click();
  await expect(page.locator(".strategy-dialog #strategy-editor-heading")).toHaveText("ボラティリティ積立");
  await expect(page.locator(".strategy-dialog #field-strategy-vix_dca-1-vix-symbol-hint")).toHaveText("この条件で使う指数。");
  const japaneseDialogA11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(japaneseDialogA11y.violations, JSON.stringify(japaneseDialogA11y.violations, null, 2)).toEqual([]);
  await closeStrategyDialog(page);
  await expect(page.locator("#run-scope-select, #run-scope-help")).toHaveCount(0);
  for (const presetId of [
    "vix_dca",
    "composite_dca",
    "ma_trend",
    "ma_buy_only",
    "grid_search",
  ]) {
    await expect(page.locator(`.strategy-add-option[data-preset-id="${presetId}"]`)).toHaveCount(1);
  }
  await closeSharedSettings(page);

  await expect(page.locator(".strategy-nav-card [role='switch']")).toHaveCount(0);

  for (const presetId of [
    "composite_dca",
    "ma_trend",
    "ma_buy_only",
    "grid_search",
  ]) {
    await addStrategy(page, presetId);
  }
  await expect(page.locator(".strategy-card")).toHaveCount(5);

  for (let index = 0; index < 5; index += 1) {
    await page.locator(".strategy-card-open").nth(index).click();
    const parameterCount = await page.locator(".strategy-dialog .field").count();
    expect(parameterCount, `preset card ${index} opens catalog parameters`).toBeGreaterThan(0);
    if (index === 1) {
      const buy = page.locator('[data-rule-side="buy"]');
      for (const kind of ["rsi", "ma_deviation", "bollinger", "rate"]) await buy.locator(".condition-add-select").first().selectOption(kind);
      const content = page.locator(".strategy-dialog-content");
      await expect.poll(() => content.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await expect(page.locator(".strategy-parameter-nav")).toHaveCount(0);
      await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(buy.locator(".condition-card").last()).toBeInViewport();
    }
    await closeStrategyDialog(page);
    await expect(page.locator(".strategy-card-open").nth(index)).toBeFocused();
  }

  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("历史回测");
  await page.locator(".strategy-card-open").first().click();
  await expect(page.locator(".strategy-dialog .condition-heading h3").first()).toHaveText("买入波动率");
  const chineseDialogA11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(chineseDialogA11y.violations, JSON.stringify(chineseDialogA11y.violations, null, 2)).toEqual([]);
  await closeStrategyDialog(page);
  await page.getByRole("button", { name: "日本語" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
});

test("strategy dialog stays usable at 320px and returns focus to its card", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/");
  await page.getByRole("button", { name: "設定", exact: true }).click();
  const trigger = page.locator(".strategy-card-open").first();
  await trigger.click();
  await expect(page.locator(".strategy-dialog")).toBeVisible();

  const geometry = await page.locator(".strategy-dialog").evaluate((dialog) => ({
    width: dialog.getBoundingClientRect().width,
    viewportWidth: window.innerWidth,
    columns: getComputedStyle(dialog.querySelector(".strategy-parameter-grid")).gridTemplateColumns.split(" ").length,
  }));
  expect(geometry.width).toBeLessThanOrEqual(geometry.viewportWidth - 24);
  expect(geometry.columns).toBe(1);

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations, JSON.stringify(accessibility.violations, null, 2)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(page.locator(".strategy-dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("shared summary follows the single form and strategy editing preserves independent run and result state", async ({ page }) => {
  await page.goto("/");
  await openSharedSettings(page);
  await page.locator("#field-run-symbol").fill("SPY");
  await page.locator("#field-run-startDate").fill("2024-01-31");

  await page.locator("#field-run-endDate").fill("2024-02-02");
  await page.locator("#field-contribution-amount").fill("250");
  await page.locator("#field-contribution-day").fill("15");
  const sharedSummary = page.locator(".shared-settings-summary-text");
  await expect(sharedSummary).toContainText("QQQ");
  await closeSharedSettings(page);
  await expect(sharedSummary).toContainText("SPY");
  await expect(sharedSummary).toContainText("2024-01-31");
  await expect(sharedSummary).toContainText("2024-02-02");
  await expect(sharedSummary).toContainText("250");
  await expect(sharedSummary).toContainText("15");
  await closeSharedSettings(page);

  await addStrategy(page, "ma_buy_only");
  const completed = page.waitForResponse(async (response) => {
    if (response.request().method() !== "GET" || !/\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url())) return false;
    if (!response.ok()) return false;
    return ["completed", "completed_with_warning", "unavailable", "failed"]
      .includes((await response.json()).status);
  });
  await page.getByRole("button", { name: "バックテストを実行" }).click();
  await completed;

  await page.getByRole("tab", { name: "戦略比較" }).click();
  const benchmark = page.locator(".comparison-table tbody tr")
    .filter({ hasText: "毎月定額積立" })
    .locator("button.result-select");
  await benchmark.click();
  await expect(benchmark).toHaveAttribute("aria-pressed", "true");
  const chartToggle = page.getByRole("button", { name: "資産推移" });
  await chartToggle.click();
  await expect(chartToggle).toHaveAttribute("aria-expanded", "false");

  await page.locator(".strategy-card-open").filter({ hasText: "ボラティリティ積立" }).click();
  await expect(page.locator(".strategy-dialog #strategy-editor-heading")).toHaveText("ボラティリティ積立");
  await expect(page.getByRole("switch").first()).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".strategy-run-target")).toHaveCount(0);
  await expect(page.locator("#run-scope-select")).toHaveCount(0);
  await expect(benchmark).toHaveAttribute("aria-pressed", "true");
  await expect(chartToggle).toHaveAttribute("aria-expanded", "false");

  await page.locator("#field-strategy-vix_dca-1-vix-buyThreshold").fill("26");
  await closeStrategyDialog(page);
  await page.locator(".strategy-card-open").filter({ hasText: "移動平均トレンド（買付のみ）" }).click();
  await closeStrategyDialog(page);
  await page.locator(".strategy-card-open").filter({ hasText: "ボラティリティ積立" }).click();
  await expect(page.locator("#field-strategy-vix_dca-1-vix-buyThreshold")).toHaveValue("26");
  await expect(page.locator(".snapshot-warning")).toHaveCount(0);
  await expect(benchmark).toHaveAttribute("aria-pressed", "true");
  await closeStrategyDialog(page);
});

test("editing a strategy leaves the active run target and run scope unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await addStrategy(page, "ma_buy_only");

  const vixCard = page.locator(".strategy-card").filter({ hasText: "ボラティリティ積立" });
  const monthlyCard = page.locator(".strategy-card").filter({ hasText: "移動平均トレンド（買付のみ）" });
  await expect(page.locator(".strategy-run-target")).toHaveCount(0);
  await expect(page.locator(".strategy-run-target")).toHaveCount(0);

  await vixCard.locator(".strategy-card-open").click();
  const dialog = page.locator(".strategy-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#run-scope-select")).toHaveCount(0);
  await expect(page.locator(".strategy-run-target")).toHaveCount(0);
  await expect(page.locator(".strategy-run-target")).toHaveCount(0);
  await dialog.locator("#field-strategy-vix_dca-1-vix-buyThreshold").fill("26");
  await closeStrategyDialog(page);

  await expect(page.getByRole("button", { name: "バックテストを実行" })).toBeEnabled();
  const runRequest = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().endsWith("/api/v1/runs"),
  );
  const completed = page.waitForResponse(async (response) => {
    if (response.request().method() !== "GET" || !/\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url())) return false;
    if (!response.ok()) return false;
    return ["completed", "completed_with_warning", "unavailable", "failed"]
      .includes((await response.json()).status);
  });
  await page.getByRole("button", { name: "バックテストを実行" }).click();
  const payload = (await runRequest).postDataJSON();
  expect(payload.scope).toBe("all_enabled");
  expect(payload.activeStrategyId).toBeUndefined();
  expect(payload.draft.strategies.map(({ presetId }) => presetId)).toEqual(["vix_dca", "ma_buy_only"]);
  await completed;
});

test("strategy card actions stay separate and deletion returns focus to a useful control", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const vixCard = page.locator(".strategy-card").filter({ hasText: "ボラティリティ積立" });
  await vixCard.hover();
  await expect(vixCard.getByRole("switch")).toHaveCount(0);
  await expect(page.locator(".strategy-dialog")).toHaveCount(0);

  for (const presetId of ["composite_dca", "ma_buy_only"]) {
    await addStrategy(page, presetId);
    await expect(page.locator(".strategy-dialog")).toHaveCount(0);
  }

  const compositeCard = page.locator(".strategy-card").filter({ hasText: "カスタム戦略" });
  const monthlyCard = page.locator(".strategy-card").filter({ hasText: "移動平均トレンド（買付のみ）" });
  await compositeCard.locator(".strategy-card-open").click();
  await expect(page.locator(".strategy-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".strategy-dialog")).toHaveCount(0);
  await expect(compositeCard.locator(".strategy-card-open")).toBeFocused();

  await compositeCard.hover();
  await compositeCard.locator(".strategy-remove").click();
  await expect(page.locator(".strategy-dialog")).toHaveCount(0);
  await expect(monthlyCard.locator(".strategy-card-open")).toBeFocused();
  await vixCard.hover();
  await vixCard.locator(".strategy-remove").click();
  await expect(monthlyCard.locator(".strategy-card-open")).toBeFocused();
  await monthlyCard.hover();
  await monthlyCard.locator(".strategy-remove").click();
  await expect(page.locator(".strategy-card")).toHaveCount(0);
  await expect(page.locator(".add-strategy-button")).toBeFocused();
});

test("invalid dialogs block every exit and focus errors without touching the run button", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const run = page.locator(".run-submit-button");
  const before = await run.evaluate(node => node.outerHTML);
  let submissions = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/api/v1/runs")) submissions++; });
  await openSharedSettings(page);
  const dialog = page.locator(".shared-settings-dialog");
  const day = dialog.locator("#field-contribution-day");
  await day.fill("32");
  for (const exit of ["done", "escape", "close", "backdrop"]) {
    if (exit === "done") await dialog.locator(".dialog-done").click();
    if (exit === "escape") await page.keyboard.press("Escape");
    if (exit === "close") await dialog.locator(".shared-settings-dialog-close").click();
    if (exit === "backdrop") await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();
    await expect(day).toHaveAttribute("aria-invalid", "true");
    await expect(day).toBeFocused();
    expect(await run.evaluate(node => node.outerHTML)).toBe(before);
  }
  await day.fill("1");
  await closeSharedSettings(page);
  await page.locator(".strategy-card-open").first().click();
  const strategyDialog = page.locator(".strategy-dialog");
  const threshold = strategyDialog.locator('input[id$="-vix-buyThreshold"]');
  await threshold.fill("-1");
  for (const exit of ["done", "escape", "close", "backdrop"]) {
    if (exit === "done") await strategyDialog.locator(".dialog-done").click();
    if (exit === "escape") await page.keyboard.press("Escape");
    if (exit === "close") await strategyDialog.locator(".strategy-dialog-close").click();
    if (exit === "backdrop") await page.mouse.click(5, 5);
    await expect(strategyDialog).toBeVisible();
    await expect(threshold).toHaveAttribute("aria-invalid", "true");
    expect(await run.evaluate(node => node.outerHTML)).toBe(before);
  }
  await threshold.fill("25");
  await closeStrategyDialog(page);
  expect(submissions).toBe(0);
  expect(await run.evaluate(node => node.outerHTML)).toBe(before);
});

test("default VIX can run to a focused saved result, display toggles, and matching CSV", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  const nonLocalRequests = [];
  const runStatusRequests = [];
  const runEventRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const hostname = new URL(request.url()).hostname;
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      nonLocalRequests.push(request.url());
    }
    if (request.method() === "GET" && /\/api\/v1\/runs\/[^/]+\/events$/.test(request.url())) {
      runEventRequests.push(request.url());
    }
    if (
      request.method() === "GET" &&
      !request.url().endsWith("/api/v1/runs/latest") &&
      /\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(request.url())
    ) {
      runStatusRequests.push(request.url());
    }
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".strategy-card-name").first()).toHaveText("ボラティリティ積立");
  await openSharedSettings(page);
  await page.getByLabel("開始日").fill("2024-01-31");

  await page.locator("#field-run-endDate").fill("2024-02-02");
  await closeSharedSettings(page);

  const completedResponse = page.waitForResponse(async (response) => {
    if (response.request().method() !== "GET" || !/\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url())) {
      return false;
    }
    if (!response.ok()) return false;
    return ["completed", "completed_with_warning", "unavailable", "failed"]
      .includes((await response.json()).status);
  });
  const runButton = page.getByRole("button", { name: "バックテストを実行" });
  await expect(runButton).toBeEnabled();
  await expect(runButton).toHaveCSS("background-color", await themeColor(page, "--app-action"));
  await expect(runButton).toHaveCSS("color", await themeColor(page, "--app-action-text"));
  await expect(runButton).toHaveText("");
  await expect(runButton.locator("svg.run-play-icon")).toHaveCount(1);
  await expect(runButton).toHaveAttribute("title", "バックテストを実行");
  await runButton.click();
  const savedResponse = await completedResponse;
  const saved = await savedResponse.json();
  await expect.poll(() => runStatusRequests.length).toBe(1);
  await expect.poll(() => runEventRequests.length).toBe(1);
  const strategy = saved.result.strategyRuns.find((item) => item.id === "strategy-vix_dca-1");
  const benchmark = saved.result.strategyRuns.find((item) => item.id === "benchmark:monthly-dca");
  expect(saved.status).toBe("completed");
  expect(strategy.status).toBe("completed");
  expect(benchmark.role).toBe("benchmark");
  await expect(page.locator(".run-status-panel")).toHaveCount(0);
  await expect(page.locator(".snapshot-warning")).toHaveCount(0);

  await expect(page.locator(".comparison-table thead th")).toHaveCount(9);
  await expect(page.locator(".comparison-table")).toContainText("投入済み元本");
  await expect(page.locator("#result-details")).toBeVisible();
  await expect(page.locator(".result-run-id, #result-focus-select, .metric-card")).toHaveCount(0);
  const resultRows = page.locator(".comparison-table tbody tr");
  await expect(resultRows.locator('.result-select[aria-pressed="true"]')).toHaveCount(0);
  await resultRows.filter({ hasText: "ボラティリティ積立" }).locator(".result-select").click();
  await resultRows.filter({ hasText: "毎月定額積立" }).locator(".result-select").click();
  await expect(resultRows.filter({ hasText: "毎月定額積立" }).locator(".result-select")).toHaveAttribute("aria-pressed", "true");
  await resultRows.filter({ hasText: "ボラティリティ積立" }).locator(".result-select").click();
  await expect(resultRows.filter({ hasText: "ボラティリティ積立" }).locator(".result-select")).toHaveAttribute("aria-pressed", "false");
  await resultRows.filter({ hasText: "ボラティリティ積立" }).locator(".result-select").click();
  await expect(resultRows.filter({ hasText: "ボラティリティ積立" }).locator(".result-select")).toHaveAttribute("aria-pressed", "true");
  const chartVisibilityButton = page.getByRole("button", { name: "資産推移" });
  await expect(chartVisibilityButton).toHaveAttribute("aria-expanded", "true");
  await expect(chartVisibilityButton.locator("svg")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "全期間に戻す" })).toBeVisible();
  const overviewOrder = await page.evaluate(() => ({
    metrics: document.querySelector(".comparison-table")?.getBoundingClientRect().top ?? Infinity,
    chart: document.querySelector(".chart-panel.chart-overlay")?.getBoundingClientRect().top ?? Infinity,
    details: document.querySelector(".result-details")?.getBoundingClientRect().top ?? Infinity,
  }));
  expect(overviewOrder.details).toBeLessThan(overviewOrder.metrics);
  expect(overviewOrder.metrics).toBeLessThan(overviewOrder.chart);
  const firstScreen = await page.evaluate(() => ({
    resultsTop: document.querySelector(".workbench-results").getBoundingClientRect().top,
    resultsBottom: document.querySelector(".workbench-results").getBoundingClientRect().bottom,
    metricsTop: document.querySelector(".comparison-table").getBoundingClientRect().top,
    chartVisibleHeight: (() => {
      const pane = document.querySelector(".workbench-results").getBoundingClientRect();
      const svg = document.querySelector(".chart-panel.chart-overlay .result-chart");
      const bounds = svg.getBoundingClientRect();
      const plot = svg.querySelector("clipPath rect");
      const viewBox = svg.viewBox.baseVal;
      const plotTop = bounds.top + Number(plot.getAttribute("y")) / viewBox.height * bounds.height;
      const plotHeight = Number(plot.getAttribute("height")) / viewBox.height * bounds.height;
      return Math.max(0, Math.min(plotTop + plotHeight, pane.bottom) - Math.max(plotTop, pane.top));
    })(),
    detailsTop: document.querySelector(".result-details").getBoundingClientRect().top,
    detailsBottom: document.querySelector(".result-details").getBoundingClientRect().bottom,
  }));
  expect(firstScreen.metricsTop).toBeLessThan(firstScreen.resultsBottom);
  expect(firstScreen.chartVisibleHeight).toBeGreaterThan(120);
  expect(firstScreen.detailsTop).toBeLessThan(firstScreen.resultsBottom);
  expect(firstScreen.detailsBottom).toBeLessThanOrEqual(firstScreen.resultsBottom);

  const viewportMeasurements = [];
  for (const height of [600, 720, 900, 1080, 1440, 1920, 2644]) {
    await page.setViewportSize({ width: 1440, height });
    const measurements = await page.evaluate(() => {
      const pane = document.querySelector(".workbench-results");
      const mainElement = document.querySelector(".main-content.workbench-main");
      const layoutElement = document.querySelector(".workbench-layout");
      const main = mainElement.getBoundingClientRect();
      return {
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        mainBottom: main.bottom,
        mainScrollHeight: mainElement.scrollHeight,
        layoutScrollHeight: layoutElement.scrollHeight,
        paneClientHeight: pane.clientHeight,
        paneScrollHeight: pane.scrollHeight,
        unusedPaneHeight: Math.max(0, pane.clientHeight - pane.scrollHeight),
      };
    });
    viewportMeasurements.push(measurements);
    expect(measurements.documentHeight, JSON.stringify(measurements)).toBeLessThanOrEqual(height + 2);
    expect(measurements.mainBottom, JSON.stringify(measurements)).toBeLessThanOrEqual(height + 2);
    expect(measurements.unusedPaneHeight, JSON.stringify(measurements)).toBeLessThanOrEqual(1);
  }
  expect(viewportMeasurements).toHaveLength(7);

  const savedResultViewports = [];
  for (const [width, height] of [[1920, 1080], [1536, 864], [1280, 720], [1024, 720], [768, 720]]) {
    await page.setViewportSize({ width, height });
    const measurements = await page.evaluate(() => ({
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      topbarHeight: document.querySelector(".app-topbar").getBoundingClientRect().height,
      mainTop: document.querySelector(".main-content.workbench-main").getBoundingClientRect().top,
      mainBottom: document.querySelector(".main-content.workbench-main").getBoundingClientRect().bottom,
      resultsClientHeight: document.querySelector(".workbench-results").clientHeight,
      resultsScrollHeight: document.querySelector(".workbench-results").scrollHeight,
    }));
    savedResultViewports.push({ width, ...measurements });
    expect(measurements.documentHeight, JSON.stringify({ width, ...measurements })).toBeLessThanOrEqual(height + 2);
    expect(measurements.mainBottom, JSON.stringify({ width, ...measurements })).toBeLessThanOrEqual(height + 2);
    expect(measurements.resultsClientHeight).toBeGreaterThan(0);
    expect(measurements.resultsScrollHeight).toBeGreaterThan(measurements.resultsClientHeight);
  }
  expect(savedResultViewports).toHaveLength(5);

  await page.setViewportSize({ width: 1920, height: 1080 });
  const resultPane = page.locator(".workbench-results");
  await resultPane.evaluate((element) => { element.scrollTop = 0; });
  const plotHeight = async (selector) => page.locator(selector).evaluate((figure) => {
    const svg = figure.querySelector(".result-chart");
    const plot = svg.querySelector("clipPath rect");
    return Number(plot.getAttribute("height")) / svg.viewBox.baseVal.height * svg.getBoundingClientRect().height;
  });
  const mainPlotHeight = await plotHeight(".chart-panel.chart-overlay");
  expect(mainPlotHeight, `1920px main plot height: ${mainPlotHeight}px`).toBeGreaterThanOrEqual(320);
  expect(mainPlotHeight, `1920px main plot height: ${mainPlotHeight}px`).toBeLessThanOrEqual(420);
  await expect(page.locator(".chart-range-label")).toContainText("全図共通");
  for (const selector of [".chart-drawdown", ".chart-vix"]) {
    const size = await page.locator(`${selector} svg.result-chart`).evaluate(svg => ({ width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height }));
    expect(size.height).toBeCloseTo(size.width * 90 / 800, 1);
    expect(await plotHeight(selector)).toBeGreaterThan(30);
  }
  await expect(page.locator(".chart-x-axis-title")).toHaveCount(1);
  await expect(page.locator(".chart-date-axis .chart-x-axis-title")).toHaveCount(1);

  await page.setViewportSize({ width: 1920, height: 600 });
  await resultPane.evaluate((element) => { element.scrollTop = 0; });
  const shortScreenLayout = await resultPane.evaluate((element) => ({
    documentHeight: document.documentElement.scrollHeight,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(shortScreenLayout.documentHeight).toBeLessThanOrEqual(602);
  expect(shortScreenLayout.scrollHeight).toBeGreaterThan(shortScreenLayout.clientHeight);
  expect(await plotHeight(".chart-panel.chart-overlay")).toBeCloseTo(mainPlotHeight, 0);
  await expect(page.locator(".chart-layout-controls")).toHaveCount(0);
  await expect(page.locator(".chart-range-controls")).toBeInViewport();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator(".workbench-mobile-view").filter({ hasText: "結果" }).click();
  const mobileDetailsHeader = page.locator("#result-details .collapsible-panel-header");
  await expect(mobileDetailsHeader).toBeVisible();
  const mobileHeaderBounds = await mobileDetailsHeader.evaluate((header) => {
    const bounds = header.getBoundingClientRect();
    return {
      clientWidth: header.clientWidth,
      scrollWidth: header.scrollWidth,
      right: bounds.right,
      childrenWithinHeader: [...header.querySelectorAll("button, select")].every((control) =>
        control.getBoundingClientRect().right <= bounds.right + 1),
    };
  });
  expect(mobileHeaderBounds.scrollWidth).toBeLessThanOrEqual(mobileHeaderBounds.clientWidth + 1);
  expect(mobileHeaderBounds.childrenWithinHeader).toBe(true);

  const mobileToolbar = page.locator(".chart-toolbar");
  for (const width of [320, 375, 767]) {
    // The compact stack can end before the sticky threshold on tall phones.
    // A short viewport lets the toolbar actually reach its sticky position.
    await page.setViewportSize({ width, height: 600 });
    await page.evaluate(() => {
      const toolbar = document.querySelector(".chart-toolbar");
      window.scrollTo(0, toolbar.getBoundingClientRect().top + window.scrollY + 80);
    });
    const mobileStickyBounds = await page.evaluate(() => {
      const topbar = document.querySelector(".app-topbar").getBoundingClientRect();
      const toolbar = document.querySelector(".chart-toolbar").getBoundingClientRect();
      return { topbarBottom: topbar.bottom, toolbarTop: toolbar.top };
    });
    expect(mobileStickyBounds.toolbarTop, `${width}px toolbar below topbar`).toBeGreaterThanOrEqual(
      mobileStickyBounds.topbarBottom - 1,
    );
    expect(mobileStickyBounds.toolbarTop, `${width}px toolbar stays close to topbar`).toBeLessThanOrEqual(
      mobileStickyBounds.topbarBottom + 12,
    );
    await expect(mobileToolbar).toBeInViewport();
  }

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator(".workbench-results").evaluate((element) => { element.scrollTop = 0; });
  await page.mouse.move(2, 700);
  await page.mouse.wheel(0, 560);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect.poll(() => page.locator(".workbench-results").evaluate((element) => element.scrollTop)).toBe(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: test.info().outputPath("workbench-1440-first-screen.png") });
  const resultDetails = page.locator("#result-details");
  await expect(resultDetails).toBeVisible();
  const detailsToggle = page.getByRole("button", { name: "実行結果" });
  await expect(detailsToggle).toHaveAttribute("aria-expanded", "true");
  await detailsToggle.focus();
  await page.keyboard.press("Space");
  await expect(detailsToggle).toHaveAttribute("aria-expanded", "false");
  await expect(detailsToggle).toBeFocused();
  await expect(page.locator("#result-details-content")).toBeHidden();
  await expect(page.locator("#result-focus-select")).toHaveCount(0);
  await expect(page.locator('[data-export-kind="summary"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(detailsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("tablist", { name: "実行結果" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "戦略比較" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#result-panel-metrics, #result-panel-overview")).toHaveCount(0);
  await page.getByRole("tab", { name: "戦略比較" }).click();
  await page.locator(".workbench-results").evaluate((element) => element.scrollTo(0, 0));

  const benchmarkRow = page.locator(".comparison-table tbody tr").filter({ hasText: "毎月定額積立" });
  const benchmarkButton = benchmarkRow.locator("button.result-select");
  await benchmarkButton.click();
  await expect(benchmarkButton).toHaveAttribute("aria-pressed", "false");
  await benchmarkButton.click();
  await expect(benchmarkButton).toHaveAttribute("aria-pressed", "true");
  await page.locator(".comparison-table tbody tr").filter({ hasText: "ボラティリティ積立" }).locator("button").click();
  await benchmarkButton.click();
  await benchmarkButton.click();

  const chartToggle = page.getByRole("button", { name: "資産推移" });
  await expect(chartToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("svg[role=img]").first()).toBeVisible();
  const coreChart = page.locator(".chart-panel.chart-overlay").first();
  await expect(coreChart.locator(".overlay-series-line.overlay-price")).toBeVisible();
  await expect(coreChart.locator(".overlay-series-line.overlay-totalAsset")).toBeVisible();
  await expect(coreChart.locator(".overlay-series-line")).toHaveCount(2);
  expect(await coreChart.locator(".overlay-series-line").evaluateAll((lines) =>
    lines.map((line) => line.getAttribute("stroke-width")),
  )).toEqual(["1.2", "1.2"]);
  await expect(coreChart.locator(".chart-baseline-line")).toHaveAttribute("data-baseline", "100");
  await expect(coreChart.locator(".overlay-legend")).toContainText("銘柄の終値 (USD)");
  await expect(coreChart.locator(".overlay-legend")).toContainText("毎月定額積立");
  expect(await coreChart.locator(".chart-gridline").count()).toBeGreaterThan(7);
  await expect(coreChart.locator(".candlestick")).toHaveCount(0);
  const chartWindowBeforeCollapse = {
    start: await coreChart.getAttribute("data-window-start"),
    end: await coreChart.getAttribute("data-window-end"),
  };
  await chartToggle.click();
  await expect(chartToggle).toHaveAttribute("aria-expanded", "false");
  await expect(coreChart).toBeHidden();
  await expect(page.locator(".chart-panel.chart-overlay")).toHaveCount(1);
  await chartToggle.click();
  await expect(chartToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("svg[role=img]").first()).toBeVisible();
  await expect(coreChart).toHaveAttribute("data-window-start", chartWindowBeforeCollapse.start);
  await expect(coreChart).toHaveAttribute("data-window-end", chartWindowBeforeCollapse.end);
  const strategyRow = page.locator(".comparison-table tbody tr").filter({ hasText: "ボラティリティ積立" });
  const strategyButton = strategyRow.locator("button.result-select");
  await benchmarkButton.click();
  await strategyButton.click();
  await expect(page.locator(".chart-panel.chart-vix")).toContainText("25");
  await expect(page.locator(".chart-panel.chart-vix .chart-threshold-line")).toHaveCount(1);
  const readChartWindows = () => page.locator(".chart-panel").evaluateAll((panels) =>
    panels.map((panel) => ({
      start: panel.getAttribute("data-window-start"),
      end: panel.getAttribute("data-window-end"),
      ticks: [...panel.querySelectorAll(".chart-x-tick")].map((tick) => tick.textContent),
      grids: [...panel.querySelectorAll(".chart-gridline-vertical")].map(line => line.getAttribute("x1")),
    })),
  );
  const expectSynchronizedWindows = async () => {
    const windows = await readChartWindows();
    expect(windows).toHaveLength(3);
    expect(new Set(windows.map(({ start, end }) => `${start}:${end}`)).size).toBe(1);
    expect(windows.filter(({ ticks }) => ticks.length > 0)).toHaveLength(0);
    await expect(page.locator(".chart-date-axis .chart-x-tick")).toHaveCount(3);
    expect(new Set(windows.map(({ grids }) => grids.join("|"))).size).toBe(1);
    return windows[0];
  };
  const expectBaselineInsidePlot = async () => {
    const baselineY = await page.locator(".chart-panel.chart-overlay .chart-baseline-line").getAttribute("y1");
    expect(Number(baselineY)).toBeGreaterThanOrEqual(20);
    expect(Number(baselineY)).toBeLessThanOrEqual(266);
  };
  const wheelResetButton = page.getByRole("button", { name: "全期間に戻す" });
  const zoomSensitivityChart = page.locator(".chart-panel.chart-overlay .result-chart");
  const wheelZoomMode = page.locator(".chart-wheel-zoom-toggle");
  await expect(wheelZoomMode).toHaveAttribute("aria-pressed", "false");
  await wheelZoomMode.click();
  await expect(wheelZoomMode).toHaveAttribute("aria-pressed", "true");
  await zoomSensitivityChart.hover();
  const scrollBeforeWheelZoomMode = await page.locator(".workbench-results").evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, -160);
  await expect.poll(() => page.locator(".chart-panel.chart-overlay").getAttribute("data-window-start")).not.toBe("0");
  await expect.poll(() => page.locator(".workbench-results").evaluate((element) => element.scrollTop)).toBe(scrollBeforeWheelZoomMode);
  await expectSynchronizedWindows();
  await wheelResetButton.click();
  await wheelZoomMode.click();
  await expect(wheelZoomMode).toHaveAttribute("aria-pressed", "false");
  await zoomSensitivityChart.hover();
  await controlWheel(page, -160);
  const singleEventWindows = await expectSynchronizedWindows();
  const singleEventSpan = Number(singleEventWindows.end) - Number(singleEventWindows.start);
  await wheelResetButton.click();
  await zoomSensitivityChart.hover();
  for (let index = 0; index < 16; index += 1) {
    await controlWheel(page, -10);
  }
  const splitEventWindows = await expectSynchronizedWindows();
  const splitEventSpan = Number(splitEventWindows.end) - Number(splitEventWindows.start);
  expect(splitEventSpan).toBeCloseTo(singleEventSpan, 2);
  await wheelResetButton.click();
  for (const chartSelector of ["chart-overlay", "chart-drawdown", "chart-vix"]) {
    if (chartSelector === "chart-drawdown") {
      const panel = page.locator(".chart-panel.chart-drawdown");
      const originalWindow = [await panel.getAttribute("data-window-start"), await panel.getAttribute("data-window-end")];
      const toggle = page.locator(".chart-legend .legend-toggle").filter({ hasText: "ドローダウン" });
      await toggle.click();
      await expect(panel).toHaveCount(0);
      await expect(page.locator(".chart-x-axis-title")).toHaveCount(1);
      await toggle.click();
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute("data-window-start", originalWindow[0]);
      await expect(panel).toHaveAttribute("data-window-end", originalWindow[1]);
    }
    if (chartSelector === "chart-vix") {
      await page.locator(".chart-vix svg.result-chart").scrollIntoViewIfNeeded();
      await expect(page.locator(".chart-toolbar")).toBeInViewport();
      await expect(page.locator(".chart-range-controls")).toBeInViewport();
    }
    const resetRangeButton = page.getByRole("button", { name: "全期間に戻す" });
    if (await resetRangeButton.isEnabled()) await resetRangeButton.click();
    const chart = page.locator(`.chart-panel.${chartSelector} .result-chart`);
    await chart.hover();
    await expect(chart).toHaveCSS("touch-action", "none");
    const resultsPane = page.locator(".workbench-results");
    const beforePlainWheel = await expectSynchronizedWindows();
    const plainWheel = await resultsPane.evaluate((element) => ({
      scrollTop: element.scrollTop,
      maxScroll: element.scrollHeight - element.clientHeight,
    }));
    const scrollBeforePlainWheel = plainWheel.scrollTop;
    const plainWheelDelta = plainWheel.scrollTop >= plainWheel.maxScroll - 1 ? -160 : 160;
    const pageViewportBeforeWheel = await page.evaluate(() => ({
      scrollY: window.scrollY,
      scale: window.visualViewport?.scale,
    }));
    await page.mouse.wheel(0, plainWheelDelta);
    await expect.poll(() => resultsPane.evaluate((element) => element.scrollTop)).not.toBe(scrollBeforePlainWheel);
    const afterPlainWheel = await expectSynchronizedWindows();
    expect(afterPlainWheel.start).toBe(beforePlainWheel.start);
    expect(afterPlainWheel.end).toBe(beforePlainWheel.end);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageViewportBeforeWheel.scrollY);

    const zoomAnchorBounds = await chart.boundingBox();
    expect(zoomAnchorBounds).toBeTruthy();
    await chart.hover({ position: { x: zoomAnchorBounds.width * 0.25, y: zoomAnchorBounds.height / 2 } });
    const scrollBeforeZoom = await resultsPane.evaluate((element) => element.scrollTop);
    await controlWheel(page, -160);
    await expect.poll(async () => page.locator(`.chart-panel.${chartSelector}`).getAttribute("data-window-start")).not.toBe("0");
    await expect.poll(() => resultsPane.evaluate((element) => element.scrollTop)).toBe(scrollBeforeZoom);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(pageViewportBeforeWheel.scrollY);
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(pageViewportBeforeWheel.scale);
    const zoomedWindow = await expectSynchronizedWindows();
    expect(Number(zoomedWindow.end) - Number(zoomedWindow.start)).toBeGreaterThan(0.9);
    await expectBaselineInsidePlot();

    const bounds = await chart.boundingBox();
    expect(bounds).toBeTruthy();
    const pointerX = bounds.x + bounds.width / 2;
    const pointerY = bounds.y + bounds.height / 2;
    await page.mouse.move(pointerX, pointerY);
    await page.mouse.down();
    await page.mouse.move(pointerX - 45, pointerY, { steps: 4 });
    await page.mouse.up();
    const draggedWindow = await expectSynchronizedWindows();
    const draggedStart = Number(draggedWindow.start);
    const zoomedStart = Number(zoomedWindow.start);
    const plotGeometry = await chart.evaluate((svg) => {
      const plot = svg.querySelector("clipPath rect");
      return {
        viewBoxWidth: svg.viewBox.baseVal.width,
        plotWidth: Number(plot?.getAttribute("width")),
      };
    });
    const nominalPan = (45 / bounds.width) * (plotGeometry.viewBoxWidth / plotGeometry.plotWidth)
      * (Number(zoomedWindow.end) - Number(zoomedWindow.start));
    expect(draggedStart).toBeGreaterThan(zoomedStart);
    // Keep the viewport close to the full pointer distance while allowing browser pixel rounding.
    expect(draggedStart - zoomedStart, `${chartSelector} drag should match pointer distance`).toBeGreaterThan(nominalPan * 0.85);
    expect(draggedStart - zoomedStart, `${chartSelector} drag should match pointer distance`).toBeLessThan(nominalPan * 1.15);
    await expectBaselineInsidePlot();
  }
  const resetRangeButton = wheelResetButton;
  if (await resetRangeButton.isEnabled()) await resetRangeButton.click();
  const coreChartSvg = page.locator(".chart-panel.chart-overlay .result-chart");
  await coreChartSvg.hover();
  const browserViewBeforeCtrlWheel = await page.evaluate(() => ({
    scrollY: window.scrollY,
    innerWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio,
    scale: window.visualViewport?.scale,
  }));
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -160);
  await page.keyboard.up("Control");
  await expect.poll(() => page.locator(".chart-panel.chart-overlay").getAttribute("data-window-start")).not.toBe("0");
  expect(await page.evaluate(() => ({
    scrollY: window.scrollY,
    innerWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio,
    scale: window.visualViewport?.scale,
  }))).toEqual(browserViewBeforeCtrlWheel);
  await expectSynchronizedWindows();
  if (await resetRangeButton.isEnabled()) await resetRangeButton.click();
  await page.getByRole("button", { name: "期間を拡大" }).click();
  const keyboardZoomedWindow = await expectSynchronizedWindows();
  await page.locator(".chart-panel.chart-overlay .result-chart").focus();
  await page.keyboard.press("ArrowRight");
  const keyboardPannedWindow = await expectSynchronizedWindows();
  expect(keyboardPannedWindow.start).not.toBe(keyboardZoomedWindow.start);
  await page.keyboard.press("Home");
  await expect(page.locator(".chart-panel.chart-overlay")).toHaveAttribute("data-window-start", "0");
  await expect(page.locator(".chart-layout-controls")).toHaveCount(0);
  await expect(page.locator(".chart-panel.chart-overlay .overlay-series-line")).toHaveCount(2);
  await expect(page.locator(".chart-linked-stack .is-compact")).toHaveCount(2);
  expect(await page.locator(".chart-panel.chart-overlay .overlay-series-line").evaluateAll((lines) =>
    lines.map((line) => line.getAttribute("stroke-width")),
  )).toEqual(["1.2", "1.2"]);
  await expect(page.locator(".chart-panel.chart-overlay .chart-y-axis-title")).toContainText("100");
  await expect(page.locator(".chart-panel.chart-overlay")).toHaveAttribute("data-window-start", "0");
  await expect(page.locator(".chart-panel.chart-overlay")).toHaveAttribute("data-window-end", "1");
  await expect(page.locator(".chart-panel.chart-overlay .overlay-series-line")).toHaveCount(2);
  const chartAccessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(chartAccessibility.violations, JSON.stringify(chartAccessibility.violations, null, 2)).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("financial-charts.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(page.locator(".workbench-config")).toBeHidden();
  const chartLayout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    corePanel: document.querySelector(".chart-panel.chart-overlay")?.getBoundingClientRect().width,
  }));
  expect(chartLayout.document, JSON.stringify(chartLayout)).toBeLessThanOrEqual(chartLayout.viewport);
  await benchmarkButton.click();
  const tradeTab = page.getByRole("tab", { name: "取引明細" });
  await tradeTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "戦略比較" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab", { name: "戦略比較" })).toHaveAttribute("aria-selected", "true");
  await tradeTab.click();
  await expect(tradeTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#result-panel-trades .result-display-heading, #result-panel-trades .display-toggle")).toHaveCount(0);
  await expect(page.getByRole("table").last()).toBeVisible();
  await chartToggle.click();
  await expect(page.locator(".trade-table")).toBeVisible();
  await chartToggle.click();
  await page.getByRole("tab", { name: "戦略比較" }).click();
  await expect(page.locator(".comparison-table")).toHaveCount(1);
  await tradeTab.click();
  await expect(page.getByRole("table").last()).toBeVisible();

  await expect(page.locator("[data-export-kind]")).toHaveCount(4);
  await expect(page.locator('[data-export-kind="summary"]')).toBeEnabled();
  await expect(page.locator('[data-export-kind="daily-assets"]')).toBeEnabled();
  await expect(page.locator('[data-export-kind="trades"]')).toBeEnabled();
  await expect(page.locator('[data-export-kind="search-results"]')).toBeDisabled();
  const downloadPromise = page.waitForEvent("download");
  await page.locator('[data-export-kind="summary"]').click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const { readFile } = await import("node:fs/promises");
  const csv = await readFile(downloadPath, "utf8");
  const [header, row] = csv.trim().split(/\r?\n/);
  const headers = header.split(",");
  const values = row.split(",");
  const exported = Object.fromEntries(headers.map((name, index) => [name, values[index]]));
  expect(exported.resultId).toBe(benchmark.id);
  expect(exported.endingEquity).toBe(String(benchmark.metrics.endingEquity));

  const dailyAssetsDownloadPromise = page.waitForEvent("download");
  await page.locator('[data-export-kind="daily-assets"]').click();
  const dailyAssetsDownload = await dailyAssetsDownloadPromise;
  const dailyAssetsCsv = await readFile(await dailyAssetsDownload.path(), "utf8");
  expect(dailyAssetsCsv).toContain("date");
  expect(dailyAssetsCsv).toContain("totalAsset");

  const tradesDownloadPromise = page.waitForEvent("download");
  await page.locator('[data-export-kind="trades"]').click();
  const tradesDownload = await tradesDownloadPromise;
  const tradesCsv = await readFile(await tradesDownload.path(), "utf8");
  expect(tradesCsv).toContain("date");
  expect(tradesCsv).toContain("quantity");

  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.locator(".workbench-config")).toBeVisible();
  await page.locator(".strategy-card-open").filter({ hasText: "ボラティリティ積立" }).click();
  await expect(page.locator(".strategy-dialog")).toBeVisible();
  await page.locator(".strategy-dialog #field-strategy-vix_dca-1-vix-buyThreshold").fill("28");
  await closeStrategyDialog(page);
  await page.getByRole("button", { name: "結果", exact: true }).click();
  await expect(page.locator(".snapshot-warning")).toHaveCount(0);
  const staleDownloadPromise = page.waitForEvent("download");
  await page.locator('[data-export-kind="summary"]').click();
  const staleDownload = await staleDownloadPromise;
  const stalePath = await staleDownload.path();
  const staleCsv = await readFile(stalePath, "utf8");
  const [staleHeader, staleRow] = staleCsv.trim().split(/\r?\n/);
  const staleHeaders = staleHeader.split(",");
  const staleValues = staleRow.split(",");
  const staleExported = Object.fromEntries(staleHeaders.map((name, index) => [name, staleValues[index]]));
  expect(staleExported.resultId).toBe(benchmark.id);
  expect(staleExported.endingEquity).toBe(exported.endingEquity);

  const latestResponse = page.waitForResponse((response) =>
    response.request().method() === "GET" && response.url().endsWith("/api/v1/runs/latest"),
  );
  await page.reload();
  const restoredResponse = await latestResponse;
  const restored = await restoredResponse.json();
  expect(restored.runId).toBe(saved.runId);
  expect(restored.status).toBe("completed");
  await expect(page.locator(".run-status-panel")).toHaveCount(0);
  const restoredStrategy = restored.result.strategyRuns.find(
    (item) => item.id === "strategy-vix_dca-1",
  );
  const restoredDownloadPromise = page.waitForEvent("download");
  await page.locator('[data-export-kind="summary"]').click();
  const restoredDownload = await restoredDownloadPromise;
  const restoredDownloadPath = await restoredDownload.path();
  expect(restoredDownloadPath).toBeTruthy();
  const restoredCsv = await readFile(restoredDownloadPath, "utf8");
  const [restoredHeader, restoredRow] = restoredCsv.trim().split(/\r?\n/);
  const restoredHeaders = restoredHeader.split(",");
  const restoredValues = restoredRow.split(",");
  const restoredExport = Object.fromEntries(
    restoredHeaders.map((name, index) => [name, restoredValues[index]]),
  );
  expect(restoredExport.resultId).toBe(restoredStrategy.id);
  expect(restoredExport.endingEquity).toBe(String(restoredStrategy.metrics.endingEquity));

  const nextSavedResponse = page.waitForResponse(async (response) => {
    if (response.request().method() !== "GET" || !/\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url()) || !response.ok()) {
      return false;
    }
    return ["completed", "completed_with_warning", "unavailable", "failed"]
      .includes((await response.json()).status);
  });
  await page.getByRole("button", { name: "バックテストを実行" }).click();
  const nextSaved = await (await nextSavedResponse).json();
  expect(nextSaved.runId).not.toBe(saved.runId);
  await expect(page.getByRole("tab", { name: "戦略比較" })).toHaveAttribute("aria-selected", "true");

  const pending = structuredClone(saved);
  pending.status = "running";
  pending.progress = {
    completedStrategies: 1,
    totalStrategies: saved.progress.totalStrategies,
    currentStrategyId: "strategy-vix_dca-1",
  };
  pending.result.status = "running";
  const strategyStatuses = Object.fromEntries(
    saved.result.strategyRuns.map(({ id, status }) => [id, status]),
  );
  const terminalEvent = {
    runId: saved.runId,
    status: saved.status,
    progress: saved.progress,
    strategyStatuses,
  };
  await page.route("**/api/v1/runs/latest", (route) =>
    route.fulfill({ json: pending }),
  );
  await page.route(`**/api/v1/runs/${saved.runId}/events`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `event: terminal\ndata: ${JSON.stringify(terminalEvent)}\n\n`,
    }),
  );
  const resumedEvents = [];
  const resumedResultGets = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    if (request.url().endsWith(`/api/v1/runs/${saved.runId}/events`)) {
      resumedEvents.push(request.url());
    } else if (request.url().endsWith(`/api/v1/runs/${saved.runId}`)) {
      resumedResultGets.push(request.url());
    }
  });
  const resumedResultResponse = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    response.url().endsWith(`/api/v1/runs/${saved.runId}`),
  );
  await page.reload();
  await resumedResultResponse;
  expect(resumedEvents).toHaveLength(1);
  expect(resumedResultGets).toHaveLength(1);
  await expect(page.locator(".run-status-panel")).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".workbench-config")).toBeVisible();
  const persistentSettingsToggle = page.locator(".workbench-divider .workbench-config-toggle");
  await persistentSettingsToggle.click();
  await expect(persistentSettingsToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".workbench-config")).toBeHidden();
  await expect(persistentSettingsToggle).toBeVisible();
  const scrollState = await page.locator(".workbench-results").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return { top: element.scrollTop, max: element.scrollHeight - element.clientHeight };
  });
  if (scrollState.max > 0) expect(scrollState.top).toBe(scrollState.max);
  await expect(persistentSettingsToggle).toBeVisible();
  await persistentSettingsToggle.click();
  await expect(page.locator(".workbench-config")).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(nonLocalRequests).toEqual([]);
});

test("adding a strategy keeps the default run scope on every enabled strategy", async ({ page }) => {
  await page.goto("/");
  await openSharedSettings(page);
  await page.getByLabel("開始日").fill("2024-01-31");

  await page.locator("#field-run-endDate").fill("2024-02-02");
  await closeSharedSettings(page);

  await addStrategy(page, "ma_buy_only");
  await expect(page.locator(".strategy-card")).toHaveCount(2);

  const runSubmission = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().endsWith("/api/v1/runs"),
  );
  await page.getByRole("button", { name: "バックテストを実行" }).click();
  const request = await runSubmission;
  const payload = request.postDataJSON();
  expect(payload.scope).toBe("all_enabled");
  expect(payload.draft.strategies.map((strategy) => strategy.id))
    .toEqual(["strategy-vix_dca-1", "strategy-ma_buy_only-2"]);

  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(4);
  await expect(page.locator(".comparison-table tbody tr")
    .filter({ hasText: "ボラティリティ積立" })).toHaveCount(1);
  await expect(page.locator(".comparison-table tbody tr")
    .filter({ hasText: "移動平均トレンド（買付のみ）" })).toHaveCount(1);
});

test("desktop workbench keeps the header, strategy list, and results in independent scroll regions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto("/");
  await expect(page.locator(".strategy-navigator .strategy-card-list")).toBeVisible();
  await expect(page.locator(".strategy-parameter-groups")).toHaveCount(0);
  await expect(page.locator(".workbench-results")).toBeVisible();
  await expect(page.getByRole("button", { name: "バックテストを実行" })).toBeEnabled();

  const finalRun = page.waitForResponse(async (response) => {
    if (response.request().method() !== "GET" || response.url().endsWith("/latest") ||
        !/\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url())) return false;
    if (!response.ok()) return false;
    return ["completed", "completed_with_warning", "unavailable", "failed"]
      .includes((await response.json()).status);
  });
  await page.getByRole("button", { name: "バックテストを実行" }).click();
  await finalRun;

  for (const presetId of ["composite_dca", "ma_buy_only", "ma_trend", "grid_search"]) {
    await addStrategy(page, presetId);
  }
  // Five unique cards still require a genuinely short desktop viewport to overflow.
  await page.setViewportSize({ width: 1440, height: 400 });

  const strategyList = page.locator(".strategy-navigator .strategy-card-list");
  const results = page.locator(".workbench-results");
  await expect.poll(async () => strategyList.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(async () => results.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  const fixedBefore = await page.evaluate(() => ({
    pageY: window.scrollY,
    topbarTop: document.querySelector(".app-topbar").getBoundingClientRect().top,
    contextTop: document.querySelector(".workbench-context").getBoundingClientRect().top,
    selectorsTop: document.querySelector(".workbench-config-fixed").getBoundingClientRect().top,
  }));
  await strategyList.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => strategyList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => results.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await page.evaluate(() => ({
    pageY: window.scrollY,
    topbarTop: document.querySelector(".app-topbar").getBoundingClientRect().top,
    contextTop: document.querySelector(".workbench-context").getBoundingClientRect().top,
    selectorsTop: document.querySelector(".workbench-config-fixed").getBoundingClientRect().top,
  }))).toEqual(fixedBefore);

  const strategyScrollTop = await strategyList.evaluate((element) => element.scrollTop);
  await results.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => results.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => strategyList.evaluate((element) => element.scrollTop)).toBe(strategyScrollTop);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await expect(page.getByRole("separator")).toHaveCount(0);
  const toggle = page.locator(".workbench-config-toggle");
  const railPosition = await toggle.boundingBox();
  await page.getByRole("button", { name: "設定を閉じる" }).click();
  await expect(page.locator(".workbench-config")).toBeHidden();
  await expect(page.locator(".workbench-results")).toBeVisible();
  const hiddenPosition = await toggle.boundingBox();
  expect(hiddenPosition.y).toBe(railPosition.y);
  expect(hiddenPosition.x).toBeLessThan(railPosition.x);
  await page.getByRole("button", { name: "設定を表示" }).click();
  await expect(page.locator(".workbench-config")).toBeVisible();
});

test("draft dialogs never mutate saved result content and reset survives refresh", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await openSharedSettings(page);
  await page.locator("#field-run-startDate").fill("2024-01-31");

  await page.locator("#field-run-endDate").fill("2024-02-02");
  await closeSharedSettings(page);
  const resultResponse = page.waitForResponse((response) => response.ok() &&
    response.request().method() === "GET" && /\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url()));
  await page.locator(".run-submit-button").click();
  const saved = await (await resultResponse).json();
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  const results = page.locator(".workbench-results");
  const original = await results.innerHTML();
  await openSharedSettings(page);
  await page.locator("#field-contribution-amount").fill("-1");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await expect(page.locator(".shared-settings-dialog .field-error")).toBeVisible();
  expect(await results.innerHTML()).toBe(original);
  await page.locator("#field-contribution-amount").fill("100");
  await expect(page.locator(".shared-settings-dialog .field-error")).toHaveCount(0);
  await closeSharedSettings(page);
  expect(await results.innerHTML()).toBe(original);
  await page.locator(".strategy-card-open").first().click();
  await page.locator("#field-strategy-vix_dca-1-vix-buyThreshold").fill("-1");
  await page.locator(".strategy-dialog .dialog-done").click();
  await expect(page.locator(".strategy-dialog .field-error")).toBeVisible();
  expect(await results.innerHTML()).toBe(original);
  await page.locator("#field-strategy-vix_dca-1-vix-buyThreshold").fill("25");
  await closeStrategyDialog(page);
  expect(await results.innerHTML()).toBe(original);
  await page.locator(".run-reset-button").click();
  await expect(page.locator(".empty-results")).toBeVisible();
  await expect(page.locator("[data-export-kind]:enabled")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await expect(page.locator(".empty-results")).toBeVisible();
  await expect(page.locator(".comparison-table")).toHaveCount(0);
  const nextResponse = page.waitForResponse((response) => response.ok() &&
    response.request().method() === "GET" && /\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url()));
  await page.locator(".run-submit-button").click();
  const next = await (await nextResponse).json();
  expect(next.runId).not.toBe(saved.runId);
  await page.reload();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
});


test("strategy heading menu opens below its plus, supports arrows, dismisses outside and restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const add = page.locator(".add-strategy-button");
  const menu = page.locator(".strategy-add-menu");
  await add.focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu).toBeVisible();
  const first = menu.locator('button:not(:disabled)').first();
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.locator('button:not(:disabled)').nth(1)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(add).toBeFocused();
  await add.click();
  await page.locator(".topbar-brand").click();
  await expect(menu).toBeHidden();
  await add.click();
  const boxes = [await add.boundingBox(), await menu.boundingBox()];
  expect(boxes[1].y).toBeGreaterThanOrEqual(boxes[0].y + boxes[0].height);
  expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[0].x + boxes[0].width + 1);
  await menu.locator('[data-preset-id="rsi_dca"]').click();
  await expect(page.locator(".strategy-card")).toHaveCount(2);
  await expect(menu).toBeHidden();
  await expect(add).toBeFocused();
});

test("optional strategy cards reveal actions on hover, reject duplicates and run all enabled", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".strategy-add-option")).toHaveCount(10);
  await expect(page.locator('.strategy-add-option[data-preset-id="monthly_dca"], .strategy-add-option[data-preset-id="lump_sum"]')).toHaveCount(0);
  await expect(page.locator('.strategy-add-option[data-preset-id="vix_dca"]')).toBeDisabled();
  await expect(page.locator(".strategy-run-target, .workbench-divider-grip, .local-tag, #run-scope-select")).toHaveCount(0);
  await expect(page.locator(".add-strategy-button svg")).toBeVisible();
  const card = page.locator(".strategy-card").first();
  const actions = card.locator(".strategy-card-actions");
  await page.mouse.move(1400, 850);
  await expect(actions).toHaveCSS("opacity", "0");
  await card.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await expect(card.getByRole("switch")).toHaveCount(0);
  await page.mouse.move(1400, 850);
  await expect(actions).toHaveCSS("opacity", "0");
  await card.locator(".strategy-card-open").focus();
  await page.keyboard.press("Tab");
  await expect(card.locator(".strategy-remove")).toBeFocused();
  await addStrategy(page, "ma_buy_only");
  await expect(page.locator('.strategy-add-option[data-preset-id="ma_buy_only"]')).toBeDisabled();
  await expect(page.locator(".strategy-card")).toHaveCount(2);
  await card.locator(".strategy-card-open").click();
  await closeStrategyDialog(page);
  const submitted = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/api/v1/runs"));
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await page.locator(".run-submit-button").click();
  const payload = (await submitted).postDataJSON();
  expect(payload.scope).toBe("all_enabled");
  expect(payload.draft.strategies).toHaveLength(2);
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(4);
  const addedCard = page.locator(".strategy-card").nth(1);
  await addedCard.hover();
  await addedCard.locator(".strategy-remove").click();
  await expect(page.locator('.strategy-add-option[data-preset-id="ma_buy_only"]')).toBeEnabled();
});

test("borderless chevron stays on the sidebar boundary and repeatedly reopens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const toggle = page.locator(".workbench-config-toggle");
  const divider = page.locator(".workbench-divider");
  await expect(toggle).toHaveCSS("border-top-width", "0px");
  await expect(toggle).toHaveCSS("background-color", await themeColor(page, "--app-bg"));
  await toggle.hover();
  await expect(toggle).toHaveCSS("background-color", await themeColor(page, "--app-bg"));
  await expect(toggle.locator("svg")).toHaveCSS("stroke-width", "2.8px");
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const configBounds = await page.locator(".workbench-config").boundingBox();
    const dividerBounds = await divider.boundingBox();
    const resultsBounds = await page.locator(".workbench-results").boundingBox();
    const toggleBounds = await toggle.boundingBox();
    expect(dividerBounds.x).toBeCloseTo(configBounds.x + configBounds.width, 0);
    expect(dividerBounds.x + dividerBounds.width).toBeCloseTo(resultsBounds.x, 0);
    expect(toggleBounds.x + toggleBounds.width / 2).toBeCloseTo(dividerBounds.x + dividerBounds.width / 2, 0);
    await expect(toggle.locator("path")).toHaveAttribute("d", "m13 5-5 5 5 5");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle.locator("path")).toHaveAttribute("d", "m7 5 5 5-5 5");
    await expect(page.locator(".workbench-config")).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
});

test("multi-selected curves match row colors while focus, CSV and the shared window stay independent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openSharedSettings(page);
  await page.locator("#field-run-startDate").fill("2024-01-31");

  await page.locator("#field-run-endDate").fill("2024-03-01");
  await closeSharedSettings(page);
  const response = page.waitForResponse(response => response.ok() && response.request().method() === "GET" && /\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url()));
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await page.locator(".run-submit-button").click();
  const saved = await (await response).json();
  const rows = page.locator(".comparison-table tbody tr");
  const monthly = rows.filter({ hasText: "毎月定額積立" });
  const lump = rows.filter({ hasText: "一括投資" });
  const vix = rows.filter({ hasText: "ボラティリティ積立" });
  await vix.locator("button").click();
  await monthly.locator("button").click();
  await lump.locator("button").click();
  await expect(vix.locator("button")).toHaveAttribute("aria-pressed", "true");
  await expect(monthly.locator("button")).toHaveAttribute("aria-pressed", "true");
  await expect(lump.locator("button")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".comparison-overlay-series"), JSON.stringify(saved.result.strategyRuns.map(result => ({ id: result.id, status: result.status, assetCount: result.dailyAssets.length, principal: result.dailyAssets.at(-1)?.totalContributed })))).toHaveCount(2);
  for (const [row, preset] of [[monthly, "monthly_dca"], [lump, "lump_sum"]]) {
    const result = saved.result.strategyRuns.find(item => item.presetId === preset);
    const color = await row.evaluate(el => el.style.getPropertyValue("--result-color"));
    await expect((preset === "lump_sum" ? page.locator(".chart-overlay polyline.overlay-totalAsset") : page.locator(`.chart-overlay [data-result-id="${result.id}"] polyline`))).toHaveAttribute("stroke", color);
  }
  const chart = page.locator(".chart-overlay");
  await page.getByRole("button", { name: "期間を拡大", exact: true }).click();
  const windowBefore = [await chart.getAttribute("data-window-start"), await chart.getAttribute("data-window-end")];
  await monthly.locator("button").click();
  await expect(monthly.locator("button")).toHaveAttribute("aria-pressed", "false");
  await expect(chart).toHaveAttribute("data-window-start", windowBefore[0]);
  await expect(chart).toHaveAttribute("data-window-end", windowBefore[1]);
  const downloadEvent = page.waitForEvent("download");
  await page.locator('[data-export-kind="summary"]').click();
  const download = await downloadEvent;
  const { readFile } = await import("node:fs/promises");
  const csv = await readFile(await download.path(), "utf8");
  expect(csv).toContain("benchmark:monthly-dca");
  expect(csv).toContain("actualInvested,totalContributed");
  await lump.locator("button").click();
  await vix.locator("button").click();
  await expect(page.locator(".comparison-overlay-series, g.overlay-totalAsset")).toHaveCount(0);
  await expect(page.locator("g.overlay-price")).toHaveCount(1);
  await expect(monthly.locator("button")).toHaveAttribute("aria-pressed", "false");
  await vix.locator("button").click();
  const legend = chart.locator('.overlay-legend-item[data-series="totalAsset"]');
  await legend.click();
  await page.mouse.move(1400, 850);
  await expect(legend).toHaveAttribute("aria-pressed", "true");
  await expect(chart.locator(".chart-highlight-area")).toHaveCount(1);
  await legend.click();
  await page.mouse.move(1400, 850);
  await legend.blur();
  await expect(legend).toHaveAttribute("aria-pressed", "false");
  await expect(chart.locator(".chart-highlight-area")).toHaveCount(0);
});

test("strategy menu, condition connectors and comparison selections retain full touch targets", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 700 }, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto(baseURL);
    await openSharedSettings(page);
    await closeSharedSettings(page);
    await page.locator(".add-strategy-button").tap();
    const targets = await page.locator(".strategy-add-option:not(:disabled)").evaluateAll(nodes =>
      nodes.map(node => ({ control: "menu", height: node.offsetHeight })),
    );
    await page.locator('.strategy-add-option[data-preset-id="composite_dca"]').tap();
    await page.locator(".strategy-card-open").last().tap();
    const buy = page.locator('[data-rule-side="buy"]');
    await buy.locator(".condition-add-select").selectOption("rsi");
    targets.push(...await buy.locator(".field-segment").evaluateAll(nodes =>
      nodes.map(node => ({ control: "AND/OR", height: node.offsetHeight })),
    ));
    await closeStrategyDialog(page);
    await openSharedSettings(page);
    await page.locator("#field-run-startDate").fill("2024-01-31");

    await page.locator("#field-run-endDate").fill("2024-03-01");
    await closeSharedSettings(page);
    await page.locator(".run-submit-button").tap();
    await page.locator(".workbench-mobile-view").last().tap();
    await expect(page.locator(".comparison-table")).toBeVisible();
    await expect(page.locator(".run-submit-button")).toBeEnabled();
    targets.push(...await page.locator(".comparison-table .result-select").evaluateAll(nodes =>
      nodes.map(node => ({ control: "comparison", height: (node.closest("label") ?? node).offsetHeight })),
    ));
    expect(targets.length).toBeGreaterThan(10);
    for (const target of targets) expect(target.height, JSON.stringify(targets)).toBeGreaterThanOrEqual(44);
    const selection = page.locator('.comparison-table .result-select').first();
    await expect(page.locator('.comparison-table .result-select[aria-pressed="true"]')).toHaveCount(0);
    await selection.tap();
    await expect(selection).toHaveAttribute("aria-pressed", "true");
    await selection.tap();
    await expect(page.locator('.comparison-table .result-select[aria-pressed="true"]')).toHaveCount(0);
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("many selected strategies naturally expand readings and scroll the results pane", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/");
  await openSharedSettings(page);
  await page.locator("#field-run-startDate").fill("2024-01-31");

  await page.locator("#field-run-endDate").fill("2024-03-01");
  await closeSharedSettings(page);
  const response = page.waitForResponse(response => response.ok() && response.request().method() === "GET" && /\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url()));
  await page.locator(".run-submit-button").click();
  const saved = await (await response).json();
  const extended = structuredClone(saved);
  for (let index = 0; index < 9; index += 1) {
    const id = `historical-custom-${index}`;
    extended.result.strategyRuns.push({ ...structuredClone(saved.result.strategyRuns[0]), id, presetId: "composite_dca" });
    extended.selectedStrategyIds.push(id);
    extended.snapshot.config.strategies.push({ ...structuredClone(saved.snapshot.config.strategies[0]), id, presetId: "composite_dca" });
  }
  await page.route("**/api/v1/runs/latest", route => route.fulfill({ json: extended }));
  await page.reload();
  const toggles = page.locator(".result-select");
  await expect(toggles).toHaveCount(12);
  for (const toggle of await toggles.all()) if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  const row = page.locator(".chart-core-readout-row");
  await row.scrollIntoViewIfNeeded();
  const geometry = await row.evaluate(node => ({ height: node.clientHeight, contentHeight: node.scrollHeight, overflow: getComputedStyle(node).overflowY }));
  expect(geometry.height).toBeGreaterThanOrEqual(geometry.contentHeight - 1);
  expect(geometry.overflow).toBe("visible");
  await expect(row.locator(".chart-strategy-readout")).toHaveCount(12);
  const results = page.locator(".workbench-results");
  const before = await results.evaluate(node => node.scrollTop);
  await row.hover();
  await page.mouse.wheel(0, 140);
  await expect.poll(() => results.evaluate(node => node.scrollTop)).toBeGreaterThan(before);
  expect(await row.evaluate(node => node.scrollTop)).toBe(0);
  const last = row.locator(".chart-strategy-readout").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("add and condition removal icons keep visible strokes and legible dimensions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const plus = await page.locator(".add-strategy-button svg").boundingBox();
  await addStrategy(page, "composite_dca");
  await page.locator(".strategy-card-open").last().click();
  const remove = await page.locator(".condition-remove svg").first().evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height, stroke: getComputedStyle(node).stroke };
  });
  expect(remove.stroke).not.toBe("none");
  expect(remove.width).toBe(18);
  expect(remove.height).toBe(18);
  expect(plus.width).toBeGreaterThanOrEqual(18);
  expect(plus.height).toBeGreaterThanOrEqual(18);
  await page.screenshot({ path: test.info().outputPath("visible-condition-actions.png") });
});

test("comparison consolidates metrics, selects results by row and trades keep a sticky header", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  const resultResponse = page.waitForResponse((response) => response.ok() &&
    response.request().method() === "GET" && /\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url()));
  await page.locator(".run-submit-button").click();
  const saved = await (await resultResponse).json();
  // Exercise long-list rendering independently of the fixture provider's short history.
  const longList = structuredClone(saved);
  const monthly = longList.result.strategyRuns.find((result) => result.presetId === "monthly_dca");
  monthly.trades = Array.from({ length: 200 }, (_, index) => monthly.trades[index % monthly.trades.length]);
  await page.route("**/api/v1/runs/latest", (route) => route.fulfill({ json: longList }));
  await page.reload();
  await expect(page.locator("#result-tab-comparison")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#result-focus-select, #result-tab-overview, #result-tab-metrics, .metric-card")).toHaveCount(0);
  await expect(page.locator(".comparison-table thead th")).toHaveCount(9);
  const benchmark = saved.result.strategyRuns.find((result) => result.presetId === "monthly_dca" && result.role === "benchmark");
  const row = page.locator(".comparison-table tbody tr").filter({ hasText: "毎月定額積立" });
  await row.locator("td").last().click();
  await expect(row.locator("button")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".result-snapshot-info")).toHaveCount(0);
  await page.getByRole("tab", { name: "取引明細" }).click();
  await expect(page.locator(".result-trades-context")).toHaveText("毎月定額積立");
  const scroll = page.locator(".trade-table-scroll");
  await expect(scroll).toBeVisible();
  const initial = await scroll.evaluate((element) => {
    const th = element.querySelector("th");
    return { height: element.clientHeight, overflow: element.scrollHeight - element.clientHeight, headTop: th.getBoundingClientRect().top };
  });
  expect(initial.height).toBeLessThanOrEqual(420);
  expect(initial.overflow).toBeGreaterThan(0);
  await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const headTop = await scroll.locator("th").first().evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(headTop - initial.headTop)).toBeLessThanOrEqual(2);
  const csv = page.locator('[data-export-kind="summary"]');
  await expect(csv).toContainText(".csv");
  await expect(csv.locator(".export-download-icon")).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await csv.click();
  const download = await downloadEvent;
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(await download.path(), "utf8");
  expect(content).toContain(benchmark.id);
  expect(content).toContain(String(benchmark.metrics.endingEquity));
});

test("linked figures share widths, halve indicator height, and highlight legends without gaps", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await openSharedSettings(page);
  await page.locator("#field-run-startDate").fill("2024-01-31");

  await page.locator("#field-run-endDate").fill("2024-02-02");
  await closeSharedSettings(page);
  const completed = page.waitForResponse((response) => response.ok() && response.request().method() === "GET" && /\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url()));
  await page.locator(".run-submit-button").click();
  await completed;
  await page.locator(".comparison-table").getByRole("button", { name: "ボラティリティ積立", exact: true }).click();
  for (const width of [1440, 1920, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const sizes = await page.locator(".result-chart").evaluateAll((charts) => charts.map((chart) => {
      const bounds = chart.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    }));
    expect(sizes).toHaveLength(3);
    expect(Math.max(...sizes.map((size) => size.width)) - Math.min(...sizes.map((size) => size.width))).toBeLessThanOrEqual(3);
    expect(sizes[0].height).toBeCloseTo(sizes[0].width * 274 / 800, 1);
    for (const size of sizes.slice(1)) expect(size.height).toBeCloseTo(size.width * 180 / 800 / 2, 1);
    const gaps = await page.locator(".chart-linked-stack figure").evaluateAll(figures => figures.slice(1).map((figure,index) => figure.getBoundingClientRect().top - figures[index].getBoundingClientRect().bottom));
    for (const gap of gaps) expect(Math.abs(gap)).toBeLessThanOrEqual(1);
    await expect(page.locator(".chart-x-axis-title")).toHaveCount(1);
    const axisLabels = await page.locator(".chart-y-axis-title").evaluateAll(labels => labels.map(label => {
      const text = label.getBoundingClientRect();
      const chart = label.ownerSVGElement.getBoundingClientRect();
      return { top: text.top, bottom: text.bottom, chartTop: chart.top, chartBottom: chart.bottom };
    }));
    for (const label of axisLabels) {
      expect(label.top, "value axis label stays inside its chart").toBeGreaterThanOrEqual(label.chartTop - 1);
      expect(label.bottom, "value axis label stays inside its chart").toBeLessThanOrEqual(label.chartBottom + 1);
    }
  }
  const core = page.locator(".chart-overlay");
  await expect(core.locator(".chart-trade-marker")).toHaveCount(0);
  await core.locator('.overlay-legend-item[data-series="totalAsset"]').hover();
  const tradeAnchors = await core.evaluate(figure => {
    const curve = figure.querySelector("polyline.overlay-totalAsset");
    const points = [...curve.points];
    return [...figure.querySelectorAll(".chart-trade-marker")].map(marker => {
      const tip = marker.points[0];
      const point = points.find(candidate => Math.abs(candidate.x - tip.x) < 0.001);
      const direction = marker.classList.contains("chart-trade-marker-buy") ? 1 : -1;
      return {
        anchor: marker.dataset.anchorSeries,
        difference: point ? Math.abs(tip.y - direction * 7 - point.y) : null,
      };
    });
  });
  expect(tradeAnchors.length).toBeGreaterThan(0);
  for (const marker of tradeAnchors) {
    expect(marker.anchor).toBe("totalAsset");
    expect(marker.difference).not.toBeNull();
    expect(marker.difference).toBeLessThan(0.001);
  }
  const mainPlotHeight = await core.locator("svg.result-chart").evaluate(svg =>
    Number(svg.dataset.plotBottom) - Number(svg.dataset.plotTop));
  for (const [seriesId, bottomChart] of [["vix", "drawdown"], ["drawdown", "overlay"], ["drawdown", "drawdown"], ["vix", "vix"]]) {
    await page.locator(`.chart-legend .legend-toggle[data-series="${seriesId}"]`).click();
    await expect(page.locator(".chart-x-axis-title")).toHaveCount(1);
    await expect(page.locator(".chart-date-axis .chart-x-axis-title")).toHaveCount(1);
    await expect(page.locator(`[data-chart-id="${bottomChart}"] .chart-x-axis-title`)).toHaveCount(0);
    const plots = await page.locator(".chart-panel.is-compact svg.result-chart").evaluateAll(charts => charts.map(chart => Number(chart.dataset.plotBottom) - Number(chart.dataset.plotTop)));
    for (const height of plots) expect(height).toBe(74);
    expect(await core.locator("svg.result-chart").evaluate(svg =>
      Number(svg.dataset.plotBottom) - Number(svg.dataset.plotTop))).toBe(mainPlotHeight);
  }
  const initialWindow = await core.getAttribute("data-window-start");
  const priceLegend = core.locator('.overlay-legend-item[data-series="price"]');
  await priceLegend.hover();
  await expect(core.locator(".overlay-price.is-highlighted")).toHaveAttribute("stroke-width", "2.4");
  await expect(core.locator(".overlay-series-line.overlay-totalAsset")).toHaveAttribute("stroke-width", "1.2");
  await expect(core.locator(".chart-highlight-area")).toBeVisible();
  await expect(core.locator("linearGradient stop").first()).toHaveAttribute("stop-color", await core.locator(".overlay-price.is-highlighted").getAttribute("stroke"));
  await page.mouse.move(0, 0);
  await expect(core.locator(".chart-highlight-area")).toHaveCount(0);
  const assetLegend = core.locator('.overlay-legend-item[data-series="totalAsset"]');
  await assetLegend.focus();
  await expect(core.locator(".overlay-totalAsset.is-highlighted")).toHaveAttribute("stroke-width", "2.4");
  await expect(core.locator("linearGradient stop").first()).toHaveAttribute("stop-color", await core.locator(".overlay-totalAsset.is-highlighted").getAttribute("stroke"));
  await page.keyboard.press("Tab");
  await expect(core.locator(".chart-highlight-area")).toHaveCount(0);
  await expect(core).toHaveAttribute("data-window-start", initialWindow);
  await expect(page.locator(".chart-panel.is-compact figcaption")).toHaveCount(0);
  await expect(page.locator(".chart-panel.is-compact .overlay-legend, .chart-panel.is-compact .chart-highlight-area")).toHaveCount(0);
  await priceLegend.click();
  await page.mouse.move(0, 0);
  await page.locator(".chart-range-controls button").first().focus();
  await expect(priceLegend).toHaveAttribute("aria-pressed", "true");
  await expect(core.locator(".overlay-price.is-highlighted")).toHaveAttribute("stroke-width", "2.4");
  await assetLegend.click();
  await page.mouse.move(0, 0);
  await expect(priceLegend).toHaveAttribute("aria-pressed", "false");
  await expect(assetLegend).toHaveAttribute("aria-pressed", "true");
  await assetLegend.click();
  await expect(assetLegend).toHaveAttribute("aria-pressed", "false");
  await page.mouse.move(0, 0);
  await page.locator(".chart-range-controls button").first().focus();
  await expect(core.locator(".chart-highlight-area")).toHaveCount(0);
  await priceLegend.focus();
  await page.keyboard.press("Space");
  await page.locator(".chart-range-controls button").first().focus();
  await expect(priceLegend).toHaveAttribute("aria-pressed", "true");
  await priceLegend.focus();
  await page.keyboard.press("Enter");
  await expect(priceLegend).toHaveAttribute("aria-pressed", "false");
  await page.locator(".chart-range-controls button").first().focus();
  await expect(core.locator(".chart-highlight-area")).toHaveCount(0);
  await page.locator(".workbench-results").evaluate((element) => { element.scrollTop = 0; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: test.info().outputPath("refined-workbench-1440.png") });
  await page.locator("#result-details-toggle").click();
  await page.locator(".workbench-results").evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: test.info().outputPath("linked-charts-1440.png") });
});

test("context is concise and strategy dialogs show one combination label", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openSharedSettings(page);
  await page.locator("#field-run-startDate").fill("2024-01-31");
  await page.locator("#field-run-endDate").fill("2024-03-01");
  await closeSharedSettings(page);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await page.locator(".run-submit-button").click();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".shared-settings-summary-text")).toContainText("2024-03-01");
  await expect(page.locator(".shared-settings-summary-text")).not.toContainText("最新");
  await expect(page.locator(".result-saved-range, .result-focused-name, .strategy-parameter-nav")).toHaveCount(0);
  await expect(page.locator(".result-snapshot-info, .result-saved-context")).toHaveCount(0);
  await expect(page.locator(".chart-overlay figcaption, .overlay-legend").filter({ hasText: "QQQ" })).toHaveCount(0);
  await addStrategy(page, "composite_dca");
  await page.locator(".strategy-card-open").last().click();
  const dialog = page.locator(".strategy-dialog");
  await expect(dialog.locator(".strategy-parameter-nav, .strategy-editor-summary")).toHaveCount(0);
  await dialog.locator('[data-rule-side="buy"] .condition-add-select').first().selectOption("rsi");
  await expect(dialog.getByRole("radiogroup", { name: "隣接する条件カードの関係" })).toHaveCount(1);
  await expect(dialog.getByRole("radio", { name: "AND", exact: true })).toHaveCount(1);
  await expect(dialog.getByRole("radio", { name: "OR", exact: true })).toHaveCount(1);
  await closeStrategyDialog(page);
});

test("linked indicators keep natural units and wheel zoom can be released repeatedly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto("/");
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  const completed = page.waitForResponse((response) => response.ok() && response.request().method() === "GET" && /\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url()));
  await page.locator(".run-submit-button").click();
  await completed;
  await page.locator(".comparison-table tbody tr").filter({ hasText: "毎月定額積立" }).locator("button").click();
  const stack = page.locator(".chart-linked-stack");
  const core = stack.locator(".chart-overlay");
  const indicator = stack.locator(".chart-drawdown");
  const svg = core.locator("svg.result-chart");
  await expect(core.locator(".chart-y-tick")).toHaveCount(8);
  await expect(core.locator(".chart-x-tick")).toHaveCount(0);
  await expect(indicator.locator(".chart-x-tick")).toHaveCount(0);
  await expect(stack.locator(".chart-date-axis .chart-x-tick")).toHaveCount(7);
  const dateBounds = await stack.locator(".chart-date-axis .chart-x-tick").evaluateAll((labels) => labels.map((label) => {
    const box = label.getBBox();
    return { left: box.x, right: box.x + box.width };
  }));
  for (const box of dateBounds) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(800);
  }
  await expect(indicator.locator("svg.result-chart")).toHaveAccessibleName(/ドローダウン.*%/);
  await expect(indicator.locator("svg.result-chart")).toHaveAttribute("viewBox", "0 0 800 90");
  const sizes = await stack.locator("svg.result-chart").evaluateAll((charts) => charts.map((chart) => {
    const b = chart.getBoundingClientRect();
    return { width: b.width, height: b.height };
  }));
  expect(sizes).toHaveLength(2);
  expect(sizes[1].width).toBeCloseTo(sizes[0].width, 0);
  expect(sizes[1].height).toBeLessThan(sizes[0].height * .65);
  await expect(svg).toHaveCSS("user-select", "none");
  const toggle = page.locator(".chart-wheel-zoom-toggle");
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toHaveCSS("background-color", await themeColor(page, "--app-accent"));
    await svg.scrollIntoViewIfNeeded();
    const box = await svg.boundingBox();
    const start = Number(await core.getAttribute("data-window-start"));
    const end = Number(await core.getAttribute("data-window-end"));
    await page.mouse.move(box.x + box.width * .55, Math.min(650, box.y + box.height * .4));
    await page.mouse.wheel(0, -100);
    await expect.poll(async () => Number(await core.getAttribute("data-window-end")) - Number(await core.getAttribute("data-window-start"))).toBeLessThan(end - start);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).toHaveCSS("background-color", "rgb(255, 255, 255)");
    const windowBefore = [await core.getAttribute("data-window-start"), await core.getAttribute("data-window-end")];
    await svg.scrollIntoViewIfNeeded();
    const nextBox = await svg.boundingBox();
    await page.mouse.move(nextBox.x + nextBox.width * .55, Math.min(650, nextBox.y + nextBox.height * .4));
    await page.mouse.wheel(0, 80);
    await expect(core).toHaveAttribute("data-window-start", windowBefore[0]);
    await expect(core).toHaveAttribute("data-window-end", windowBefore[1]);
  }
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.mouse.move(box.x + box.width * .5, Math.min(640, box.y + box.height * .35));
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .15, Math.min(640, box.y + box.height * .35), { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  const windows = await stack.locator("figure").evaluateAll((figures) => figures.map((figure) => [figure.dataset.windowStart, figure.dataset.windowEnd]));
  expect(windows[1]).toEqual(windows[0]);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("linked-chart-workbench.png") });
});


test("fixed and custom dialogs reuse condition cards, nest independent groups and freeze submitted rules", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".strategy-card-open").first().click();
  let dialog = page.locator(".strategy-dialog");
  await expect(dialog.locator(".strategy-rule-section")).toHaveCount(2);
  await expect(dialog.locator(".condition-add-select, .condition-remove, .condition-logic-connector")).toHaveCount(0);
  const headerGeometry = await dialog.locator('[data-rule-side="buy"] .condition-heading').evaluate(header => {
    const title = header.querySelector("h3").getBoundingClientRect();
    const toggle = header.querySelector('[role="switch"]').getBoundingClientRect();
    return { titleY: title.y + title.height / 2, toggleY: toggle.y + toggle.height / 2, right: toggle.right, edge: header.getBoundingClientRect().right };
  });
  expect(Math.abs(headerGeometry.titleY - headerGeometry.toggleY)).toBeLessThan(2);
  expect(headerGeometry.right).toBeCloseTo(headerGeometry.edge, 0);
  await closeStrategyDialog(page);
  await addStrategy(page, "composite_dca");
  const trigger = page.locator(".strategy-card-open").last();
  await trigger.click();
  dialog = page.locator(".strategy-dialog");
  const buy = dialog.locator('[data-rule-side="buy"]');
  const root = buy.locator('.condition-group.is-root');
  await root.locator('.condition-add-select').first().selectOption("rsi");
  await root.locator('.condition-add-select').first().selectOption("group");
  const group = root.locator('.condition-group:not(.is-root)');
  await group.locator('.condition-add-select').selectOption("ma_deviation");
  await group.locator('.condition-add-select').selectOption("ma_trend");
  await group.locator('[data-condition-kind="ma_deviation"] input[id$="-ma-buyDeviationPct"]').fill("35");
  await group.locator('[data-condition-kind="ma_trend"] input[type="number"]').fill("5");
  const rootConnectors = root.locator(':scope > .condition-group-content > .condition-child > .condition-logic-connector');
  await expect(rootConnectors).toHaveCount(2);
  await rootConnectors.first().getByRole("radio", { name: "OR", exact: true }).check();
  await expect(rootConnectors.last().getByRole("radio", { name: "OR", exact: true })).toBeChecked();
  await expect(group.getByRole("radio", { name: "AND", exact: true })).toBeChecked();
  const geometry = await rootConnectors.first().evaluate(connector => {
    const lines = [...connector.querySelectorAll('.condition-logic-line')].map(line => line.getBoundingClientRect());
    const control = connector.querySelector('[role="radiogroup"]').getBoundingClientRect();
    return { y: lines.map(line => line.y + line.height / 2), controlY: control.y + control.height / 2, left: lines[0].width, right: lines[1].width };
  });
  expect(geometry.left).toBeGreaterThan(0);
  expect(geometry.right).toBeCloseTo(geometry.left, 0);
  for (const y of geometry.y) expect(y).toBeCloseTo(geometry.controlY, 0);
  await closeStrategyDialog(page);
  await trigger.click();
  await expect(group.locator('[data-condition-kind="ma_deviation"] input[id$="-ma-buyDeviationPct"]')).toHaveValue("35");
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("custom-condition-dialog.png") });
  await closeStrategyDialog(page);
  const submitted = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/api/v1/runs"));
  const completed = page.waitForResponse(response => response.ok() && response.request().method() === "GET" && /\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url()));
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await page.locator(".run-submit-button").click();
  const payload = (await submitted).postDataJSON();
  const tree = payload.draft.strategies.find(strategy => strategy.presetId === "composite_dca").rules.buy;
  expect(tree.operator).toBe("OR");
  expect(tree.children[0].params["vix.buyThreshold"]).toBe(25);
  expect(tree.children[2].operator).toBe("AND");
  expect(tree.children[2].children[0].params["ma.buyDeviationPct"]).toBe(35);
  const saved = await (await completed).json();
  const snapshotTree = saved.snapshot.config.strategies.find(strategy => strategy.presetId === "composite_dca").rules.buy;
  expect(snapshotTree.children[2].operator).toBe("AND");
  expect(Number(snapshotTree.children[2].children[0].params["ma.buyDeviationPct"])).toBe(35);
  const comparisonBefore = await page.locator(".comparison-table").innerHTML();
  await trigger.click();
  await group.locator('[data-condition-kind="ma_deviation"] input[id$="-ma-buyDeviationPct"]').fill("45");
  await expect(page.locator(".comparison-table")).toHaveJSProperty("innerHTML", comparisonBefore);
  await closeStrategyDialog(page);
});

test("strategy AND OR segments and buy sell switches remain independent and keyboard accessible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await addStrategy(page, "composite_dca");
  await page.locator(".strategy-card-open").last().click();
  const dialog = page.locator(".strategy-dialog");
  await dialog.locator('[data-rule-side="buy"] .condition-add-select').first().selectOption("rsi");
  await expect(dialog.locator('[data-rule-side="buy"] .field-segment:has(input[value="AND"])')).toHaveAttribute("title", "有効な条件すべて");
  await expect(dialog.locator('[data-rule-side="buy"] .field-segment:has(input[value="OR"])')).toHaveAttribute("title", "有効な条件のいずれか");
  const rsiSwitch = dialog.locator('[data-condition-kind="rsi"] .condition-card-heading').getByRole("switch");
  await rsiSwitch.click();
  await expect(rsiSwitch).toHaveAttribute("aria-checked", "false");
  await expect(dialog.getByRole("radio", { name: "AND", exact: true })).toBeEnabled();
  await dialog.getByRole("radio", { name: "AND", exact: true }).check();
  await expect(dialog.getByRole("radio", { name: "AND", exact: true })).toBeChecked();
  await dialog.getByRole("radio", { name: "AND", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("radio", { name: "OR", exact: true })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "OR", exact: true })).toBeChecked();
  const buy = dialog.locator('[data-rule-side="buy"] > .condition-heading').getByRole("switch");
  const sell = dialog.locator('[data-rule-side="sell"] > .condition-heading').getByRole("switch");
  const sellBefore = await sell.getAttribute("aria-checked");
  await buy.click();
  await expect(buy).toHaveAttribute("aria-checked", "false");
  await expect(dialog.locator("#field-strategy-composite_dca-2-vix-buyThreshold")).toBeDisabled();
  await expect(sell).toHaveAttribute("aria-checked", sellBefore);
  await sell.click();
  await expect(sell).toHaveAttribute("aria-checked", sellBefore === "true" ? "false" : "true");
  await expect(buy).toHaveAttribute("aria-checked", "false");
  const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(report.violations).toEqual([]);
  await closeStrategyDialog(page);
  await page.locator(".strategy-card-open").last().click();
  await expect(dialog.locator('[data-rule-side="buy"] .strategy-rule-content')).toBeHidden();
  await expect(dialog.getByRole("radio", { name: "OR", exact: true, includeHidden: true })).toBeChecked();
  await expect(buy).toHaveAttribute("aria-checked", "false");
  await closeStrategyDialog(page);
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await page.locator(".strategy-card-open").last().click();
  await expect(dialog.locator('[data-rule-side="buy"] .field-segment:has(input[value="AND"])')).toHaveAttribute("title", "满足本组所有启用条件");
  await expect(dialog.locator('[data-rule-side="buy"] .field-segment:has(input[value="OR"])')).toHaveAttribute("title", "满足本组任一启用条件");
  const cashLimit = dialog.locator('input[id$="-accumulation-cashSafetyLimit"]');
  await cashLimit.fill("1250");
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(dialog).toBeVisible();
  await expect(cashLimit).toHaveValue("1250");
  await expect(buy).toHaveAttribute("aria-checked", "false");
  await expect(dialog.locator(".dialog-done")).toBeInViewport();
  await expect(dialog.locator(".strategy-dialog-heading")).toBeInViewport();
  const phone = await dialog.evaluate(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, width: innerWidth }));
  expect(phone.left).toBeGreaterThanOrEqual(0);
  expect(phone.right).toBeLessThanOrEqual(phone.width);
  await page.screenshot({ path: test.info().outputPath("signal-controls-320.png") });
});


test("pointer dialog close releases card actions while keyboard return retains access", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const card = page.locator(".strategy-nav-card").first();
  const open = card.locator(".strategy-card-open");
  const actions = card.locator(".strategy-card-actions");
  await card.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await open.click();
  await page.locator(".strategy-dialog .dialog-done").click();
  await expect(open).toBeFocused();
  await expect(actions).toHaveCSS("opacity", "0");
  await card.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await open.click();
  await page.locator(".strategy-dialog-close").click();
  await expect(actions).toHaveCSS("opacity", "0");
  await page.mouse.move(0, 0);
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".strategy-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  await expect(actions).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(card.locator(".strategy-remove")).toBeFocused();
});


test("common settings summary separates ticker, dates and funding into readable lines", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openSharedSettings(page);
  await page.locator("#field-run-startDate").fill("2024-01-31");
  await page.locator("#field-run-endDate").fill("2024-03-01");
  await closeSharedSettings(page);
  await page.locator(".run-submit-button").click();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  const symbol = page.locator(".shared-settings-summary-symbol");
  const dates = page.locator(".shared-settings-summary-period");
  const funding = page.locator(".shared-settings-summary-funding");
  await expect(symbol).toHaveText("📈 QQQ");
  await expect(dates).toHaveText("🗓️ 2024-01-31 → 2024-03-01");
  await expect(funding).toContainText("USD");
  const emojis = page.locator(".shared-settings-summary-text .summary-emoji");
  await expect(emojis).toHaveCount(3);
  await expect(emojis).toHaveText(["📈", "🗓️", "💰"]);
  for (const emoji of await emojis.all()) await expect(emoji).toHaveAttribute("aria-hidden", "true");
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 320) await page.locator(".workbench-mobile-view").first().click();
    const a = await symbol.boundingBox(), b = await dates.boundingBox(), c = await funding.boundingBox();
    expect(a.y + a.height).toBeLessThanOrEqual(b.y);
    expect(b.y + b.height).toBeLessThanOrEqual(c.y);
    expect(c.x + c.width).toBeLessThanOrEqual(width);
    await dates.click();
    await expect(page.locator(".shared-settings-dialog")).toBeVisible();
    await closeSharedSettings(page);
  }
});

test("hiding price preserves the principal return chart and legacy snapshots keep a usable core", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openSharedSettings(page);
  await page.locator("#field-run-startDate").fill("2024-01-31");

  await page.locator("#field-run-endDate").fill("2024-02-02");
  await closeSharedSettings(page);
  const response = page.waitForResponse((r) => r.ok() && r.request().method() === "GET" && /\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(r.url()));
  await page.locator(".run-submit-button").click();
  const saved = await (await response).json();
  const price = page.locator('.legend-toggle[data-series="price"]');
  const asset = page.locator('.chart-legend button[data-series="totalAsset"]');
  await page.locator(".comparison-table").getByRole("button", { name: "ボラティリティ積立", exact: true }).click();
  await expect(page.locator(".chart-overlay .overlay-series-line")).toHaveCount(2);
  await price.click();
  await expect(page.locator(".chart-overlay .overlay-price")).toHaveCount(0);
  await expect(page.locator(".chart-overlay svg.result-chart")).toBeVisible();
  await expect(page.locator(".chart-overlay polyline.overlay-totalAsset")).toHaveCount(1);
  await expect(page.locator(".chart-overlay .chart-trade-marker")).toHaveCount(0);
  await page.locator('.overlay-legend-item[data-series="totalAsset"]').hover();
  await expect(page.locator(".chart-overlay .chart-trade-marker").first()).toHaveAttribute("data-anchor-series", "totalAsset");
  await expect(asset).toBeEnabled();
  await asset.click();
  await expect(price).toHaveAttribute("aria-pressed", "true");
  await expect(asset).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".chart-overlay polyline.overlay-price")).toHaveCount(1);
  await asset.click();
  await price.click();
  await expect(page.locator(".chart-overlay polyline.overlay-totalAsset")).toHaveCount(1);
  await expect(page.locator(".chart-range-controls")).toBeVisible();
  await page.getByRole("button", { name: "期間を拡大", exact: true }).click();
  await expect(page.locator(".chart-overlay")).not.toHaveAttribute("data-window-start", "0");
  await price.click();
  await expect(page.locator(".chart-overlay .overlay-series-line")).toHaveCount(2);
  const legacy = structuredClone(saved);
  for (const result of legacy.result.strategyRuns) {
    for (const point of result.dailyAssets) delete point.totalContributed;
  }
  await page.route("**/api/v1/runs/latest", (route) => route.fulfill({ json: legacy }));
  await page.reload();
  await expect(page.locator(".chart-overlay svg.result-chart")).toBeVisible();
  await expect(page.locator(".chart-overlay polyline.overlay-price")).toHaveCount(1);
  await expect(price).toBeDisabled();
  await expect(asset).toBeDisabled();
  await expect(page.locator(".chart-data-note")).toBeVisible();
  await expect(page.locator(".chart-overlay .overlay-totalAsset")).toHaveCount(0);
});

test("crosshair links saved dates, shows exact readings and follows compact geometry and keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await openSharedSettings(page);
  await page.locator("#field-run-startDate").fill("2024-01-31");

  await page.locator("#field-run-endDate").fill("2024-02-02");
  await closeSharedSettings(page);
  const response = page.waitForResponse((r) => r.ok() && r.request().method() === "GET" && /\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(r.url()));
  await page.locator(".run-submit-button").click();
  const saved = await (await response).json();
  const result = saved.result.strategyRuns.find((r) => r.presetId === "vix_dca");
  await page.locator(".comparison-table").getByRole("button", { name: "ボラティリティ積立", exact: true }).click();
  const stack = page.locator(".chart-linked-stack");
  const core = stack.locator(".chart-overlay");
  const vix = stack.locator(".chart-vix");
  const coreSvg = core.locator("svg.result-chart");
  const vixSvg = vix.locator("svg.result-chart");
  for (const figure of await stack.locator(".is-compact").all()) {
    await expect(figure).toHaveCSS("border-top-width", "0px");
    await expect(figure).toHaveCSS("padding-top", "0px");
  }
  async function hoverPlot(svg, yRatio = 0.5) {
    await svg.scrollIntoViewIfNeeded();
    const geometry = await svg.evaluate((el) => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, viewHeight: el.viewBox.baseVal.height, top: Number(el.dataset.plotTop), bottom: Number(el.dataset.plotBottom) }));
    await svg.hover({ position: {
      x: geometry.width * 433 / 800,
      y: geometry.height * (geometry.top + (geometry.bottom - geometry.top) * yRatio) / geometry.viewHeight,
    } });
  }
  await hoverPlot(coreSvg);
  const day = result.dailyAssets[1];
  await expect(stack.locator(".chart-crosshair")).toHaveCount(3);
  for (const crosshair of await stack.locator(".chart-crosshair").all()) {
    await expect(crosshair).toHaveAttribute("data-date", day.date);
    await expect(crosshair.locator(".chart-cursor-vertical")).toHaveAttribute("x1", "433");
  }
  await expect(core.locator(".chart-cursor-horizontal")).toHaveCount(1);
  await expect(vix.locator(".chart-cursor-horizontal")).toHaveCount(0);
  const readout = core.locator(".chart-crosshair-readout");
  for (const value of [day.simulationPrice, day.totalAsset, day.totalContributed]) {
    await expect(readout).toContainText(new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value)) + " USD");
  }
  await expect(readout).toContainText("相対指数");
  await expect(stack.locator(".chart-crosshair-readout")).toHaveCount(1);
  await expect(stack.locator(".is-compact .chart-crosshair-readout")).toHaveCount(0);
  const reservedReadout = await core.locator(".chart-crosshair-readout").boundingBox();
  expect(reservedReadout.y + reservedReadout.height, "shared readout stays above every curve plot").toBeLessThanOrEqual((await coreSvg.boundingBox()).y);
  const helpers = await stack.locator(".is-compact").evaluateAll((figures) => figures.map((figure) => {
    const svg = figure.querySelector("svg.result-chart");
    return { top: figure.getBoundingClientRect().top, bottom: figure.getBoundingClientRect().bottom, height: svg.getBoundingClientRect().height };
  }));
  expect(helpers[1].height).toBeCloseTo(helpers[0].height, 1);
  expect(helpers[1].top - helpers[0].bottom).toBeCloseTo(0, 1);
  await hoverPlot(vixSvg, 0.25);
  await expect(core.locator(".chart-cursor-horizontal")).toHaveCount(0);
  const horizontal = vix.locator(".chart-cursor-horizontal");
  expect(Number(await horizontal.getAttribute("y1"))).toBeCloseTo(26.5, 1);
  await expect(stack.locator(".chart-cursor-date")).toHaveCount(1);
  await expect(stack.locator(".chart-date-axis .chart-cursor-date")).toHaveCount(1);
  const vixValue = result.signals.find((signal) => signal.date === day.date && signal.signalId === "vix.buy").observedValue;
  await expect(readout).toContainText(String(Number(vixValue)));
  await expect(readout).toContainText("ドローダウン");
  await expect(vix.locator(".chart-cursor-point")).toHaveCount(1);
  const dateSpacing = await stack.locator(".chart-date-axis").evaluate((figure) => {
    const date = figure.querySelector(".chart-cursor-date").getBoundingClientRect();
    const title = figure.querySelector(".chart-x-axis-title").getBoundingClientRect();
    return title.top - date.bottom;
  });
  expect(dateSpacing, "compact cursor date must not overlap the axis title").toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: test.info().outputPath("linked-crosshair.png") });
  await page.mouse.move(0, 0);
  await expect(stack.locator(".chart-crosshair-readout")).toHaveCount(1);
  await expect(readout).toHaveAttribute("data-date", result.dailyAssets.at(-1).date);
  await expect(stack.locator(".chart-crosshair")).toHaveCount(0);
  await coreSvg.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(core.locator(".chart-crosshair")).toHaveAttribute("data-date", result.dailyAssets[0].date);
  const zeroPrincipal = core.locator(".chart-strategy-readout").filter({ hasText: "ボラティリティ積立" });
  await expect(zeroPrincipal).toContainText("0.00 USD");
  await expect(zeroPrincipal).toContainText("元本リターン指数 —");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(core.locator(".chart-crosshair")).toHaveAttribute("data-date", day.date);
  await page.keyboard.press("Escape");
  await expect(stack.locator(".chart-crosshair")).toHaveCount(0);
  await expect(readout).toHaveAttribute("data-date", result.dailyAssets.at(-1).date);
  await page.getByRole("button", { name: "期間を拡大", exact: true }).click();
  await hoverPlot(coreSvg);
  await expect(readout).toHaveAttribute("data-date", day.date);
  await page.mouse.down();
  await page.mouse.move((await coreSvg.boundingBox()).x + 500, (await coreSvg.boundingBox()).y + 100);
  await expect(stack.locator(".chart-crosshair")).toHaveCount(0);
  await page.mouse.up();
  await page.mouse.move(0, 0);
  const visibleEnd = Math.floor(Number(await core.getAttribute("data-window-end")) * (result.dailyAssets.length - 1));
  await expect(readout).toHaveAttribute("data-date", result.dailyAssets[visibleEnd].date);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(axe.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("result info is absent and trade context remains readable in a narrow touch viewport", async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await openSharedSettings(page);
  await page.locator("#field-run-startDate").fill("2024-01-31");
  await closeSharedSettings(page);
  const completed = page.waitForResponse(response => response.ok() && response.request().method() === "GET" && /\/api\/v1\/runs\/(?!latest$)[^/]+$/.test(response.url()));
  await page.locator(".run-submit-button").click();
  await completed;
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await page.locator(".workbench-mobile-view").last().click();
  await expect(page.locator(".result-snapshot-info, .result-snapshot-info-content")).toHaveCount(0);
  await page.getByRole("tab", { name: "取引明細", exact: true }).click();
  await expect(page.locator(".result-trades-context")).toHaveText("ボラティリティ積立");
  const bounds = await page.locator(".result-trades-context").boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  const touch = await context.browser().newContext({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true });
  try {
    const touchPage = await touch.newPage();
    await touchPage.goto(page.url());
    await expect(touchPage.locator(".comparison-table tbody tr")).toHaveCount(3);
    await touchPage.locator(".workbench-mobile-view").last().tap();
    await expect(touchPage.locator(".result-snapshot-info, .result-snapshot-info-content")).toHaveCount(0);
    const tab = touchPage.getByRole("tab", { name: "取引明細", exact: true });
    const size = await tab.boundingBox();
    expect(size.height).toBeGreaterThanOrEqual(44);
    await tab.tap();
    await expect(touchPage.locator(".result-trades-context")).toHaveText("ボラティリティ積立");
  } finally { await touch.close(); }
});
