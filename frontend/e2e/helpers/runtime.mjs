import { expect } from "@playwright/test";

export async function openTopbarMenu(page) {
  if ((page.viewportSize()?.width ?? 1440) >= 768) return false;
  const toggle = page.locator(".topbar-menu-toggle");
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-expanded") === "true") return false;
  await toggle.click();
  await expect(page.locator(".topbar-functions")).toBeVisible();
  return true;
}

export async function selectHeaderLocale(page, locale) {
  const opened = await openTopbarMenu(page);
  await page.locator(".locale-select").selectOption(locale);
  if (opened) await page.locator(".topbar-menu-toggle").click();
}

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
  const fixtureMarkerKey = "__e2e-initialized-run-id";
  if (page.url() !== "about:blank") {
    await page.evaluate(markerKey => sessionStorage.removeItem(markerKey), fixtureMarkerKey);
  }
  await page.addInitScript(({ key, markerKey, runId }) => {
    if (sessionStorage.getItem(markerKey) === runId) return;
    sessionStorage.setItem(key, runId);
    sessionStorage.setItem(markerKey, runId);
  }, {
    key: "stock-etf-backtester.active-run-id.v1",
    markerKey: fixtureMarkerKey,
    runId: saved.runId,
  });
  let runReads = 0;
  await page.route(`**/api/v1/runs/${saved.runId}`, route => route.fulfill({
    json: runReads++ % 2 === 0 ? active : saved,
  }));
  await page.route(`**/api/v1/runs/${saved.runId}/events`, route => route.fulfill({ contentType: "text/event-stream", body:
    `event: terminal\ndata: ${JSON.stringify({ runId: saved.runId, status: saved.status, progress: saved.progress ?? null,
      strategyStatuses: Object.fromEntries(saved.result.strategyRuns.map(row => [row.id, row.status])) })}\n\n` }));
}

export async function openSaved(page, saved) {
  await installRunFixture(page, saved);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(saved.result.strategyRuns.length);
  await expect(page.locator(".result-interactions")).not.toBeDisabled();
}

/** Restore a saved API response through the same reconnect path as a running job. */
export async function restoreSavedRecord(page, record) {
  await installRunFixture(page, record.result);
  for (const [id, detail] of Object.entries(record.candidateDetails ?? {})) {
    await page.route(`**/api/v1/runs/${record.result.runId}/candidates/${encodeURIComponent(id)}`, route => route.fulfill({ json: detail }));
  }
  if (record.csv) await page.route(`**/api/v1/runs/${record.result.runId}/export/*?*`, route => {
    const url = new URL(route.request().url());
    const key = `${url.searchParams.get("focusedResultId")}/${url.pathname.split("/").at(-1)}`;
    const csv = record.csv[key];
    return csv === undefined ? route.fulfill({ status: 409, json: {} }) : route.fulfill({ contentType: "text/csv", body: csv,
      headers: { "Content-Disposition": `attachment; filename="${record.result.runId}-${key.replaceAll("/", "-")}.csv"` } });
  });
  await page.reload();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(record.result.result.strategyRuns.length);
  await expect(page.locator(".run-submit-button")).toHaveAttribute("aria-busy", "false");
}

export function strategyFile(saved) {
  return { format: "stock-etf-backtester", schemaVersion: 1, type: "strategy", exportedAt: new Date().toISOString(),
    catalogVersion: saved.snapshot.catalogVersion, draft: structuredClone(saved.snapshot.config) };
}

export async function importPackage(page, file, confirm = true) {
  await openTopbarMenu(page);
  await expect(page.locator(".package-actions")).toBeVisible();
  await page.locator(".file-import-input").setInputFiles({ name: `fixture.${file.type}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.locator(".package-preview")).toBeVisible();
  if (confirm) await page.locator(".package-preview .button-primary").click();
}

export async function fetchSavedRecord(page, saved) {
  const candidateDetails = {}, csv = {};
  for (const parent of saved.result.strategyRuns) {
    const search = parent.searchResult;
    if (!search) continue;
    const ids = search.candidates.flatMap(row => [row.candidateId, ...(row.testResult ? [row.testResult.resultId] : [])]);
    if (search.outOfSample) ids.push(search.outOfSample.resultId);
    for (const id of ids) {
      const response = await page.request.get(`/api/v1/runs/${saved.runId}/candidates/${encodeURIComponent(id)}`);
      expect(response.status()).toBe(200);
      candidateDetails[id] = await response.json();
    }
  }
  for (const result of [...saved.result.strategyRuns, ...Object.values(candidateDetails)]) {
    if (!result.metrics) continue;
    for (const kind of ["summary", "daily-assets", "trades", ...(result.searchResult ? ["search-results"] : [])]) {
      const response = await page.request.get(`/api/v1/runs/${saved.runId}/export/${kind}`, { params: { focusedResultId: result.id } });
      expect(response.status()).toBe(200); csv[`${result.id}/${kind}`] = await response.text();
    }
  }
  return { result: saved, candidateDetails, csv };
}
