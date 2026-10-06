import { expect, test } from "@playwright/test";

async function completedRun(page) {
  const accepted = await page.request.post("/api/v1/runs", {
    headers: { "Idempotency-Key": `lifecycle-${Date.now()}` },
    data: {
      draft: {
        shared: { run: { symbol: "QQQ", startDate: "2024-02-01", endDate: "2024-03-01" }, contribution: { amount: 100, day: 1 } },
        strategies: [{ id: "strategy-vix_dca-1", presetId: "vix_dca", params: {} }],
      },
      scope: "all_enabled",
    },
  });
  expect(accepted.status()).toBe(202);
  const { runId } = await accepted.json();
  let saved;
  await expect.poll(async () => {
    saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
    return saved.status;
  }).toBe("completed");
  return saved;
}

function copyRun(saved, runId, status) {
  const copy = structuredClone(saved);
  copy.runId = copy.snapshot.runId = copy.result.runId = runId;
  copy.status = copy.result.status = status;
  if (status !== "completed") {
    copy.progress = { ...copy.progress, completedStrategies: status === "cancelled" ? 3 : 1, currentStrategyId: status === "cancelled" ? null : "benchmark:lump-sum" };
    for (const row of copy.result.strategyRuns) {
      if (row.id === "benchmark:monthly-dca") continue;
      row.status = status === "cancelled" ? "cancelled" : row.id === "benchmark:lump-sum" ? "running" : "queued";
      row.metrics = null;
      row.dailyAssets = [];
      row.trades = [];
      row.signals = [];
      row.technicalIndicators = [];
    }
  }
  return copy;
}

async function delayedStop(page, saved, finishOld = true) {
  const first = copyRun(saved, "audit-old-run", "running");
  const stopped = copyRun(saved, first.runId, "cancelled");
  const second = copyRun(saved, "audit-new-run", "completed");
  let submissions = 0;
  await page.route("**/api/v1/runs", route => route.fulfill({ status: 202, json: submissions++ === 0 ? first : copyRun(second, second.runId, "running") }));
  for (const response of [stopped, second]) {
    await page.route(`**/api/v1/runs/${response.runId}`, route => route.fulfill({ json: response }));
  }
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.lifecycleAudit = { streams: {}, stopRequests: 0 };
    window.fetch = (input, options) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/v1/runs/audit-old-run/stop") {
        window.lifecycleAudit.stopRequests++;
        // An already delivered response can settle after cancellation; the owner must still check identity.
        return new Promise(resolve => {
          window.lifecycleAudit.releaseStop = (body, status) => resolve(new Response(JSON.stringify(body), {
            status, headers: { "Content-Type": "application/json" },
          }));
        });
      }
      const runId = url.match(/\/runs\/(audit-(?:old|new)-run)\/events$/)?.[1];
      if (!runId) return originalFetch(input, options);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.lifecycleAudit.streams[runId] = {
          terminal(run) {
            controller.enqueue(new TextEncoder().encode(`event: terminal\ndata: ${JSON.stringify({
              runId: run.runId, status: run.status, progress: run.progress,
              strategyStatuses: Object.fromEntries(run.result.strategyRuns.map(row => [row.id, row.status])),
            })}\n\n`));
            controller.close();
          },
        };
      } }), { headers: { "Content-Type": "text/event-stream" } }));
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".shared-settings-open-button").click();
  await page.locator("#field-run-startDate").fill("2024-02-01");
  await page.locator("#field-run-endDate").fill("2024-03-01");
  await page.locator(".shared-settings-dialog .dialog-done").click();
  await page.locator(".run-submit-button").click();
  await expect.poll(() => page.evaluate(() => Boolean(window.lifecycleAudit.streams["audit-old-run"]))).toBe(true);
  await page.locator(".run-stop-button").click();
  await expect.poll(() => page.evaluate(() => window.lifecycleAudit.stopRequests)).toBe(1);
  if (finishOld) {
    await finish(page, stopped);
    await expect(page.locator(".result-stopped")).toHaveCount(2);
  }
  return { stopped, second };
}

async function finish(page, run) {
  await page.evaluate(run => window.lifecycleAudit.streams[run.runId].terminal(run), run);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
}

async function releaseStop(page, stopped, failed = false) {
  await page.evaluate(async ({ stopped, failed }) => {
    window.lifecycleAudit.releaseStop(failed ? {
      error: { code: "provider_request_failed", messageKey: "api.errors.connection_failed", diagnostics: [] },
    } : stopped, failed ? 503 : 200);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { stopped, failed });
}

test("a late stop response cannot replace a completed newer run or its selection", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const { stopped, second } = await delayedStop(page, await completedRun(page));
  await page.locator(".run-submit-button").click();
  await expect.poll(() => page.evaluate(() => Boolean(window.lifecycleAudit.streams["audit-new-run"]))).toBe(true);
  await finish(page, second);
  const selected = page.locator(".comparison-table").getByRole("button", { name: "ボラティリティ積立", exact: true });
  await selected.click();
  const curve = await page.locator("polyline.overlay-totalAsset").getAttribute("points");
  await releaseStop(page, stopped);
  await expect(page.locator(".result-stopped")).toHaveCount(0);
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("polyline.overlay-totalAsset")).toHaveAttribute("points", curve);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("new-result-after-late-stop.png") });
});

test("a late stop error cannot unlock or show an error on a newer running job", async ({ page }) => {
  const { stopped, second } = await delayedStop(page, await completedRun(page));
  await page.locator(".run-submit-button").click();
  await expect.poll(() => page.evaluate(() => Boolean(window.lifecycleAudit.streams["audit-new-run"]))).toBe(true);
  await releaseStop(page, stopped, true);
  await expect(page.locator("#result-details [role=alert]")).toHaveCount(0);
  await expect(page.locator(".run-submit-button")).toBeDisabled();
  await expect(page.locator(".run-stop-button")).toBeEnabled();
  await expect(page.locator(".shared-settings-open-button")).toBeDisabled();
  await finish(page, second);
  await expect(page.locator("#result-details [role=alert]")).toHaveCount(0);
});

test("reset results stay empty when an old stop response arrives later", async ({ page }) => {
  const { stopped } = await delayedStop(page, await completedRun(page));
  await page.locator(".run-reset-button").click();
  await expect(page.locator(".empty-results")).toBeVisible();
  await releaseStop(page, stopped);
  await expect(page.locator(".empty-results")).toBeVisible();
  await expect(page.locator(".comparison-table")).toHaveCount(0);
  await expect(page.locator(".run-reset-button")).toBeDisabled();
});

test("a failed current stop remains visible and a successful retry clears its error", async ({ page }) => {
  const { stopped } = await delayedStop(page, await completedRun(page), false);
  await releaseStop(page, stopped, true);
  await expect(page.locator("#result-details [role=alert]")).toBeVisible();
  await expect(page.locator(".run-stop-button")).toBeEnabled();
  await expect(page.locator(".run-submit-button")).toBeDisabled();
  await page.locator(".run-stop-button").click();
  await expect.poll(() => page.evaluate(() => window.lifecycleAudit.stopRequests)).toBe(2);
  await releaseStop(page, stopped);
  await expect(page.locator(".result-stopped")).toHaveCount(2);
  await finish(page, stopped);
  await expect(page.locator("#result-details [role=alert]")).toHaveCount(0);
  await expect(page.locator(".comparison-table tbody tr").filter({ hasText: "毎月定額積立" })).toContainText("$");
});

test("CRLF progress streams finish with one full result read and no false connection error", async ({ page }) => {
  const saved = await completedRun(page);
  const pending = copyRun(saved, saved.runId, "running");
  let fullReads = 0;
  let subscriptions = 0;
  let submissions = 0;
  await page.route("**/api/v1/runs", route => {
    submissions++;
    return route.fulfill({ status: 202, json: pending });
  });
  await page.route(`**/api/v1/runs/${saved.runId}`, route => {
    fullReads++;
    return route.fulfill({ json: saved });
  });
  await page.route(`**/api/v1/runs/${saved.runId}/events`, route => {
    subscriptions++;
    return route.fulfill({ contentType: "text/event-stream", body: `: keep-alive\r\nevent: terminal\r\ndata: ${JSON.stringify({
      runId: saved.runId, status: saved.status, progress: saved.progress,
      strategyStatuses: Object.fromEntries(saved.result.strategyRuns.map(row => [row.id, row.status])),
    })}\r\n\r\n` });
  });
  await page.goto("/");
  await page.locator(".run-submit-button").click();
  await expect.poll(() => fullReads).toBe(1);
  await expect(page.locator(".run-submit-button")).toBeEnabled();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".result-stopped, .result-waiting, .comparison-table .run-button-spinner")).toHaveCount(0);
  await expect(page.locator("#result-details [role=alert]")).toHaveCount(0);
  expect(fullReads).toBe(1);
  expect(subscriptions).toBe(1);
  expect(submissions).toBe(1);
});
