import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { restoreSavedRecord } from "./helpers/runtime.mjs";

const backend = path.resolve("../backend");
const fixture = JSON.parse(execFileSync(path.join(backend, ".venv/bin/python"), ["tests/e2e/export_file_fixture.py", "--walk-forward"], {
  cwd: backend, env: { ...process.env, PYTHONPATH: backend }, encoding: "utf8",
}));

test("rolling windows, continuous OOS chart, selected signal parameters and saved API exports", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let runRequests = 0;
  await page.route("**/api/v1/runs/**", route => {
    runRequests++; return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await restoreSavedRecord(page, { ...fixture.record, csv: fixture.csv });
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await page.locator(".comparison-table").getByRole("button", { name: "グリッド検索", exact: true }).click();
  await expect(page.locator(".comparison-period").filter({ hasText: "ローリング検証" })).toBeVisible();
  await page.locator("#result-tab-search").click();
  await expect(page.locator(".search-window-select option")).toHaveCount(2);
  await expect(page.locator(".search-table tbody tr")).toHaveCount(2);
  await expect(page.locator(".search-periods")).toContainText("2015-01-01 → 2019-12-31");
  await page.locator(".search-table .result-select").first().click();
  await expect(page.locator(".search-oos-select")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#result-tab-trades").click();
  await expect(page.locator(".result-detail-name")).toContainText("学習");
  await page.locator("#result-tab-search").click();
  await page.locator(".search-window-select").selectOption("1");
  await expect(page.locator(".search-periods")).toContainText("2016-01-01 → 2020-12-31");
  await page.locator(".search-table .result-select").first().click();
  await page.locator(".search-oos-select").click();
  await expect(page.locator(".search-oos-select")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".chart-overlay [data-result-id]").first()).toBeVisible();
  await page.locator("#result-tab-trades").click();
  await expect(page.locator(".result-detail-name")).toContainText("ローリング検証");
  await expect(page.locator(".result-detail-name")).toContainText("2020-01-01 → 2021-02-05");
  for (const kind of ["summary", "daily-assets", "trades", "search-results"]) {
    const waiting = page.waitForEvent("download");
    await page.locator(`[data-export-kind='${kind}']`).click();
    const content = await readFile(await (await waiting).path(), "utf8");
    const id = kind === "search-results" ? "walk" : "walk:out-of-sample";
    expect(content).toBe(fixture.csv[`${id}/${kind}`]);
  }
  const report = page.waitForEvent("download");
  await page.locator("[data-report-kind=png]").click();
  expect((await report).suggestedFilename()).toMatch(/\.png$/);
  await page.locator("#result-tab-search").click();
  for (const language of ["日本語", "中文"]) {
    await page.locator(".locale-select").selectOption(language === "日本語" ? "ja" : language === "中文" ? "zh" : "en");
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 850 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".search-results").screenshot({ path: test.info().outputPath("walk-forward.png") });
  expect(errors).toEqual([]);
  expect(runRequests).toBe(0);
});
