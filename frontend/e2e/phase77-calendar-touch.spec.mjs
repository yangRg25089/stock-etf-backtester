import { expect, test } from '@playwright/test';
import { openSaved, savedRun } from './helpers/reports.mjs';

test('changing the saved calendar cancels a retained touch reading and the next long press works', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 375, height: 900 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const saved = await savedRun(page, 'grid_search', {
      'search.optimizationMode': 'train_test', 'search.trainEndDate': '2024-02-28',
      'search.dimensions': ['vix.buyThreshold', 'accumulation.cashSafetyLimit'],
      'search.values.vix.buyThreshold': [20, 30], 'search.values.accumulation.cashSafetyLimit': [100, 200],
    }, rules => { rules.buy = rules.buy.children.find(item => item.kind === 'vix'); rules.sell = null; });
    await openSaved(page, saved);
    await page.locator('.comparison-table tr[data-result-id=report-strategy] .result-select').click();
    await page.setViewportSize({ width: 375, height: 900 });
    const section = page.locator('.result-search-section');
    if (!await section.evaluate(node => node.open)) await section.locator(':scope > summary').click();
    await page.locator('.search-lab > summary').click();
    await page.locator('.search-lab').getByLabel('評価期間', { exact: true }).selectOption('test');
    let confirmRequest;
    const started = new Promise(resolve => { confirmRequest = resolve; });
    await page.route('**/api/v1/runs/*/candidates/*', async route => {
      const response = await route.fetch();
      confirmRequest();
      await gate;
      await route.fulfill({ response });
    });
    const cell = page.locator('.search-heat-cell').first();
    await cell.scrollIntoViewIfNeeded();
    const probe = await cell.evaluate(node => {
      const table = node.closest('table'), box = node.getBoundingClientRect(), scroll = table.closest('.result-table-scroll');
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { cell: box.toJSON(), firstColumn: table.tBodies[0].rows[0].cells[0].getBoundingClientRect().toJSON(), scroll: scroll.getBoundingClientRect().toJSON(), scrollLeft: scroll.scrollLeft, width: innerWidth, documentWidth: document.documentElement.scrollWidth, scrollX, hit: hit?.outerHTML.slice(0, 160), clickable: hit?.closest('button') === node };
    });
    expect(probe.clickable, JSON.stringify(probe)).toBe(true);
    await cell.tap();
    await started;
    const chart = page.locator('.chart-overlay svg.result-chart');
    await chart.scrollIntoViewIfNeeded();
    const point = () => chart.evaluate(svg => {
      const box = svg.getBoundingClientRect(), plot = svg.querySelector('clipPath rect');
      return {
        x: box.x + (Number(plot.getAttribute('x')) + Number(plot.getAttribute('width')) * 0.95) / svg.viewBox.baseVal.width * box.width,
        y: box.y + (Number(plot.getAttribute('y')) + Number(plot.getAttribute('height')) * 0.5) / svg.viewBox.baseVal.height * box.height,
      };
    });
    const session = await context.newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [await point()] });
    await expect(page.locator('.chart-overlay .chart-crosshair')).toHaveCount(1, { timeout: 2500 });
    await expect(page.locator('.chart-overlay .chart-crosshair')).toHaveAttribute('data-date', '2024-02-28');
    release();
    await expect(page.locator('.result-detail-name')).toContainText('テスト');
    await expect(page.locator('.chart-overlay .chart-crosshair')).toHaveCount(0);
    await expect(page.locator('.chart-overlay .chart-crosshair-readout')).toHaveAttribute('data-date', '2024-03-01');
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await chart.scrollIntoViewIfNeeded();
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [await point()] });
    await expect(page.locator('.chart-overlay .chart-crosshair')).toHaveCount(1, { timeout: 2500 });
    await expect(page.locator('.chart-overlay .chart-crosshair')).toHaveAttribute('data-date', '2024-03-01');
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    release();
    await context.close();
  }
});
