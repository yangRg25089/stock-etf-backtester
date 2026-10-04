import { expect } from "@playwright/test";

/** A controlled unfinished job, followed by SSE completion and a full GET. */
export async function installRunFixture(page, saved) {
  const active = structuredClone(saved);
  active.status = "running";
  active.result.status = "running";
  const running = active.result.strategyRuns[0];
  running.status = "running";
  if (active.progress) Object.assign(active.progress, {
    completedStrategies: active.result.strategyRuns.length - 1,
    currentStrategyId: running.id,
  });
  await page.route("**/api/v1/runs/active", route => route.fulfill({ json: active }));
  await page.route(`**/api/v1/runs/${saved.runId}/events`, route => route.fulfill({ contentType: "text/event-stream", body:
    `event: terminal\ndata: ${JSON.stringify({ runId: saved.runId, status: saved.status, progress: saved.progress ?? null,
      strategyStatuses: Object.fromEntries(saved.result.strategyRuns.map(row => [row.id, row.status])) })}\n\n` }));
  await page.route(`**/api/v1/runs/${saved.runId}`, route => route.fulfill({ json: saved }));
}

export async function openSaved(page, saved) {
  await installRunFixture(page, saved);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(saved.result.strategyRuns.length);
}

export function backtestFile(saved, candidateDetails = {}) {
  return { format: "stock-etf-backtester", schemaVersion: 1, type: "backtest", exportedAt: new Date().toISOString(),
    engineVersion: saved.snapshot.engineVersion, catalogVersion: saved.snapshot.catalogVersion,
    config: saved.snapshot.config, result: saved, candidateDetails, dataProvenance: saved.snapshot.dataProvenance };
}

export async function importPackage(page, file, confirm = true) {
  await expect(page.locator(".package-menu summary")).toBeVisible();
  await page.locator(".file-import-input").setInputFiles({ name: `fixture.${file.type}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.locator(".package-preview")).toBeVisible();
  if (confirm) await page.locator(".package-preview .button-primary").click();
}
