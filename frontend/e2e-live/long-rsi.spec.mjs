import { expect, test } from '@playwright/test';

test('2010 Yahoo QQQ/VIX/RSI long history shows saved curves and remains executable', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('.shared-settings-open-button').click();
  await page.locator('#field-run-startDate').fill('2010-01-01');
  await page.locator('#field-run-endDate').fill('2026-10-07');
  await page.locator('.shared-settings-dialog .dialog-done').click();
  await page.locator('.add-strategy-button').click();
  await page.locator('[data-preset-id="rsi_dca"]').click();
  const accepted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/v1/runs'));
  await page.locator('.run-submit-button').click();
  const { runId } = await (await accepted).json();
  await expect(page.locator('.run-submit-button')).toBeEnabled({ timeout: 90000 });
  const response = await page.request.get(`/api/v1/runs/${runId}`);
  expect(response.ok()).toBe(true);
  const saved = await response.json();
  expect(saved.status).toBe('completed');
  expect(saved.result.strategyRuns).toHaveLength(4);
  for (const row of saved.result.strategyRuns) {
    expect(row.dailyAssets).toHaveLength(4216);
    expect(row.status).toBe('completed');
  }
  await expect(page.locator('.comparison-table tbody tr')).toHaveCount(4);
  await expect(page.locator('#result-details [role=alert]')).toHaveCount(0);
  await expect(page.locator('.chart-overlay polyline')).not.toHaveCount(0);
  expect(errors).toEqual([]);
});
