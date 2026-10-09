import { expect, test } from '@playwright/test';
import { savedRun, openSaved, pngDownload } from './helpers/reports.mjs';

async function checkFixedColumn(table) {
  await table.scrollIntoViewIfNeeded();
  await table.evaluate(t => {
    const scroll = t.closest('.table-expanded-overflow,.data-table-scroll,.comparison-table-scroll');
    // Force overflow also for short neighborhood tables to exercise the shared rule.
    t.style.minWidth = `${Math.max(t.scrollWidth, scroll.clientWidth + 400)}px`;
    scroll.scrollLeft = 0;
  });
  const initial = await table.evaluate(t => ({
    head: t.tHead.rows[0].cells[0].getBoundingClientRect().x,
    body: t.tBodies[0].rows[0].cells[0].getBoundingClientRect().x,
    other: t.tHead.rows[0].cells[1].getBoundingClientRect().x,
    inset: (() => { const s = t.closest('.table-expanded-overflow,.data-table-scroll,.comparison-table-scroll'); return s.getBoundingClientRect().left + s.clientLeft; })(),
  }));
  await table.evaluate(t => { const s = t.closest('.table-expanded-overflow,.data-table-scroll,.comparison-table-scroll'); s.scrollLeft = 120; });
  const shifted = await table.evaluate(t => ({
    head: t.tHead.rows[0].cells[0].getBoundingClientRect().x,
    body: t.tBodies[0].rows[0].cells[0].getBoundingClientRect().x,
    other: t.tHead.rows[0].cells[1].getBoundingClientRect().x,
  }));
  expect(Math.abs(initial.head - shifted.head)).toBeLessThan(1);
  expect(Math.abs(initial.body - shifted.body)).toBeLessThan(1);
  expect(Math.abs(shifted.head - shifted.body)).toBeLessThan(1);
  expect(Math.abs(initial.head - initial.inset)).toBeLessThan(1);
  expect(initial.other - shifted.other, await table.evaluate(t => JSON.stringify({class:t.className,parent:t.parentElement.className,scroll:t.closest('.table-expanded-overflow,.data-table-scroll,.comparison-table-scroll').scrollLeft,width:t.scrollWidth}))).toBeGreaterThan(100);
}

test('phone stacks settings/results, uses narrow menus and collapses all downloads', async ({page}) => {
  await openSaved(page, await savedRun(page));
  for (const width of [320,375,390,767]) {
    await page.setViewportSize({width,height:900});
    await expect(page.locator('.workbench-mobile-views')).toHaveCount(0);
    await expect(page.locator('.workbench-config')).toBeVisible();
    await expect(page.locator('.workbench-results')).toBeVisible();
    const config=await page.locator('.workbench-config').boundingBox(), result=await page.locator('.workbench-results').boundingBox();
    expect(result.y).toBeGreaterThanOrEqual(config.y+config.height);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const cell=await page.locator('.comparison-table thead th').first().boundingBox();
    expect(cell.width).toBeLessThanOrEqual(144);
    await page.locator('.topbar-menu-toggle').click();
    expect((await page.locator('.topbar-functions').boundingBox()).width).toBeLessThanOrEqual(260);
    await page.keyboard.press('Escape');
    const toggle=page.locator('.result-downloads-toggle');
    await toggle.click();
    await expect(page.locator('.result-downloads-panel .button')).toHaveCount(5);
    for (const button of await page.locator('.result-downloads-panel .button').all()) {
      await expect(button).toBeVisible();
      expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press('Escape');
    await expect(toggle).toBeFocused();
    await expect(page.locator('[data-report-kind=png]')).toBeHidden();
  }
  await page.locator('.result-downloads-toggle').click();
  const waiting=page.waitForEvent('download');
  await page.locator('[data-export-kind=summary]').click();
  expect((await waiting).suggestedFilename()).toMatch(/\.csv$/);
  await pngDownload(page,'phone-report.png');
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:900});
  await page.screenshot({path:test.info().outputPath('phone-390.png'),fullPage:true});
});

test('PNG omits disabled/default/technical information and follows selected core curves', async ({page}) => {
  const saved=await savedRun(page);
  await openSaved(page,saved);
  await page.locator('.comparison-table tr[data-result-id=report-strategy] .result-select').click();
  await pngDownload(page,'primary-only.png');
  let text=await page.evaluate(()=>window.reportAudit.text.join('\n'));
  expect(text).not.toContain('Run:'); expect(text).not.toContain('Data:');
  expect(text).not.toContain(saved.snapshot.engineVersion);
  expect(text).not.toContain('已停用'); expect(text).not.toContain('無効');
  expect(text).not.toContain('約定');
  const primary=saved.result.strategyRuns[0];
  const paths = await page.evaluate(() => window.reportAudit.paths);
  const pricePath = paths.find(path => path.color === '#9c4b0d' && path.points.length === primary.dailyAssets.length);
  const assetPath = paths.find(path => path.color === '#30497d' && path.dash.length && path.points.length === primary.dailyAssets.length);
  expect(pricePath).toBeDefined(); expect(assetPath).toBeDefined();
  expect(assetPath.points.map(point => point.x)).toEqual(pricePath.points.map(point => point.x));
  expect(text).not.toContain('毎月定額積立');
  await page.locator(`.comparison-table tr[data-result-id="${saved.result.strategyRuns.find(row=>row.role==='benchmark' && row.presetId==='monthly_dca').id}"] .result-select`).click();
  await page.locator('.selected-strategy-chip').filter({hasText:'ボラティリティ'}).click();
  await page.evaluate(()=>{window.reportAudit.text=[];});
  await pngDownload(page,'two-selected.png');
  text=await page.evaluate(()=>window.reportAudit.text.join('\n'));
  expect(text).toContain('毎月定額積立');
  expect(text).not.toContain('一括投資');
  await expect(page.locator('.result-detail-name')).toHaveText('ボラティリティ積立');
  expect(primary.dailyAssets.length).toBeGreaterThan(1);
});

test('all seven table types fix matching first-column headings on phone and desktop', async ({page}) => {
  const saved=await savedRun(page,'grid_search',{
    'search.dimensions':['vix.buyThreshold','accumulation.cashSafetyLimit'],
    'search.values.vix.buyThreshold':[20,30], 'search.values.accumulation.cashSafetyLimit':[100,200],
  },rules=>rules.buy.children.forEach(node=>{if(node.kind!=='vix')node.enabled=false;}));
  // A deterministic display episode exercises the sticky date column in a zero-drawdown fixture.
  saved.result.strategyRuns[0].metrics.analysis.drawdownEpisodes=[{peakDate:'2024-02-01',bottomDate:'2024-02-05',recoveredDate:null,endDate:'2024-03-01',drawdown:'-0.05',durationDays:29,recoveryDays:null,state:'ongoing'}];
  await openSaved(page,saved);
  if (!(await page.locator('.result-search-section').evaluate(node=>node.open))) await page.locator('.result-search-section > summary').click();
  await page.locator('.search-lab > summary').click();
  for (const width of [1440,375]) {
    await page.setViewportSize({width,height:900});
    for (const selector of ['.comparison-table','.trade-table','.heatmap-table','.drawdown-episodes-table','.search-table','.search-heatmap-table']) {
      const table=page.locator(selector); await expect(table).toBeVisible();
      await test.step(`${width} ${selector}`, () => checkFixedColumn(table));
      const region=table.locator('xpath=ancestor::*[contains(@class,"table-height-region") or contains(@class,"performance-group")][1]');
      const expand=region.locator('.table-expand-button');
      if (await expand.count()) { await expand.click(); await checkFixedColumn(table); await expand.click(); }
    }
    await page.locator('.search-lab-views button').last().click();
    await checkFixedColumn(page.locator('.search-neighbor-table'));
    await page.locator('.search-lab-views button').first().click();
  }
});

test('strategy readouts keep one vertical column at every screen size', async ({page}) => {
  const saved = await savedRun(page);
  const primary = saved.result.strategyRuns[0];
  for (let index = 0; index < 7; index++) {
    const extra = structuredClone(primary); extra.id = `long-strategy-${index}`;
    extra.instanceNumber = index + 2;
    saved.result.strategyRuns.push(extra);
    saved.snapshot.config.strategies.push({...structuredClone(saved.snapshot.config.strategies[0]), id: extra.id, instanceNumber: extra.instanceNumber});
  }
  saved.selectedStrategyIds = saved.snapshot.config.strategies.map(row => row.id);
  if (saved.progress) Object.assign(saved.progress, {totalStrategies: 10, completedStrategies: 10});
  await openSaved(page,saved);
  for(const button of await page.locator('.comparison-table .result-select').all()) await button.click();
  for(const width of [320,768,1440,1920]) {
    await page.setViewportSize({width,height:1080});
    const boxes=await page.locator('.chart-strategy-readout').evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y,bottom:n.getBoundingClientRect().bottom})));
    expect(boxes).toHaveLength(10);
    for(let i=1;i<boxes.length;i++) { expect(Math.abs(boxes[i].x-boxes[0].x)).toBeLessThan(1); expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i-1].bottom); }
  }
});

test('maintained visual reference stacks panels and folds downloads on phone', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width:375,height:900});
  await page.goto('/e2e/fixtures/workbench-reference.html');
  const toggle = page.locator('.prototype-downloads-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator('#prototype-downloads-panel')).toBeVisible();
  await expect(page.locator('#prototype-downloads-panel button')).toHaveCount(5);
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(page.locator('#prototype-downloads-panel')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  expect(errors).toEqual([]);
});
