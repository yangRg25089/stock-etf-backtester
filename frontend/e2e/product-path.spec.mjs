import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const VIEWPORTS = [320, 768, 1024, 1440];

test.describe("responsive product shell", () => {
  for (const width of VIEWPORTS) {
    for (const locale of ["ja", "zh"]) {
      test(`${width}px ${locale} has no page overflow or clipped run controls`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await page.getByRole("button", { name: locale === "ja" ? "中文" : "中文" }).click();
        if (locale === "ja") {
          await page.getByRole("button", { name: "日本語" }).click();
        }

        const layout = await page.evaluate(() => {
          const controls = [
            document.querySelector(".run-controls .button-primary"),
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

test("catalog lists all presets, enabled state toggles, and locale changes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#preset-to-add option")).toHaveCount(8);
  await expect(page.locator("#preset-to-add")).toHaveValue("");
  await expect(page.locator(".strategy-parameter-group h4").filter({ hasText: "VIX シグナル" })).toBeVisible();
  await expect(page.locator("#field-strategy-vix_dca-1-vix-symbol-hint")).toContainText("買付・売却シグナル");
  await expect(page.locator(".run-scope-option .field-hint")).toBeVisible();
  for (const presetId of [
    "vix_dca",
    "composite_dca",
    "ma_trend",
    "ma_buy_only",
    "monthly_dca",
    "lump_sum",
    "grid_search",
  ]) {
    await expect(page.locator(`#preset-to-add option[value="${presetId}"]`)).toHaveCount(1);
  }

  const enabled = page.locator(".strategy-enabled-control input").first();
  await expect(enabled).toBeChecked();
  await enabled.uncheck();
  await expect(enabled).not.toBeChecked();
  await enabled.check();
  await expect(enabled).toBeChecked();

  for (const presetId of [
    "vix_dca",
    "composite_dca",
    "ma_trend",
    "ma_buy_only",
    "monthly_dca",
    "lump_sum",
    "grid_search",
  ]) {
    await page.locator("#preset-to-add").selectOption(presetId);
    await page.locator(".add-strategy-button").click();
  }
  await expect(page.locator(".strategy-card")).toHaveCount(8);

  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("历史回测");
  await expect(page.locator(".strategy-parameter-group h4").filter({ hasText: "VIX 信号" }).first()).toBeVisible();
  await page.getByRole("button", { name: "日本語" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
});

test("default VIX can run to a focused saved result, display toggles, and matching CSV", async ({ page }) => {
  const pageErrors = [];
  const nonLocalRequests = [];
  const runStatusRequests = [];
  const runEventRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
      /\/api\/v1\/runs\/[^/]+$/.test(request.url())
    ) {
      runStatusRequests.push(request.url());
    }
  });

  await page.goto("/");
  await expect(page.locator(".strategy-card-name").first()).toHaveText("VIX シグナル積立");
  await page.getByLabel("開始日").fill("2024-01-31");
  await page.getByRole("checkbox", { name: "最新の完了日まで" }).uncheck();
  await page.locator("#field-run-endDate").fill("2024-02-02");

  const completedResponse = page.waitForResponse(async (response) => {
    if (response.request().method() !== "GET" || !/\/api\/v1\/runs\/[^/]+$/.test(response.url())) {
      return false;
    }
    if (!response.ok()) return false;
    return ["completed", "completed_with_warning", "unavailable", "failed"]
      .includes((await response.json()).status);
  });
  const runButton = page.getByRole("button", { name: "バックテストを実行" });
  await expect(runButton).toBeEnabled();
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
  await expect(page.locator(".page-heading [role=status]")).toContainText("完了");
  await expect(page.locator(".snapshot-warning")).toHaveCount(0);

  const benchmarkButton = page.locator("button.result-select").filter({ hasText: "benchmark:monthly-dca" });
  await benchmarkButton.click();
  await expect(benchmarkButton).toHaveAttribute("aria-pressed", "true");

  const chartToggle = page.getByRole("button", { name: "資産チャートを表示" });
  await expect(chartToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("svg[role=img]").first()).toBeVisible();
  const coreChart = page.locator(".chart-panel.chart-overlay").first();
  await expect(coreChart.locator(".overlay-series-line.overlay-price")).toBeVisible();
  await expect(coreChart.locator(".overlay-series-line.overlay-totalAsset")).toBeVisible();
  await expect(coreChart.locator(".overlay-series-line")).toHaveCount(2);
  await expect(coreChart.locator(".chart-baseline-line")).toHaveAttribute("data-baseline", "100");
  await expect(coreChart.locator(".overlay-legend")).toContainText("QQQ · 価格 (USD)");
  await expect(coreChart.locator(".overlay-legend")).toContainText("総資産 (USD)");
  expect(await coreChart.locator(".chart-gridline").count()).toBeGreaterThan(7);
  await expect(coreChart.locator(".candlestick")).toHaveCount(0);
  await chartToggle.click();
  await expect(chartToggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("svg[role=img]")).toHaveCount(0);
  await chartToggle.click();
  await expect(chartToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("svg[role=img]").first()).toBeVisible();
  const strategyButton = page.locator("button.result-select").filter({ hasText: "strategy-vix_dca-1" });
  await strategyButton.click();
  await expect(page.locator(".chart-panel.chart-vix")).toContainText("25");
  await expect(page.locator(".chart-panel.chart-vix .chart-threshold-line")).toHaveCount(1);
  const readChartWindows = () => page.locator(".chart-panel").evaluateAll((panels) =>
    panels.map((panel) => ({
      start: panel.getAttribute("data-window-start"),
      end: panel.getAttribute("data-window-end"),
      ticks: [...panel.querySelectorAll(".chart-x-tick")].map((tick) => tick.textContent),
    })),
  );
  const expectSynchronizedWindows = async () => {
    const windows = await readChartWindows();
    expect(windows).toHaveLength(3);
    expect(new Set(windows.map(({ start, end }) => `${start}:${end}`)).size).toBe(1);
    expect(new Set(windows.map(({ ticks }) => ticks.join("|"))).size).toBe(1);
    return windows[0];
  };
  const expectBaselineInsidePlot = async () => {
    const baselineY = await page.locator(".chart-panel.chart-overlay .chart-baseline-line").getAttribute("y1");
    expect(Number(baselineY)).toBeGreaterThanOrEqual(20);
    expect(Number(baselineY)).toBeLessThanOrEqual(266);
  };
  for (const chartSelector of ["chart-overlay", "chart-drawdown", "chart-vix"]) {
    const resetRangeButton = page.getByRole("button", { name: "全期間に戻す" });
    if (await resetRangeButton.isEnabled()) await resetRangeButton.click();
    const chart = page.locator(`.chart-panel.${chartSelector} .result-chart`);
    await chart.hover();
    await expect(chart).toHaveCSS("touch-action", "none");
    const pageViewportBeforeWheel = await page.evaluate(() => ({
      scrollY: window.scrollY,
      scale: window.visualViewport?.scale,
    }));
    await page.mouse.wheel(0, -160);
    await expect.poll(async () => page.locator(`.chart-panel.${chartSelector}`).getAttribute("data-window-start")).not.toBe("0");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(pageViewportBeforeWheel.scrollY);
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(pageViewportBeforeWheel.scale);
    const zoomedWindow = await expectSynchronizedWindows();
    await expectBaselineInsidePlot();

    const bounds = await chart.boundingBox();
    expect(bounds).toBeTruthy();
    const pointerX = bounds.x + bounds.width / 2;
    const pointerY = bounds.y + bounds.height / 2;
    await page.mouse.move(pointerX, pointerY);
    await page.mouse.down();
    await page.mouse.move(pointerX + 45, pointerY, { steps: 4 });
    await page.mouse.up();
    const draggedWindow = await expectSynchronizedWindows();
    expect(draggedWindow.start).not.toBe(zoomedWindow.start);
    await expectBaselineInsidePlot();
  }
  const resetRangeButton = page.getByRole("button", { name: "全期間に戻す" });
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
  const overlayButton = page.getByRole("button", { name: "選択した指標も重ねる" });
  await overlayButton.click();
  await expect(page.locator(".chart-panel.chart-overlay .overlay-series-line")).toHaveCount(4);
  await expect(page.locator(".chart-panel.chart-overlay .chart-y-axis-title")).toContainText("100");
  await expect(page.locator(".chart-panel.chart-overlay")).toHaveAttribute("data-window-start", "0");
  await expect(page.locator(".chart-panel.chart-overlay")).toHaveAttribute("data-window-end", "1");
  await page.getByRole("button", { name: "価格・総資産を同じ図で比較" }).click();
  await expect(page.locator(".chart-panel.chart-overlay .overlay-series-line")).toHaveCount(2);
  const chartAccessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(chartAccessibility.violations, JSON.stringify(chartAccessibility.violations, null, 2)).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("financial-charts.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  const chartLayout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    corePanel: document.querySelector(".chart-panel.chart-overlay")?.getBoundingClientRect().width,
  }));
  expect(chartLayout.document, JSON.stringify(chartLayout)).toBeLessThanOrEqual(chartLayout.viewport);
  await benchmarkButton.click();
  const tradeToggle = page.getByRole("button", { name: "取引明細を表示" });
  await expect(tradeToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("table").last()).toBeVisible();
  await tradeToggle.click();
  await expect(tradeToggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("table")).toHaveCount(1);
  await tradeToggle.click();
  await expect(tradeToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("table").last()).toBeVisible();

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

  await page.locator("#field-strategy-vix_dca-1-vix-buyThreshold").fill("28");
  await expect(page.locator(".snapshot-warning")).toBeVisible();
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
  await expect(page.locator(".page-heading [role=status]")).toContainText("完了");
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
  await expect(page.locator(".page-heading [role=status]")).toContainText("完了");
  expect(pageErrors).toEqual([]);
  expect(nonLocalRequests).toEqual([]);
});

test("adding a strategy keeps the default run scope on every enabled strategy", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("開始日").fill("2024-01-31");
  await page.getByRole("checkbox", { name: "最新の完了日まで" }).uncheck();
  await page.locator("#field-run-endDate").fill("2024-02-02");

  await page.locator("#preset-to-add").selectOption("monthly_dca");
  await page.locator(".add-strategy-button").click();
  await expect(page.locator(".strategy-card")).toHaveCount(2);

  const runSubmission = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().endsWith("/api/v1/runs"),
  );
  await page.getByRole("button", { name: "バックテストを実行" }).click();
  const request = await runSubmission;
  const payload = request.postDataJSON();
  expect(payload.scope).toBe("all_enabled");
  expect(payload.draft.strategies.filter((strategy) => strategy.enabled).map((strategy) => strategy.id))
    .toEqual(["strategy-vix_dca-1", "strategy-monthly_dca-2"]);

  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(4);
  await expect(page.locator(".comparison-table")).toContainText("strategy-vix_dca-1");
  await expect(page.locator(".comparison-table")).toContainText("strategy-monthly_dca-2");
});
