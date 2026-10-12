import { expect, test } from '@playwright/test';
import { openSaved, savedRun } from './helpers/reports.mjs';

for (const width of [320, 768, 1024, 1440]) {
  test(`expanded table keyboard sorting remains visible and aligned at ${width}px`, async ({ page }) => {
    const saved = await savedRun(page);
    saved.result.strategyRuns[0].trades = Array.from({ length: 80 }, () => ({ date: '2024-02-02', side: 'buy', reason: 'fixed_dca', quantity: '1', price: '1', cashAmount: '1', currency: 'USD' }));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await openSaved(page, saved);
    await page.setViewportSize({ width, height: 900 });
    const region = page.locator('.trade-table-region');
    await region.locator('.table-expand-button').click();
    await region.locator('tbody tr').nth(40).scrollIntoViewIfNeeded();
    const sorter = region.locator('thead button').last();
    await sorter.focus();
    await page.keyboard.press('Enter');
    await expect(sorter.locator('..')).toHaveAttribute('aria-sort', 'ascending');
    await expect.poll(async () => sorter.evaluate(button => {
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { inside: box.y >= 0 && box.bottom <= innerHeight && box.x >= 0 && box.right <= innerWidth, onTop: hit?.closest('button') === button };
    })).toEqual({ inside: true, onTop: true });
    await page.keyboard.press('Shift+Tab');
    await expect(region.locator('thead button').nth(5)).toBeFocused();
    await page.screenshot({ path: test.info().outputPath(`keyboard-${width}.png`) });
    expect(errors).toEqual([]);
  });
}

for (const locale of ['ja', 'zh', 'en']) for (const theme of ['light', 'dark']) {
  test(`${locale} ${theme} menus preserve focus across phone and desktop transitions`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await openSaved(page, await savedRun(page));
    await page.locator('.locale-select').selectOption(locale);
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const downloads = page.locator('.result-downloads-toggle');
    await page.locator('[data-report-kind=png]').focus();
    await expect(page.locator('[data-report-kind=png]')).toBeFocused();
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(downloads).toBeFocused();
    await expect(page.locator('.result-downloads-panel')).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(page.locator('.result-downloads-panel')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-export-kind=summary]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(downloads).toBeFocused();
    await expect(page.locator('.result-downloads-panel')).toBeHidden();

    await page.locator('.topbar-menu-toggle').click();
    await expect(page.locator('.topbar-functions')).toBeVisible();
    await page.locator('.topbar-brand').click();
    await expect(page.locator('.topbar-functions')).toBeHidden();
    await downloads.click();
    await expect(page.locator('.result-downloads-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(page.locator('[data-export-kind=summary]')).toBeFocused();
    const price = page.locator('.chart-controls [data-series=price]');
    await price.focus();
    await page.setViewportSize({ width: 320, height: 900 });
    const chartMenu = page.locator('.chart-phone-menu-toggle');
    await expect(chartMenu).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(price).toBeVisible();
    const before = await price.getAttribute('aria-pressed');
    await price.click();
    await expect(price).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
    await page.keyboard.press('Escape');
    await expect(chartMenu).toBeFocused();
    await expect(page.locator('.chart-controls')).toBeHidden();
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(price).toBeFocused();
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(chartMenu).toBeFocused();
    const navToggle = page.locator('.topbar-menu-toggle');
    await navToggle.focus();
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(page.locator('.package-actions button').first()).toBeFocused();
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(navToggle).toBeFocused();
    await page.locator('.run-submit-button').focus();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.run-submit-button')).toBeFocused();
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(page.locator('.run-submit-button')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    expect(await page.locator('svg polyline, svg path').evaluateAll(nodes => nodes.some(node => /NaN|Infinity/.test(node.getAttribute('points') ?? node.getAttribute('d') ?? '')))).toBe(false);
    await page.screenshot({ path: test.info().outputPath(`menus-${locale}-${theme}.png`) });
    expect(errors).toEqual([]);
  });
}

test('search candidates keep the zoom for the same dates and reset it for a new evaluation period', async ({ page }) => {
  const saved = await savedRun(page, 'grid_search', {
    'search.optimizationMode': 'train_test', 'search.trainEndDate': '2024-02-28',
    'search.dimensions': ['vix.buyThreshold', 'accumulation.cashSafetyLimit'],
    'search.values.vix.buyThreshold': [20, 30], 'search.values.accumulation.cashSafetyLimit': [100, 200],
  }, rules => { rules.buy = rules.buy.children.find(item => item.kind === 'vix'); rules.sell = null; });
  await openSaved(page, saved);
  await page.locator('.comparison-table tr[data-result-id=report-strategy] .result-select').click();
  const section = page.locator('.result-search-section');
  if (!await section.evaluate(node => node.open)) await section.locator(':scope > summary').click();
  await page.locator('.search-lab > summary').click();
  const chart = page.locator('.chart-overlay');
  const svg = chart.locator('svg.result-chart');
  await svg.focus();
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  const zoomed = await chart.getAttribute('data-window-start');
  expect(Number(zoomed)).toBeGreaterThan(0);
  const first = page.locator('.search-heat-cell').first();
  await first.click();
  await expect(page.locator('.result-detail-name')).toContainText('#');
  await expect(chart).toHaveAttribute('data-window-start', zoomed);
  await page.locator('.search-lab').getByLabel('評価期間', { exact: true }).selectOption('test');
  await first.click();
  await expect(page.locator('.result-detail-name')).toContainText('テスト');
  await expect(chart).toHaveAttribute('data-window-start', '0');
  await expect(chart).toHaveAttribute('data-window-end', '1');
  await expect(page.locator('.chart-overlay .chart-crosshair')).toHaveCount(0);
  const testPeriod = saved.result.strategyRuns[0].searchResult.testPeriod;
  const dates = await page.locator('.chart-date-axis .chart-x-tick').allTextContents();
  expect(dates.every(date => date >= testPeriod.startDate && date <= testPeriod.endDate)).toBe(true);
});
