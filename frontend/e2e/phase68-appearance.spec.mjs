import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { savedRun, openSaved } from './helpers/reports.mjs';
import { installRunFixture, openTopbarMenu } from './helpers/runtime.mjs';

test('system appearance follows OS until a manual theme is saved; no Auto control is shown', async ({page}) => {
  await page.emulateMedia({colorScheme:'dark'});
  await page.addInitScript(()=>{
    const cleared='stock-etf-backtester.test-appearance-cleared';
    if(!sessionStorage.getItem(cleared)) {
      localStorage.removeItem('stock-etf-backtester.appearance.v2');
      localStorage.setItem('stock-etf-backtester.theme.v1','forest');
      sessionStorage.setItem(cleared,'true');
    }
  });
  const saved=await savedRun(page);
  await openSaved(page,saved);
  await expect(page.locator('html')).toHaveAttribute('data-appearance','system');
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(page.locator('.theme-select')).toHaveCount(0);
  await expect(page.locator('.appearance-controls button')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Follow system appearance'})).toHaveCount(0);
  await page.emulateMedia({colorScheme:'light'});
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await page.locator('.appearance-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect.poll(()=>page.evaluate(()=>localStorage.getItem('stock-etf-backtester.appearance.v2'))).toBe('dark');
  await page.emulateMedia({colorScheme:'light'});
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await installRunFixture(page,saved);
  await page.reload();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  for(const button of await page.locator('.comparison-table .result-select').all()) await button.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  for(const theme of ['dark','light']) {
    if(theme==='light') await page.locator('.appearance-toggle').click();
    for(const width of [320,375,768,1024,1920]) {
      await page.setViewportSize({width,height:1080});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
    }
    await page.screenshot({path:test.info().outputPath(theme+'.png')});
  }
  await openTopbarMenu(page);
  await expect(page.locator('.appearance-controls button')).toHaveCount(1);
  await expect(page.getByText('Auto',{exact:true})).toHaveCount(0);
});

test('direct details end in saved fill assets; zero costs and tax disappear, missing values remain explicit',async({page})=>{
  const saved=await savedRun(page);
  await openSaved(page,saved);
  await expect(page.locator('.result-tabs,[role=tab],[role=tabpanel]')).toHaveCount(0);
  await expect(page.locator('.comparison-table [data-sort-key=capitalGainsTax]')).toHaveCount(0);
  await expect(page.locator('#result-panel-performance .trading-costs-panel')).toHaveCount(0);
  await expect(page.locator('.trade-table thead th')).toHaveCount(7);
  expect(saved.result.strategyRuns[0].trades.length).toBeGreaterThan(0);
  for(const trade of saved.result.strategyRuns[0].trades) expect(Number(trade.totalAssetAfter)).toBeGreaterThanOrEqual(0);
  expect(await page.locator('#result-strategy-details-content > :last-child').getAttribute('id')).toBe('result-panel-trades');
  const unknown=structuredClone(saved);delete unknown.result.strategyRuns[0].metrics.tradingCosts;
  await installRunFixture(page,unknown);await page.reload();
  await expect(page.locator('.comparison-table [data-sort-key=capitalGainsTax]')).toHaveCount(1);
  await expect(page.locator('.comparison-table [aria-label="未保存"]')).toHaveCount(1);
});

test('expanded trade header follows the outer viewport and stays horizontally aligned',async({page})=>{
  const saved=await savedRun(page);const primary=saved.result.strategyRuns[0];
  primary.trades=Array.from({length:80},(_,i)=>({...primary.trades[0],totalAssetAfter:String(100+i)}));
  await openSaved(page,saved);
  for(const width of [1440,375]) {
    await page.setViewportSize({width,height:900});
    const region=page.locator('.trade-table-region');
    await region.locator('.table-expand-button').click();
    await region.locator('tbody tr').nth(35).scrollIntoViewIfNeeded();
    await expect.poll(async()=>{
      const c=await region.locator('.table-height-controls').boundingBox();
      const h=await region.locator('thead').boundingBox();
      return Math.abs(h.y-(c.y+c.height));
    }).toBeLessThan(2);
    await region.locator('.table-expanded-overflow').evaluate(el=>el.scrollLeft=el.scrollWidth-el.clientWidth);
    const aligned=await region.locator('table').evaluate(t=>Array.from(t.tHead.rows[0].cells).map((c,i)=>Math.abs(c.getBoundingClientRect().x-t.tBodies[0].rows[0].cells[i].getBoundingClientRect().x)));
    expect(Math.max(...aligned)).toBeLessThan(1);
    const previousDirection=await region.locator("thead th").last().getAttribute("aria-sort");
    const sortBox=await region.locator('[data-sort-key=totalAssetAfter]').boundingBox();
    expect(sortBox.x).toBeGreaterThanOrEqual(0);
    expect(sortBox.x+sortBox.width).toBeLessThanOrEqual(width);
    await page.mouse.click(sortBox.x+sortBox.width/2,sortBox.y+sortBox.height/2);
    await expect(region.locator('thead th').last()).toHaveAttribute('aria-sort',previousDirection === 'ascending' ? 'descending' : 'ascending');
    await region.locator('.table-expand-button').click();
  }
});

test('1920x1080 keeps main and three auxiliary plots within the results viewport',async({page})=>{
  const saved=await savedRun(page,'composite_dca',{},rules=>{ rules.buy={type:'group',id:'mixed',enabled:true,operator:'AND',children:[rules.buy,{type:'condition',id:'rsi-test',kind:'rsi',enabled:true,params:{'rsi.period':2,'rsi.buyThreshold':100}}]}; });
  await openSaved(page,saved);await page.setViewportSize({width:1920,height:1080});
  await page.locator('.comparison-table tr[data-result-id=report-strategy] .result-select').click();
  await expect(page.locator('.chart-rsi')).toBeVisible();
  for(const collapsed of [false,true]) {
    if(collapsed) await page.locator('.workbench-config-toggle').click();
    await page.locator('#result-chart-panel').evaluate(el=>el.scrollIntoView({block:'start'}));
    const layout=await page.evaluate(()=>{
      const outer=document.querySelector('.workbench-results').getBoundingClientRect();
      const charts=[...document.querySelectorAll('svg.result-chart')].map(x=>x.getBoundingClientRect());
      return {bottom:document.querySelector('.chart-date-axis').getBoundingClientRect().bottom,outerBottom:outer.bottom,heights:charts.map(r=>r.height)};
    });
    expect(layout.heights).toHaveLength(4);
    expect(layout.heights[0]).toBeGreaterThanOrEqual(240);
    for(const height of layout.heights.slice(1)) expect(height).toBeGreaterThanOrEqual(64);
    expect(layout.bottom).toBeLessThanOrEqual(layout.outerBottom+1);
  }
});
