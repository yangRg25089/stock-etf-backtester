import { expect, test } from "@playwright/test";
import { savedRun } from "./helpers/reports.mjs";
import { installRunFixture } from "./helpers/runtime.mjs";

test("language follows browser preferences on first visit and the chosen language survives reload", async ({ browser }) => {
  const englishContext = await browser.newContext({ locale: "en-GB" });
  const english = await englishContext.newPage();
  await english.goto("/");
  await expect(english.locator("html")).toHaveAttribute("lang", "en");
  await expect(english.locator(".app-frame")).toHaveAttribute("lang", "en");
  await expect(english.locator(".locale-select")).toHaveValue("en");
  await expect(english.getByText("Shared settings", { exact: true })).toBeVisible();
  await expect(english.locator(".locale-select option")).toHaveText(["Japanese", "Chinese", "English"]);

  await english.locator(".locale-select").selectOption("ja");
  await expect(english.locator("html")).toHaveAttribute("lang", "ja");
  expect(await english.evaluate(() => localStorage.getItem("stock-etf-backtester.locale.v1"))).toBe("ja");
  await english.reload();
  await expect(english.locator("html")).toHaveAttribute("lang", "ja");
  await expect(english.locator(".locale-select")).toHaveValue("ja");
  await englishContext.close();

  const chineseContext = await browser.newContext({ locale: "zh-TW" });
  const chinese = await chineseContext.newPage();
  await chinese.goto("/");
  await expect(chinese.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(chinese.locator(".locale-select")).toHaveValue("zh");
  await chineseContext.close();

  const fallbackContext = await browser.newContext({ locale: "fr-FR" });
  const fallback = await fallbackContext.newPage();
  await fallback.goto("/");
  await expect(fallback.locator("html")).toHaveAttribute("lang", "en");
  await expect(fallback.getByText("Shared settings", { exact: true })).toBeVisible();
  await fallbackContext.close();
});

test("monthly return colors follow locale defaults, keep manual choices, and explain performance metrics", async ({ page }) => {
  await page.addInitScript(() => {
    const cleared = "stock-etf-backtester.phase54-palette-cleared";
    if (!sessionStorage.getItem(cleared)) {
      localStorage.removeItem("stock-etf-backtester.heatmap-palette.v1");
      sessionStorage.setItem(cleared, "true");
    }
  });
  const saved = await savedRun(page);
  for (const row of saved.result.strategyRuns) {
    if (!row.metrics?.analysis) continue;
    row.metrics.analysis.monthlyReturns = [
      { year: 2024, month: 1, startDate: "2024-01-31", endDate: "2024-01-31", navReturn: "0.05", priceReturn: "0.08" },
      { year: 2024, month: 2, startDate: "2024-02-01", endDate: "2024-02-29", navReturn: "-0.04", priceReturn: "-0.06" },
    ];
  }
  await installRunFixture(page, saved);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.locator(".comparison-table .result-select").first().click();
  await page.locator("#result-tab-details").click();
  await page.locator(".locale-select").selectOption("ja");

  const panel = page.locator("#result-panel-performance");
  const monthly = panel.locator(".monthly-performance");
  const positive = panel.locator(".heatmap-cell.is-positive").first();
  const negative = panel.locator(".heatmap-cell.is-negative").first();
  await expect(positive).toBeVisible();
  await expect(negative).toBeVisible();
  await expect(page.locator(".app-frame")).toHaveAttribute("data-return-palette", "green-up");
  await expect(positive).toHaveCSS("background-color", "rgb(8, 116, 67)");
  await expect(positive).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(negative).toHaveCSS("background-color", "rgb(183, 28, 28)");
  await expect(negative).toHaveCSS("color", "rgb(255, 255, 255)");

  await page.locator(".return-color-control").getByRole("button", { name: "上昇は赤、下落は緑" }).click();
  await expect(page.locator(".app-frame")).toHaveAttribute("data-return-palette", "red-up");
  await page.locator(".locale-select").selectOption("en");
  await expect(page.locator(".app-frame")).toHaveAttribute("data-return-palette", "red-up");
  expect(await page.evaluate(() => localStorage.getItem("stock-etf-backtester.heatmap-palette.v1"))).toBe("red-up");
  await installRunFixture(page, saved);
  await page.reload();
  await page.locator("#result-tab-details").click();
  await expect(page.locator(".app-frame")).toHaveAttribute("data-return-palette", "red-up");

  const firstCard = panel.locator(".performance-stat").first();
  const tooltip = firstCard.locator(".performance-help-tooltip");
  await firstCard.hover();
  await expect(tooltip).toHaveCSS("visibility", "visible");
  await expect(tooltip).not.toBeEmpty();
  const cardBox = await firstCard.boundingBox();
  const tipBox = await tooltip.boundingBox();
  expect(tipBox.y).toBeGreaterThan(cardBox.y + cardBox.height);
  await firstCard.focus();
  await expect(tooltip).toHaveCSS("opacity", "1");
  const descriptionId = await firstCard.getAttribute("aria-describedby");
  expect(await page.locator(`[id="${descriptionId}"]`).innerText()).toBe(await tooltip.innerText());
  await panel.screenshot({ path: test.info().outputPath("performance-explanation-hover.png") });
});

test("trade and annual performance tables sort by their displayed columns", async ({ page }) => {
  const saved = await savedRun(page);
  const strategy = saved.result.strategyRuns.find(row => row.id === "report-strategy");
  strategy.trades = [
    { date: "2024-02-03", side: "sell", reason: "signal_sell", quantity: "1", price: "12", cashAmount: "12", currency: "USD" },
    { date: "2024-02-01", side: "buy", reason: "signal_buy", quantity: "1", price: "10", cashAmount: "10", currency: "USD" },
  ];
  strategy.metrics.analysis.annualReturns = [
    { year: 2023, startDate: "2023-01-01", endDate: "2023-12-31", navReturn: "0.01", priceReturn: "0.02" },
    { year: 2024, startDate: "2024-01-01", endDate: "2024-12-31", navReturn: "0.20", priceReturn: "0.04" },
  ];
  await installRunFixture(page, saved);
  await page.goto("/");
  await page.locator(".comparison-table tbody tr").filter({ hasText: "ボラティリティ積立" }).locator(".result-select").click();

  await page.locator("#result-tab-details").click();
  const tradeTable = page.locator(".trade-table");
  const dateHeader = tradeTable.locator("thead th").nth(0);
  await dateHeader.locator("button").click();
  await expect(dateHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(tradeTable.locator("tbody tr").first().locator("td").first()).toContainText("2024-02-01");
  await tradeTable.locator("tbody tr").first().locator("td").first().getByRole("button").click();
  await expect(page.getByRole("dialog").locator(".explanation-summary time")).toHaveText("2024-02-01");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await dateHeader.locator("button").click();
  await expect(dateHeader).toHaveAttribute("aria-sort", "descending");
  await expect(tradeTable.locator("tbody tr").first().locator("td").first()).toContainText("2024-02-03");

  await page.locator("#result-tab-details").click();
  const annual = page.locator(".heatmap-table");
  const navHeader = annual.locator("thead th").last();
  await navHeader.locator("button").click();
  await expect(navHeader).toHaveAttribute("aria-sort", "descending");
  await expect(annual.locator("tbody tr").first().locator("th").first()).toHaveText("2024");
});

test("expanded table headings stick to the results viewport and release after that table passes", async ({ page }) => {
  const saved = await savedRun(page);
  const strategy = saved.result.strategyRuns.find(row => row.id === "report-strategy");
  strategy.metrics.analysis.annualReturns = Array.from({ length: 48 }, (_, index) => ({
    year: 1978 + index, startDate: `${1978 + index}-01-01`, endDate: `${1978 + index}-12-31`,
    navReturn: "0.03", priceReturn: "0.04",
  }));
  strategy.metrics.analysis.monthlyReturns = Array.from({ length: 48 * 12 }, (_, index) => {
    const year = 1978 + Math.floor(index / 12), month = index % 12 + 1;
    const end = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthKey = String(month).padStart(2, "0");
    return { year, month, startDate: `${year}-${monthKey}-01`, endDate: `${year}-${monthKey}-${String(end).padStart(2, "0")}`,
      navReturn: "0.01", priceReturn: "0.02" };
  });
  strategy.metrics.analysis.drawdownEpisodes = Array.from({ length: 48 }, (_, index) => {
    const year = 1978 + index;
    const elapsed = (start, end) => (Date.parse(end) - Date.parse(start)) / 86_400_000;
    return { peakDate: `${year}-02-01`, bottomDate: `${year}-02-02`, endDate: `${year}-03-01`,
      drawdown: "-0.1", durationDays: elapsed(`${year}-02-01`, `${year}-03-01`),
      recoveryDays: elapsed(`${year}-02-02`, `${year}-03-01`), recoveredDate: `${year}-03-01`, state: "recovered" };
  });
  strategy.trades = Array.from({ length: 48 }, () => ({ date: "2024-02-02",
    side: "buy", reason: "fixed_dca", quantity: "1", price: "1", cashAmount: "1", currency: "USD" }));
  await installRunFixture(page, saved);
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.goto("/");
  const results = page.locator(".workbench-results");

  const comparison = page.locator(".comparison-table-region");
  const comparisonButton = page.locator(".comparison-table-region .table-expand-button");
  await comparisonButton.click();
  await expect(comparison).toHaveClass(/is-height-expanded/);
  await expect(comparison.locator(".table-height-controls")).toHaveCSS("position", "sticky");
  await comparisonButton.click();

  await page.locator("#result-tab-details").click();
  const tradeRegion = page.locator(".trade-table-region");
  const tradeButton = tradeRegion.locator(".table-expand-button");
  await tradeButton.click();
  await expect(tradeRegion).toHaveClass(/is-height-expanded/);
  await expect(tradeRegion.locator(".table-height-controls")).toHaveCSS("position", "sticky");
  await tradeButton.click();

  await page.locator("#result-tab-details").click();
  await results.evaluate(node => { node.scrollTop = 0; });
  const groups = page.locator("#result-panel-performance .performance-group:has(.table-expand-button)");
  await expect(groups).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    const group = groups.nth(index);
    const button = group.locator(".table-expand-button");
    await expect(button).toBeVisible();
    await button.click();
    await expect(group).toHaveClass(/is-height-expanded/);
    await expect(group.locator(".performance-group-heading")).toHaveCSS("position", "sticky");
    await expect(group.locator(".performance-group-heading")).toHaveCSS("top", "0px");
    await button.click();
  }

  await groups.nth(1).locator(".table-expand-button").click();
  const monthYear = groups.nth(0);
  const monthYearButton = monthYear.locator(".table-expand-button");
  await monthYearButton.click();
  const heading = monthYear.locator(".performance-group-heading");
  const tableRegion = monthYear.locator(".performance-table-scroll");
  const rootTop = (await results.boundingBox()).y;
  const scrollToward = async predicate => {
    for (let step = 0; step < 80; step += 1) {
      const geometry = await monthYear.evaluate(node => ({
        headingTop: node.querySelector(".performance-group-heading").getBoundingClientRect().top,
        groupBottom: node.getBoundingClientRect().bottom,
      }));
      if (predicate(geometry)) return geometry;
      await results.evaluate(node => { node.scrollTop += 80; });
      await page.waitForTimeout(16);
    }
    const final = await monthYear.evaluate(node => ({
      headingTop: node.querySelector(".performance-group-heading").getBoundingClientRect().top,
      groupBottom: node.getBoundingClientRect().bottom,
    }));
    const scroll = await results.evaluate(node => ({ top: node.scrollTop, client: node.clientHeight, height: node.scrollHeight }));
    throw new Error(`Expanded table heading did not reach the expected sticky boundary: ${JSON.stringify({ final, scroll, rootTop })}`);
  };
  const pinned = await scrollToward(geometry => geometry.headingTop <= rootTop + 1 && geometry.groupBottom > rootTop + 1);
  expect(Math.abs(pinned.headingTop - rootTop)).toBeLessThanOrEqual(1);
  expect((await tableRegion.boundingBox()).height).toBeGreaterThan(720);
  const released = await scrollToward(geometry => geometry.groupBottom <= rootTop + 1);
  expect(released.headingTop).toBeLessThan(rootTop);
});

test("workbench boundary remains on a single centered vertical axis across viewport changes", async ({ page }) => {
  await page.goto("/");
  const divider = page.locator(".workbench-divider");
  const toggle = divider.locator(".workbench-config-toggle");
  for (const width of [768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 950 });
    await expect(divider).toBeVisible();
    // Await the breakpoint event before a manual click can race its visibility update.
    await expect(toggle).toHaveAttribute("aria-expanded", width <= 1279 ? "false" : "true");
    const measure = async () => divider.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const rule = getComputedStyle(node, "::before");
      return {
        trackLeft: rect.left,
        trackWidth: rect.width,
        lineWidth: rule.width,
        lineLeft: rule.left,
        transform: rule.transform,
        top: rule.top,
        bottom: rule.bottom,
      };
    });
    for (let collapsed = 0; collapsed < 2; collapsed += 1) {
      const { trackLeft, trackWidth, lineWidth, lineLeft, transform, top, bottom } = await measure();
      expect(lineWidth).toBe("1px");
      expect(Number.parseFloat(lineLeft)).toBeCloseTo(trackWidth / 2, 3);
      expect(transform).toBe("matrix(1, 0, 0, 1, -0.5, 0)");
      expect(Number.parseFloat(top)).toBe(0);
      expect(Number.parseFloat(bottom)).toBe(0);
      const centerline = trackLeft + trackWidth / 2;
      expect(centerline).toBeGreaterThan(trackLeft);
      expect(centerline).toBeLessThan(trackLeft + trackWidth);
      const wasExpanded = await toggle.getAttribute("aria-expanded");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", wasExpanded === "true" ? "false" : "true");
    }
  }
});
