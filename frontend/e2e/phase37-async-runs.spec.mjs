import { expect, test } from "@playwright/test";
import { savedRun } from "./helpers/reports.mjs";

test("queued acceptance and loading remain stoppable before any data or metrics exist", async ({ page }) => {
  const saved = await savedRun(page);
  const queued = structuredClone(saved);
  queued.status = queued.result.status = "queued";
  Object.assign(queued.snapshot, { dataContext: null, dataFingerprint: null, dataProvenance: {}, dateAdjustments: [] });
  queued.progress = { completedStrategies: 0, totalStrategies: 3, currentStrategyId: null };
  for (const row of queued.result.strategyRuns) Object.assign(row, { status: "queued", metrics: null, dailyAssets: [], trades: [], signals: [], technicalIndicators: [] });
  const loading = structuredClone(queued);
  loading.status = loading.result.status = "loading";
  loading.result.strategyRuns[0].status = "loading";
  const stopped = structuredClone(queued);
  stopped.status = stopped.result.status = "cancelled";
  stopped.progress.completedStrategies = 3;
  for (const row of stopped.result.strategyRuns) Object.assign(row, { status: "cancelled", diagnostics: [{ code: "run_cancelled", messageKey: "runs.cancelled", severity: "info" }] });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/v1/runs/active", route => route.fulfill({ json: null }));
  await page.route("**/api/v1/runs", route => route.fulfill({ status: 202, json: queued }));
  await page.route(`**/api/v1/runs/${saved.runId}/stop`, route => route.fulfill({ json: stopped }));
  let gets = 0;
  await page.route(`**/api/v1/runs/${saved.runId}`, route => { gets++; return route.fulfill({ json: stopped }); });
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, options) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.endsWith("/events")) return original(input, options);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.asyncRunEvent = (run, terminal = false) => {
          controller.enqueue(new TextEncoder().encode(`event: ${terminal ? "terminal" : "progress"}\ndata: ${JSON.stringify({
            runId: run.runId, status: run.status, progress: run.progress,
            strategyStatuses: Object.fromEntries(run.result.strategyRuns.map(row => [row.id, row.status])),
          })}\n\n`));
          if (terminal) controller.close();
        };
      } }), { headers: { "Content-Type": "text/event-stream" } }));
    };
  });
  await page.goto("/");
  await page.locator(".run-submit-button").click();
  await expect.poll(() => page.evaluate(() => Boolean(window.asyncRunEvent))).toBe(true);
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".run-stop-button")).toBeEnabled();
  await expect(page.locator(".run-submit-button")).toBeDisabled();
  await expect(page.locator(".shared-settings-open-button")).toBeDisabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("stock-etf-backtester.last-run-strategy.v1")).draft.shared.run.symbol)).toBe("QQQ");
  await page.evaluate(run => window.asyncRunEvent(run), loading);
  await expect(page.locator(".comparison-table tbody tr.is-running")).toHaveCount(1);
  await expect(page.locator(".comparison-table .run-button-spinner")).toHaveCount(1);
  await page.locator(".run-stop-button").click();
  await expect(page.locator(".result-stopped")).toHaveCount(3);
  await page.evaluate(run => window.asyncRunEvent(run, true), stopped);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await expect(page.locator(".chart-overlay svg")).toHaveCount(0);
  expect(gets).toBe(1);
  expect(errors).toEqual([]);
});

test("a stop requested before 202 stays subscribed after rejection and can be retried", async ({ page }) => {
  const queued = await savedRun(page);
  queued.status = queued.result.status = "queued";
  Object.assign(queued.snapshot, { dataContext: null, dataFingerprint: null, dataProvenance: {}, dateAdjustments: [] });
  queued.progress = { completedStrategies: 0, totalStrategies: 3, currentStrategyId: null };
  for (const row of queued.result.strategyRuns) Object.assign(row, { status: "queued", metrics: null, dailyAssets: [], trades: [], signals: [], technicalIndicators: [] });
  const stopped = structuredClone(queued);
  stopped.status = stopped.result.status = "cancelled";
  stopped.progress.completedStrategies = 3;
  for (const row of stopped.result.strategyRuns) Object.assign(row, { status: "cancelled", diagnostics: [{ code: "run_cancelled", messageKey: "runs.cancelled", severity: "info" }] });
  await page.route("**/api/v1/runs/active", route => route.fulfill({ json: null }));
  await page.route(`**/api/v1/runs/${queued.runId}`, route => route.fulfill({ json: stopped }));
  await page.addInitScript(({ queued, stopped }) => {
    const original = window.fetch;
    window.earlyStops = 0;
    window.fetch = (input, options) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/v1/runs") return new Promise(resolve => { window.acceptEarlyRun = () => resolve(new Response(JSON.stringify(queued), { status: 202 })); });
      if (url.endsWith("/stop")) {
        window.earlyStops++;
        return Promise.resolve(new Response(JSON.stringify(window.earlyStops === 1
          ? { error: { code: "provider_request_failed", messageKey: "api.errors.connection_failed", diagnostics: [] } } : stopped), { status: window.earlyStops === 1 ? 503 : 200 }));
      }
      if (url.endsWith("/events")) return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.finishEarlyRun = () => {
          controller.enqueue(new TextEncoder().encode(`event: terminal\ndata: ${JSON.stringify({ runId: stopped.runId, status: stopped.status, progress: stopped.progress,
            strategyStatuses: Object.fromEntries(stopped.result.strategyRuns.map(row => [row.id, row.status])) })}\n\n`));
          controller.close();
        };
      } }), { headers: { "Content-Type": "text/event-stream" } }));
      return original(input, options);
    };
  }, { queued, stopped });
  await page.goto("/");
  await page.locator(".shared-settings-open-button").click();
  await page.locator("#field-run-startDate").fill(queued.snapshot.config.shared.run.startDate);
  await page.locator("#field-run-endDate").fill(queued.snapshot.config.shared.run.endDate);
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await page.locator(".run-submit-button").click();
  await expect.poll(() => page.evaluate(() => Boolean(window.acceptEarlyRun))).toBe(true);
  await page.locator(".run-stop-button").click();
  expect(await page.evaluate(() => window.earlyStops)).toBe(0);
  await page.evaluate(() => window.acceptEarlyRun());
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => window.earlyStops)).toBe(1);
  await expect(page.locator(".run-stop-button")).toBeEnabled();
  await expect(page.locator(".run-submit-button")).toBeDisabled();
  await expect.poll(() => page.evaluate(() => Boolean(window.finishEarlyRun))).toBe(true);
  await page.locator(".run-stop-button").click();
  await expect(page.locator(".result-stopped")).toHaveCount(3);
  await page.evaluate(() => window.finishEarlyRun());
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  expect(await page.evaluate(() => window.earlyStops)).toBe(2);
});
