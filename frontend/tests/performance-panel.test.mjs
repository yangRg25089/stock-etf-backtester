import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { wireRun, catalog } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { PerformancePanel } = require("../.test-output/features/results/PerformancePanel.js");
const { readPackage, packageDraft } = require("../.test-output/features/files/packageModel.js");
const { createInitialWorkspaceState, serializeDraftForApi } = require("../.test-output/features/strategies/model.js");

test("performance reads saved risk-free and metrics, including exact missing reasons", () => {
  const result = wireRun().result.strategyRuns[0];
  result.metrics.analysis = { analysisMethod: "unit-nav-v1", durationUnit: "calendar_days", riskFreeAnnualRate: "0.05", tradingDaysPerYear: 252,
    annualizedReturn: "0.12", annualizedVolatility: "0.2", sharpeRatio: "0.6", sortinoRatio: null, calmarRatio: "2",
    maximumDrawdownDuration: 42, recoveryDuration: null, buyCount: 3, sellCount: 2, turnover: "1.5", averageCashRatio: "0.25",
    unavailableReasons: { sortinoRatio: "no_downside", recoveryDuration: "not_recovered" } };
  const before = JSON.stringify(result);
  const html = renderToStaticMarkup(React.createElement(PerformancePanel, { locale: "zh", result }));
  assert.match(html, /5%/);
  assert.match(html, /12%/);
  assert.match(html, /150%/);
  assert.match(html, /尚未恢复/);
  assert.match(html, /没有低于无风险利率的收益/);
  assert.equal((html.match(/performance-stat/g) ?? []).length, 11);
  assert.equal(JSON.stringify(result), before);
  delete result.metrics.analysis;
  const legacy = renderToStaticMarkup(React.createElement(PerformancePanel, { locale: "zh", result }));
  assert.match(legacy, /未保存绩效分析/);
  assert.doesNotMatch(legacy, /NaN|Infinity|5%/);
});

test("new analysis inputs serialize separately without changing previous results", () => {
  const state = createInitialWorkspaceState(catalog);
  assert.equal(state.draft.shared.analysis.riskFreeAnnualRatePct, "0");
  state.draft.shared.analysis.riskFreeAnnualRatePct = "5";
  assert.deepEqual(serializeDraftForApi(state.draft).shared.analysis, { riskFreeAnnualRatePct: "5" });
});

test("every saved performance card and calculation basis exposes a localized explanation across the entire card", () => {
  const result = wireRun().result.strategyRuns[0];
  result.metrics.analysis = { riskFreeAnnualRate: "0.05", tradingDaysPerYear: 252,
    annualizedReturn: "0.12", annualizedVolatility: "0.2", sharpeRatio: "0.6", sortinoRatio: null, calmarRatio: "2",
    maximumDrawdownDuration: 42, recoveryDuration: null, buyCount: 3, sellCount: 2, turnover: "1.5", averageCashRatio: "0.25",
    unavailableReasons: { sortinoRatio: "no_downside", recoveryDuration: "not_recovered" } };
  for (const locale of ["ja", "zh", "en"]) {
    const html = renderToStaticMarkup(React.createElement(PerformancePanel, { locale, result }));
    const cards = [...html.matchAll(/<div class="performance-stat"[^>]*>/g)].map(match => match[0]);
    assert.equal(cards.length, 11);
    for (const card of cards) {
      assert.match(card, /tabindex="0"/);
      const description = card.match(/aria-describedby="([^"]+)"/)[1];
      assert.ok(html.includes(`id="${description}"`));
    }
    assert.equal([...html.matchAll(/<span class="performance-help-tooltip" aria-hidden="true">[^<]+<\/span>/g)].length, 12);
    assert.match(html, /class="performance-basis"[^>]*tabindex="0"[^>]*aria-describedby="[^"]+"/);
    assert.match(html, /class="performance-basis"[^>]*>[\s\S]*?class="performance-help-tooltip" aria-hidden="true">[^<]+<\/span>/);
    assert.doesNotMatch(html, /title="performance\.help\./);
  }
});

test("v12 configuration files migrate the new shared default and unknown versions remain rejected", () => {
  const draft = createInitialWorkspaceState(catalog).draft;
  delete draft.shared.analysis;
  const file = { format: "stock-etf-backtester", type: "strategy", schemaVersion: 1, catalogVersion: "catalog-v12",
    exportedAt: "2026-10-04T00:00:00Z", draft };
  const loaded = readPackage(file, catalog);
  assert.equal(packageDraft(loaded, catalog).shared.analysis.riskFreeAnnualRatePct, "0");
  assert.equal(file.draft.shared.analysis, undefined);
  assert.throws(() => readPackage({ ...file, catalogVersion: "catalog-v11" }, catalog), /files.incompatibleCatalog/);
});
