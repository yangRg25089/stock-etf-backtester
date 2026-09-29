import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const VIEWPORTS = [320, 768, 1024];

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
  await expect(page.locator(".strategy-row")).toHaveCount(8);

  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("历史回测");
  await page.getByRole("button", { name: "日本語" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
});

test("default VIX can run to a focused saved result, display toggles, and matching CSV", async ({ page }) => {
  const pageErrors = [];
  const nonLocalRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const hostname = new URL(request.url()).hostname;
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      nonLocalRequests.push(request.url());
    }
  });

  await page.goto("/");
  await expect(page.locator(".strategy-editor-heading h3")).toHaveText("VIX シグナル積立");
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
  await chartToggle.click();
  await expect(chartToggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("svg[role=img]")).toHaveCount(0);
  await chartToggle.click();
  await expect(chartToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("svg[role=img]").first()).toBeVisible();
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

  await page.locator("#field-vix-buyThreshold").fill("28");
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
  expect(pageErrors).toEqual([]);
  expect(nonLocalRequests).toEqual([]);
});
