import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("production backend: default Yahoo QQQ/VIX, refresh, rerun and frozen exports", async ({ page }) => {
  const errors = [];
  let lastRunId;
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await page.reload();
    const validating = page.waitForResponse(response => response.url().endsWith("/api/v1/config/validate"));
    const accepted = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/v1/runs"));
    await page.locator(".run-submit-button").click();
    const validation = await (await validating).json();
    expect([...validation.diagnostics, ...validation.strategies.flatMap(item => item.diagnostics)]).toEqual([]);
    const response = await accepted;
    expect(response.status()).toBe(202);
    const { runId } = await response.json();
    lastRunId = runId;
    let saved;
    await expect.poll(async () => {
      saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
      return saved.status;
    }, { timeout: 90_000 }).toBe("completed");
    expect(saved.result.strategyRuns).toHaveLength(3);
    for (const row of saved.result.strategyRuns) {
      expect(row.status).toBe("completed");
      expect(row.dailyAssets.length).toBeGreaterThan(1_000);
      expect(Number(row.metrics.endingEquity)).toBeGreaterThan(0);
    }
    await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
    await expect(page.locator("#result-details .diagnostic-list")).toHaveCount(0);
  }
  const waiting = page.waitForEvent("download");
  await page.locator("[data-export-kind=summary]").click();
  const csv = await readFile(await (await waiting).path(), "utf8");
  expect(csv).toContain("strategy-vix_dca-1");
  const frozen = await page.request.get(`/api/v1/runs/${lastRunId}/export/summary`, { params: { focusedResultId: "strategy-vix_dca-1" } });
  expect(csv).toBe(await frozen.text());
  expect(errors).toEqual([]);
});
