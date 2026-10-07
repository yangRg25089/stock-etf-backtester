import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup: render } = require('react-dom/server');
const { resolveAppearance, effectiveAppearance } = require('../.test-output/shared/ui/themes.js');
const { ThemeControl } = require('../.test-output/shared/ui/ThemeControl.js');
const { TradingCostsPanel } = require('../.test-output/features/results/TradingCostsPanel.js');
const { TradeTable } = require('../.test-output/features/results/TradeTable.js');
const { ResultStrategyDetails } = require('../.test-output/features/results/ResultStrategyDetails.js');
const costs = { commission:'0', slippageCost:'0', spreadCost:'0', capitalGainsTax:'0', totalTradingCost:'0' };
test('new appearance preferences ignore legacy palettes and resolve system independently', () => {
  assert.equal(resolveAppearance('midnight'), 'system');
  assert.equal(resolveAppearance('dark'), 'dark');
  assert.equal(effectiveAppearance('system', true), 'dark');
  assert.equal(effectiveAppearance('light', true), 'light');
});
test('appearance follows the system implicitly and offers only one manual theme toggle', () => {
  const html = render(React.createElement(ThemeControl, { locale: 'en' }));
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.match(html, /appearance-toggle/);
  assert.doesNotMatch(html, />Auto</);
});
test('complete zero costs disappear but unknown and nonzero saved costs stay visible', () => {
  assert.equal(render(React.createElement(TradingCostsPanel, {locale:'zh', costs})), '');
  assert.match(render(React.createElement(TradingCostsPanel, {locale:'zh'})), /未保存/);
  assert.match(render(React.createElement(TradingCostsPanel, {locale:'zh', costs:{...costs, commission:'1', totalTradingCost:'1'}})), /交易成本/);
});
test('trade table merges reason and signal, saves a seventh post-fill asset column and side identity', () => {
  const html = render(React.createElement(TradeTable, {locale:'zh',status:'completed',trades:[{date:'2024-01-02',side:'buy',reason:'signal_buy',quantity:'1',price:'10',cashAmount:'10',currency:'USD',signalId:'rsi.buy',totalAssetAfter:'42'}]}));
  assert.match(html,/原因／信号/); assert.match(html,/总资产/); assert.match(html,/is-buy/);
  assert.match(html,/\$42/); assert.match(html,/RSI 买入信号/);
  assert.equal((html.match(/scope="col"/g)||[]).length,7);
});
test('details contain no tabs, identity is compact and trades are the final detail section', () => {
  const result = {id:'one',role:'strategy',presetId:'monthly_dca',status:'completed',trades:[],dailyAssets:[],metrics:null};
  const html=render(React.createElement(ResultStrategyDetails,{locale:'zh',run:{result:{strategyRuns:[result]}},focusedResult:result}));
  assert.doesNotMatch(html,/role="tab|result-tabs|result-detail-target-label/);
  assert.ok(html.indexOf('result-panel-performance') < html.indexOf('result-panel-trades'));
});

const { MonthlyHeatmap }=require('../.test-output/features/results/MonthlyHeatmap.js');
const { hasTaxColumn }=require('../.test-output/features/results/comparisonModel.js');
test('monthly and annual intensity use fixed scales; zero stays neutral',()=>{
 const values=[.005,.03,.09,.5,0].map((v,i)=>({year:2024,month:i+1,navReturn:String(v),startDate:'2024-01-01',endDate:'2024-01-31'}));
 const html=render(React.createElement(MonthlyHeatmap,{locale:'en',values,annualValues:[{...values[0],month:null,navReturn:'.1'}]}));
 for(const value of [.049999999999999996,.3,.8999999999999999,1,0,.25]) assert.ok(html.includes('--return-intensity:'+value));
 assert.match(html,/is-neutral/);
});
test('tax column hides only explicit completed zeros and ignores failed rows',()=>{
 const zero={id:'a',status:'completed',metrics:{tradingCosts:costs}};
 assert.equal(hasTaxColumn([zero,{status:'failed'}]),false);
 assert.equal(hasTaxColumn([zero,{status:'completed',metrics:{}}]),true);
 assert.equal(hasTaxColumn([{...zero,metrics:{tradingCosts:{...costs,capitalGainsTax:'0.01'}}}]),true);
});
