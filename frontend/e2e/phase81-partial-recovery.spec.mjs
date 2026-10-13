import { expect, test } from '@playwright/test';
import { selectHeaderLocale } from './helpers/runtime.mjs';
import { readFile } from 'node:fs/promises';

async function partialResult(page, key) {
  const accepted = await page.request.post('/api/v1/runs', {
    headers: { 'Idempotency-Key': key },
    data: { draft: {
      shared: { run: { symbol: 'QQQ', startDate: '2024-02-01', endDate: '2024-03-01' }, contribution: { amount: 100, day: 1 } },
      strategies: [
        { id: 'strategy-vix_dca-1', presetId: 'vix_dca', params: {} },
        { id: 'strategy-rsi_dca-2', presetId: 'rsi_dca', params: { 'rsi.period': 252 } },
      ],
    }, scope: 'all_enabled' },
  });
  expect(accepted.status()).toBe(202);
  const { runId } = await accepted.json();
  let saved;
  await expect.poll(async () => {
    saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
    return saved.status;
  }).toBe('completed_with_warning');
  const rsi = saved.result.strategyRuns.find(row => row.presetId === 'rsi_dca');
  expect(rsi.status).toBe('unavailable');
  expect(rsi.diagnostics.length).toBeGreaterThan(0);
  expect(saved.result.strategyRuns.filter(row => row.metrics)).toHaveLength(3);
  return saved;
}

for (const locale of ['ja', 'zh', 'en']) for (const width of [375, 1440]) {
  test(`interrupted partial run keeps successful charts, downloads and rerun in ${locale} at ${width}px`, async ({ page }) => {
    const savedRuns = await Promise.all([partialResult(page, `partial-${locale}-${width}-1`), partialResult(page, `partial-${locale}-${width}-2`)]);
    await page.setViewportSize({ width, height: 900 });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('/');
    await selectHeaderLocale(page, locale);
    await page.locator('.shared-settings-open-button').click();
    await page.locator('#field-run-startDate').fill('2024-02-01');
    await page.locator('#field-run-endDate').fill('2024-03-01');
    await page.locator('.shared-settings-dialog .dialog-done').click();
    await expect(page.locator('.shared-settings-dialog')).toBeHidden();
    await page.locator('.add-strategy-button').click();
    await page.locator('[data-preset-id="rsi_dca"]').click();
    await page.locator('.strategy-card').filter({ hasText: 'RSI' }).locator('.strategy-card-open').click();
    await page.locator('.strategy-dialog [data-rule-side="buy"] input[id$="-rsi-period"]').fill('252');
    await page.locator('.strategy-dialog .dialog-done').click();
    await expect(page.locator('.strategy-dialog')).toBeHidden();
    let submissions = 0, recovered = false, preflightFailures = 0;
    await page.route('**/api/v1/config/validate', route => {
      if (recovered && preflightFailures++ === 0) return route.fulfill({ status: 503, json: { error: { code: 'provider_request_failed', messageKey: 'api.errors.connection_failed', diagnostics: [] } } });
      return route.continue();
    });
    for (const saved of savedRuns) {
      await page.route(`**/api/v1/runs/${saved.runId}`, route => {
        recovered = true;
        return route.fulfill({ json: saved });
      });
      const statuses = Object.fromEntries(saved.result.strategyRuns.map(row => [row.id, row.presetId === 'rsi_dca' ? 'running' : row.status]));
      const summaries = Object.fromEntries(saved.result.strategyRuns.filter(row => row.metrics).map(row => [row.id, { metrics: row.metrics, diagnostics: row.diagnostics }]));
      await page.route(`**/api/v1/runs/${saved.runId}/events`, route => route.fulfill({ contentType: 'text/event-stream', body: `event: progress\ndata: ${JSON.stringify({ runId: saved.runId, status: 'running', progress: { ...saved.progress, completedStrategies: 3, currentStrategyId: 'strategy-rsi_dca-2' }, strategyStatuses: statuses, strategySummaries: summaries })}\n\n` }));
    }
    await page.route('**/api/v1/runs', route => {
      const active = structuredClone(savedRuns[submissions++]);
      active.status = active.result.status = 'running';
      Object.assign(active.progress, { completedStrategies: 3, currentStrategyId: 'strategy-rsi_dca-2' });
      for (const row of active.result.strategyRuns) {
        row.dailyAssets = []; row.trades = []; row.signals = []; row.technicalIndicators = [];
        if (row.presetId === 'rsi_dca') { row.status = 'running'; row.diagnostics = []; }
      }
      return route.fulfill({ status: 202, json: active });
    });
    await page.locator('.run-submit-button').click();
    await expect(page.locator('.comparison-table tbody tr')).toHaveCount(4);
    await expect(page.locator('.result-interactions')).not.toBeDisabled();
    await expect.poll(() => preflightFailures).toBeGreaterThan(0);
    await expect(page.locator('.run-submit-button')).toBeEnabled();
    await expect(page.locator('.comparison-table .run-button-spinner')).toHaveCount(0);
    for (const id of ['benchmark:monthly-dca', 'strategy-vix_dca-1']) {
      await page.locator(`.comparison-table tr[data-result-id="${id}"] .result-select`).click();
      await expect(page.locator('.chart-overlay polyline.overlay-totalAsset')).toHaveCount(1);
      expect((await page.locator('.chart-overlay polyline.overlay-totalAsset').getAttribute('points')).split(' ').length).toBeGreaterThan(1);
    }
    await page.locator('.selected-strategy-chip[data-result-id="benchmark:monthly-dca"]').click();
    if (width < 768) await page.locator('.result-downloads-toggle').click();
    const download = page.waitForEvent('download');
    await page.locator('[data-export-kind="daily-assets"]').click();
    const csv = await readFile(await (await download).path(), 'utf8');
    expect(csv).toContain('benchmark:monthly-dca');
    expect(csv).toContain(savedRuns[0].result.strategyRuns.find(row => row.id === 'benchmark:monthly-dca').dailyAssets[0].date);
    if (width < 768) await page.keyboard.press('Escape');
    await page.locator('.run-submit-button').click();
    await expect.poll(() => submissions).toBe(2);
    await expect(page.locator('.run-submit-button')).toBeEnabled();
    await expect(page.locator('.comparison-table tbody tr')).toHaveCount(4);
    expect(pageErrors).toEqual([]);
  });
}

test('sustained interruption keeps the accepted job stoppable and resumes without another submission', async ({ page }) => {
  const saved = await partialResult(page, 'persistent-recovery');
  const active = structuredClone(saved);
  active.status = active.result.status = 'running';
  active.result.strategyRuns.find(row => row.presetId === 'rsi_dca').status = 'running';
  let subscriptions = 0, submissions = 0;
  await page.addInitScript(() => {
    const timer = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      const id = timer(callback, delay, ...args);
      if (delay === 30000) window.resumeRunRecovery = () => { clearTimeout(id); callback(...args); };
      return id;
    };
  });
  await page.route('**/api/v1/runs', route => { submissions++; return route.fulfill({ status: 202, json: active }); });
  await page.route(`**/api/v1/runs/${saved.runId}`, route => route.fulfill({ json: subscriptions <= 4 ? active : saved }));
  await page.route(`**/api/v1/runs/${saved.runId}/events`, route => {
    subscriptions++;
    if (subscriptions <= 4) return route.fulfill({ status: 503, json: { error: { code: 'provider_request_failed', messageKey: 'api.errors.connection_failed', diagnostics: [] } } });
    return route.fulfill({ contentType: 'text/event-stream', body: `event: terminal\ndata: ${JSON.stringify({ runId: saved.runId, status: saved.status, progress: saved.progress, strategyStatuses: Object.fromEntries(saved.result.strategyRuns.map(row => [row.id, row.status])) })}\n\n` });
  });
  await page.goto('/');
  await page.locator('.run-submit-button').click();
  await expect(page.locator('#result-details [role=alert]').filter({ hasText: /API/ })).toBeVisible();
  expect(subscriptions).toBe(4);
  await expect(page.locator('.run-stop-button')).toBeEnabled();
  await expect(page.locator('.run-submit-button')).toBeDisabled();
  expect(await page.evaluate(() => sessionStorage.getItem('stock-etf-backtester.active-run-id.v1'))).toBe(saved.runId);
  await page.evaluate(() => window.resumeRunRecovery());
  await expect(page.locator('.run-submit-button')).toBeEnabled();
  expect(submissions).toBe(1);
  expect(subscriptions).toBe(5);
  await expect(page.locator('.chart-overlay polyline')).not.toHaveCount(0);
});

test('boot recovery clears its connection alert when the same active snapshot becomes reachable', async ({ page }) => {
  const saved = await partialResult(page, 'boot-recovery');
  const active = structuredClone(saved);
  active.status = active.result.status = 'running';
  active.result.strategyRuns.find(row => row.presetId === 'rsi_dca').status = 'running';
  let subscriptions = 0, finished = false, pendingEvent;
  await page.addInitScript(runId => {
    sessionStorage.setItem('stock-etf-backtester.active-run-id.v1', runId);
    const timer = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      const id = timer(callback, delay, ...args);
      if (delay === 30000) window.resumeRunRecovery = () => { clearTimeout(id); callback(...args); };
      return id;
    };
  }, saved.runId);
  await page.route(`**/api/v1/runs/${saved.runId}`, route => route.fulfill({ json: finished ? saved : active }));
  await page.route(`**/api/v1/runs/${saved.runId}/events`, route => {
    subscriptions++;
    if (subscriptions <= 4) return route.fulfill({ status: 503, json: { error: { code: 'provider_request_failed', messageKey: 'api.errors.connection_failed', diagnostics: [] } } });
    if (subscriptions === 5) return route.fulfill({ contentType: 'text/event-stream', body: ': keep-alive\n\n' });
    pendingEvent = route;
  });
  await page.goto('/');
  await expect(page.locator('#result-details [role=alert]').filter({ hasText: /API/ })).toBeVisible();
  await expect(page.locator('.run-stop-button')).toBeEnabled();
  await page.evaluate(() => window.resumeRunRecovery());
  await expect.poll(() => subscriptions).toBe(6);
  await expect(page.locator('#result-details [role=alert]').filter({ hasText: /API/ })).toHaveCount(0);
  await expect(page.locator('#result-details [role=alert]')).toContainText('この戦略に必要なデータ');
  await expect(page.locator('.run-stop-button')).toBeEnabled();
  finished = true;
  await pendingEvent.fulfill({ contentType: 'text/event-stream', body: `event: terminal\ndata: ${JSON.stringify({ runId: saved.runId, status: saved.status, progress: saved.progress, strategyStatuses: Object.fromEntries(saved.result.strategyRuns.map(row => [row.id, row.status])) })}\n\n` });
  await expect(page.locator('.run-submit-button')).toBeEnabled();
  await expect(page.locator('.chart-overlay polyline')).not.toHaveCount(0);
});
