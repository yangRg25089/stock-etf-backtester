import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { RunApiError } = require("../.test-output/api/runs.js");
const { ExportControls } = require("../.test-output/features/results/ExportControls.js");
const { isExportAvailable } = require("../.test-output/features/results/exportModel.js");
const { ResultViewer } = require("../.test-output/features/results/ResultViewer.js");
const { savedChartParameters, selectedVolatilitySeries } = require("../.test-output/features/results/model.js");
const { createInitialWorkspaceState } = require("../.test-output/features/strategies/model.js");
const catalog = JSON.parse(readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"));
const resultViewerSource = readFileSync(new URL("../src/features/results/ResultViewer.tsx", import.meta.url), "utf8");

function metrics(endingEquity) {
  return {
    actualInvested: "80.00",
    investmentBasis: "original_principal",
    totalContributed: "100.00",
    endingEquity,
    netProfit: String(Number(endingEquity) - 100),
    returnOnContributions: "0.2",
    capitalMultiple: "1.2",
    xirr: "0.1",
    maximumDrawdown: "-0.05",

    currency: "USD",
    diagnostics: [],
  };
}

function trade(signalId, date) {
  return {
    date,
    side: "buy",
    reason: "signal_buy",
    quantity: "1",
    price: "10",
    cashAmount: "10",
    currency: "USD",
    signalId,
  };
}

function workspaceWithRun() {
  const initial = createInitialWorkspaceState(catalog);
  const savedRunSettings = {
    ...initial.draft.shared.run,
    symbol: "QQQ",
    startDate: "2020-01-01",
    endDate: "2024-02-02",
    endMode: "fixed",
  };
  initial.draft.shared.run = structuredClone(savedRunSettings);
  const primaryId = initial.draft.strategies[0].id;
  const primary = {
    id: primaryId,
    presetId: "vix_dca",
    role: "strategy",
    status: "completed",
    metrics: metrics("125.00"),
    dailyAssets: [
      { date: "2024-01-02", simulationPrice: "100", currency: "USD", totalAsset: "100", drawdown: "0" },
      { date: "2024-01-03", simulationPrice: "112", currency: "USD", totalAsset: "125", drawdown: "-0.01" },
    ],
    signals: [
      { date: "2024-01-02", signalId: "vix.buy", state: "false", observedValue: "18.2" },
      { date: "2024-01-03", signalId: "vix.buy", state: "true", observedValue: "27.4" },
    ],
    trades: [trade("ma.trend", "2024-01-03")],
    diagnostics: [],
  };
  const benchmark = {
    id: "benchmark-dca",
    presetId: "monthly_dca",
    role: "benchmark",
    status: "completed",
    metrics: metrics("130.00"),
    dailyAssets: [
      { date: "2024-02-01", simulationPrice: "100", currency: "USD", totalAsset: "110", unitNav: "1", totalContributed: "100", drawdown: "0" },
      { date: "2024-02-02", simulationPrice: "105", currency: "USD", totalAsset: "130", unitNav: "1.1", totalContributed: "100", drawdown: "-0.02" },
    ],
    trades: [trade("vix.buy", "2024-02-02")],
    diagnostics: [],
  };
  const run = {
    runId: "saved-run",
    status: "completed",
    selectedStrategyIds: [primaryId],
    snapshot: {
      runId: "saved-run",
      config: {
        shared: {
          ...structuredClone(initial.draft.shared),
          run: savedRunSettings,
        },
        strategies: structuredClone(initial.draft.strategies),
      },
    },
    result: { runId: "saved-run", strategyRuns: [primary, benchmark] },
  };
  return {
    ...initial,
    runResponse: run,
    focusedResultId: benchmark.id,
  };
}

test("VIX chart settings come from the frozen condition, not flat params or edited draft", () => {
  const state = workspaceWithRun();
  const saved = state.runResponse.snapshot.config.strategies[0];
  saved.params["vix.symbol"] = "^VIX";
  saved.params["vix.buyThreshold"] = 25;
  saved.rules = { buy: { type: "condition", id: "nasdaq", kind: "vix", enabled: true, params: { "vix.symbol": "^VXN", "vix.buyThreshold": 40 } }, sell: null };
  state.focusedResultId = saved.id;
  state.selectedResultIds = [saved.id];
  state.showChart = true;
  const primary = state.runResponse.result.strategyRuns[0];
  primary.signals = primary.dailyAssets.map(asset => ({ date: asset.date, signalId: "vix.buy:nasdaq", conditionKind: "vix", sourceSymbol: "^VXN", observedUnit: "index_points", state: "true", observedValue: "46" }));
  state.draft.strategies[0].params["vix.buyThreshold"] = 90;
  const html = renderToStaticMarkup(React.createElement(ResultViewer, { locale: "zh", state, dispatch() {}, error: null }));
  assert.match(html, /VXN/);
  assert.match(html, /<strong>46<\/strong>/);
  assert.match(html, /chart-threshold-line/);
  assert.doesNotMatch(html, /90\.00/);
});

test("selected indices retain separate natural units and suppress conflicting thresholds", () => {
  const state = workspaceWithRun();
  const run = state.runResponse;
  const primary = run.result.strategyRuns[0];
  primary.signals = [{ date:"2024-01-02", signalId:"vix.buy", conditionKind:"vix", sourceSymbol:"^VIX", observedUnit:"index_points", observedValue:"27" }];
  run.snapshot.config.strategies[0].params["vix.buyThreshold"] = 25;
  const make = (id, symbol, threshold, value) => {
    run.snapshot.config.strategies.push({ id, presetId:"composite_dca", params:{ "vix.symbol":symbol, "vix.buyThreshold":threshold } });
    return { ...primary, id, signals:[{ ...primary.signals[0], sourceSymbol:symbol, observedValue:value }] };
  };
  const nasdaq = make("nasdaq", "^VXN", 40, "46");
  const dow = make("dow", "^VXD", 30, "35");
  const different = make("different", "^VIX", 35, "27");
  const empty = make("empty", "^VXN", 80, "");
  const results = [primary, nasdaq, dow, different, empty];
  const indices = selectedVolatilitySeries(run, results, results.map(result => result.id));
  assert.deepEqual(indices.map(index => [index.symbol, index.threshold]), [["^VIX", undefined], ["^VXN", "40"], ["^VXD", "30"]]);
  assert.deepEqual(indices.map(index => index.signals.map(signal => signal.observedValue)), [["27", "27"], ["46"], ["35"]]);
  assert.deepEqual(selectedVolatilitySeries(run, results, [nasdaq.id]).map(index => index.symbol), ["^VXN"]);
  assert.deepEqual(selectedVolatilitySeries(run, results, []), []);
});

test("grid curves retain the frozen volatility symbol and override only searched values", () => {
  const state = workspaceWithRun();
  const frozen = state.runResponse.snapshot.config.strategies[0];
  frozen.rules = { buy: { type: "condition", id: "dow", kind: "vix", enabled: true, params: { "vix.symbol": "^VXD", "vix.buyThreshold": 37 } }, sell: null };
  const grid = state.runResponse.result.strategyRuns[0];
  grid.searchResult = {
    dimensions: [{ key: "vix.buyThreshold" }],
    rankedCandidateIds: ["best", "other"],
    candidates: [
      { candidateId: "best", parameterValues: { "vix.symbol": "^VIX", "vix.buyThreshold": "28" } },
      { candidateId: "other", parameterValues: { "vix.symbol": "^VIX", "vix.buyThreshold": "35" } },
    ],
  };
  assert.deepEqual(savedChartParameters(state.runResponse, grid), { "vix.symbol": "^VXD", "vix.buyThreshold": "28" });
  assert.deepEqual(savedChartParameters(state.runResponse, { id: "other" }, grid), { "vix.symbol": "^VXD", "vix.buyThreshold": "35" });
});

test("legacy execution areas never return at any run lifecycle stage", () => {
  for (const status of ["queued", "loading", "running", "completed", "completed_with_warning", "unavailable", "failed", "cancelled"]) {
    const state = workspaceWithRun();
    state.runResponse.status = status;
    state.runResponse.result.strategyRuns[0].status = status;
    const html = renderToStaticMarkup(React.createElement(ResultViewer, {
      locale: "zh", state, dispatch() {}, error: null,
    }));
    assert.doesNotMatch(html, /run-status-panel|run-status-heading|run-strategy-details|run-strategy-statuses|class="run-id"|progress-copy/, status);
    assert.match(html, /class="comparison-table"/, status);
    assert.match(html, /data-export-kind="summary"/, status);
  }
});

test("KPI, chart, trades, and exports use the focused saved result, not the active editor", () => {
  const state = workspaceWithRun();
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state,
    dispatch() {},
  }));

  assert.match(html, /class="result-detail-name"[^>]*>\s*每月定额定投/);
  assert.match(html, /波动率买入信号/);
  assert.doesNotMatch(html, /移動平均トレンド/);
  assert.match(html, /2024-02-02/);
  assert.match(html, /data-export-kind="summary"/);
  assert.match(html, /class="collapsible-panel-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="result-details-content"/);
  assert.match(html, /id="result-details-content" class="collapsible-panel-body"/);
});

test("result details leads with one complete comparison table and no duplicate KPI cards", () => {
  const state = workspaceWithRun();
  state.showChart = true;
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state,
    dispatch() {},
  }));

  const detailsPosition = html.indexOf('id="result-details"');
  const metricsPosition = html.indexOf('id="result-panel-comparison"');
  const chartPosition = html.indexOf('id="result-chart-panel"');
  assert.ok(detailsPosition >= 0 && detailsPosition < chartPosition);
  assert.ok(metricsPosition > detailsPosition && metricsPosition < chartPosition);
  assert.ok(chartPosition >= 0);
  assert.doesNotMatch(html, /class="run-status-panel/);
  assert.doesNotMatch(html, /results\.detailsEntry/);
  assert.doesNotMatch(html, /result-snapshot-info|QQQ · 2020-01-01 — 2024-02-02/);
  assert.doesNotMatch(html, /class="result-run-id"/);
  assert.match(html, /class="result-detail-name"[^>]*>\s*每月定额定投/);
  assert.match(html, /aria-controls="result-chart-panel-content"[^>]*aria-expanded="true"|aria-expanded="true"[^>]*aria-controls="result-chart-panel-content"/);
  assert.match(html, /class="result-detail-name"[^>]*>\s*每月定额定投/);
  assert.match(html, /data-export-kind="summary"/);
  assert.equal((html.match(/class="metric-card"/g) ?? []).length, 0);
  assert.match(html, /已投入本金/);
  assert.match(html, /期末资产/);
  assert.match(html, /投入回报率/);
  assert.match(html, /年化回报/);
  assert.match(html, /最大回撤/);
});

test("selecting another result does not hide volatility from a selected saved strategy", () => {
  const state = workspaceWithRun();
  const [volatility, other] = state.runResponse.result.strategyRuns;
  other.dailyAssets = volatility.dailyAssets.map(asset => ({ ...asset, totalContributed: "100" }));
  volatility.dailyAssets = other.dailyAssets.map(asset => ({ ...asset }));
  state.selectedResultIds = [volatility.id, other.id];
  state.focusedResultId = other.id;
  const html = renderToStaticMarkup(React.createElement(ResultViewer, { locale: "zh", state, dispatch() {} }));
  assert.match(html, /class="chart-panel chart-vix is-compact"/);
  assert.match(html, /波动率信号定投/);
  assert.match(html, /每月定额定投.*USD/);
});

test("selected curves honor deselection, share row colors, and exclude failed saved values", () => {
  const state = workspaceWithRun();
  state.showChart = true;
  const [primary, benchmark] = state.runResponse.result.strategyRuns;
  benchmark.dailyAssets = primary.dailyAssets.map((asset, index) => ({ ...asset, totalAsset: String(110 + index * 15), totalContributed: "100" }));
  primary.dailyAssets.forEach(asset => { asset.totalContributed = "100"; });
  state.focusedResultId = primary.id;
  state.selectedResultIds = [benchmark.id];
  const render = () => renderToStaticMarkup(React.createElement(ResultViewer, { locale: "zh", state, dispatch() {}, error: null }));
  const selected = render();
  assert.doesNotMatch(selected, /class="overlay-series overlay-totalAsset"/);
  assert.match(selected, /data-result-id="benchmark-dca"/);
  const color = selected.match(/class="comparison-overlay-series-line[^\"]*"[^>]*stroke="([^\"]+)"/)[1];
  assert.ok(selected.includes(`--result-color:${color}`));
  state.selectedResultIds = [];
  assert.doesNotMatch(render(), /comparison-overlay-series|class="overlay-series overlay-totalAsset"/);
  assert.match(render(), /class="overlay-series overlay-price"/);
  benchmark.status = "failed";
  state.selectedResultIds = [benchmark.id];
  assert.doesNotMatch(render(), /comparison-overlay-series/);
});

test("saved warning diagnostics stay visible outside the collapsible details body", () => {
  const state = workspaceWithRun();
  state.runResponse.status = "completed_with_warning";
  state.runResponse.result.strategyRuns[0].diagnostics = [{ code: "required_data_unavailable", severity: "warning", messageKey: "diagnostics.data.required_unavailable" }];
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state,
    dispatch() {},
  }));
  const detailsPosition = html.indexOf('id="result-details"');
  const alwaysVisiblePosition = html.indexOf('class="collapsible-panel-always-visible"');
  const runStatusPosition = html.indexOf('class="diagnostic-list"');
  const detailsBodyPosition = html.indexOf('id="result-details-content"');
  const metricsPosition = html.indexOf('id="result-panel-comparison"');
  assert.ok(detailsPosition >= 0 && detailsPosition < runStatusPosition);
  assert.ok(alwaysVisiblePosition < runStatusPosition && runStatusPosition < detailsBodyPosition);
  assert.ok(runStatusPosition < metricsPosition);
  assert.doesNotMatch(html, /run-status-panel|run-strategy-details/);
  assert.match(html, /此策略所需的数据不可用/);
});

test("request and partial failures stay visible while draft edits do not add result warnings", () => {
  const emptyState = createInitialWorkspaceState(catalog);
  const requestError = new RunApiError("provider_request_failed", "api.errors.connection_failed", [], 503);
  const requestFailureHtml = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state: emptyState,
    dispatch() {},
    error: requestError,
  }));
  assert.ok(requestFailureHtml.indexOf('id="result-details"') < requestFailureHtml.indexOf('class="field-error"'));
  assert.match(requestFailureHtml, /无法连接到 API/);

  const partialState = workspaceWithRun();
  partialState.runResponse.status = "completed_with_warning";
  const failedResult = partialState.runResponse.result.strategyRuns[0];
  failedResult.status = "failed";
  failedResult.diagnostics = [{
    code: "calculation_failed",
    severity: "error",
    messageKey: "diagnostics.calculation_failed",
    details: { stage: "strategy", strategyId: failedResult.id, runId: partialState.runResponse.runId },
  }];
  failedResult.metrics.diagnostics = structuredClone(failedResult.diagnostics);
  const partialHtml = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state: partialState,
    dispatch() {},
  }));
  assert.ok(partialHtml.indexOf('id="result-details"') < partialHtml.indexOf('class="diagnostic-list"'));
  assert.ok(partialHtml.indexOf('class="diagnostic-list"') < partialHtml.indexOf('id="result-details-content"'));
  assert.doesNotMatch(partialHtml, /run-status-panel|run-strategy-statuses|部分策略已完成/);
  assert.doesNotMatch(partialHtml, /status-tag/);
  assert.match(partialHtml, />—<\/td>/);
  assert.match(partialHtml, /计算过程中发生错误/);
  assert.equal((partialHtml.match(/计算过程中发生错误/g) ?? []).length, 1);
  assert.equal((partialHtml.match(/class="metric-card"/g) ?? []).length, 0);
  assert.match(partialHtml, /class="comparison-table"/);

  const staleState = workspaceWithRun();
  staleState.draft.shared.run.symbol = "SPY";
  const staleHtml = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state: staleState,
    dispatch() {},
  }));
  assert.doesNotMatch(staleHtml, /当前设置与保存此结果时不同|snapshot-warning/);
  assert.doesNotMatch(staleHtml, /result-snapshot-info|QQQ · 2020-01-01 — 2024-02-02/);
});

test("comparison remains primary, direct performance precedes trades and search is conditional", () => {
  const state = workspaceWithRun();
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "ja",
    state,
    dispatch() {},
  }));
  assert.doesNotMatch(html, /role="tablist"|role="tab"|role="tabpanel"/);
  assert.match(html, /id="result-details"[^>]*tabindex="-1"/);
  assert.match(html, /id="result-strategy-details"[^>]*tabindex="-1"/);
  assert.ok(resultViewerSource.includes('key={`run-results:${run?.runId ?? "empty"}`}'));
  assert.ok(resultViewerSource.includes('key={`strategy-details:${run.runId}`}'));
  const summaryCardStart = html.indexOf('id="result-details"');
  const comparisonStart = html.indexOf('id="result-panel-comparison"');
  const detailCardStart = html.indexOf('id="result-strategy-details"');
  const detailTargetStart = html.indexOf('class="result-detail-target"');
  const tabsStart = html.indexOf('id="result-panel-performance"');
  assert.ok(summaryCardStart < comparisonStart && comparisonStart < detailCardStart && detailCardStart < detailTargetStart && detailTargetStart < tabsStart);
  assert.doesNotMatch(html.slice(summaryCardStart, detailCardStart), /id="result-tab-details"/);
  assert.doesNotMatch(html.slice(detailCardStart), /id="result-panel-comparison"/);
  assert.doesNotMatch(html, /id="result-tab-comparison"|role="tab"[^>]*>戦略比較/);
  assert.ok(html.indexOf('id="result-panel-performance"') < html.indexOf('id="result-panel-trades"'));
  assert.match(html, /id="result-panel-trades"/);
  assert.match(html, /id="result-panel-performance"/);
  assert.doesNotMatch(html, /id="result-panel-(?:trades|performance)"[^>]*hidden/);
  assert.doesNotMatch(html, /role="tab"[^>]*>検索結果/);
  assert.match(html, /class="result-detail-target"[^>]*aria-label="明細対象"/);
  assert.match(html, /class="result-detail-name"[^>]*>毎月定額積立/);
  assert.doesNotMatch(html, /result-panel-metrics|result-panel-overview/);
  assert.match(html, /損益/);
  assert.doesNotMatch(html, /CSV 出力<\/button>/);

  const result = state.runResponse.result.strategyRuns.find((item) => item.id === state.focusedResultId);
  result.presetId = "grid_search";
  result.searchResult = {
    strategyId: result.id,
    dimensions: [],
    totalCandidateCount: 0,
    candidates: [],
    rankedCandidateIds: [],
  };
  const searchHtml = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "ja",
    state,
    dispatch() {},
  }));
  assert.match(searchHtml, /result-search-section/);
});

test("detail focus has no last-click comparison-row treatment or chart selection", () => {
  const state = workspaceWithRun();
  state.selectedResultIds = [];
  state.focusedResultId = "benchmark-dca";
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "ja", state, dispatch() {},
  }));
  const focusedRow = html.match(/<tr(?=[^>]*data-result-id="benchmark-dca")[^>]*>[\s\S]*?<\/tr>/)?.[0];
  assert.ok(focusedRow, "detail result row remains available in the comparison table");
  assert.doesNotMatch(focusedRow, /is-selected|is-focused|aria-current/);
  assert.match(focusedRow, /aria-pressed="false"/);
});

test("comparison navigation uses one named scroll region without a duplicate outer landmark", () => {
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "ja", state: workspaceWithRun(), dispatch() {},
  }));
  assert.doesNotMatch(html, /<section[^>]*id="result-panel-comparison"[^>]*aria-labelledby=/);
  assert.match(html, /role="region" aria-label="実行結果の比較"/);
  assert.match(html, /<caption class="sr-only">実行結果の比較<\/caption>/);
});

test("trade tables render directly and remain available independently of chart collapse", () => {
  const state = workspaceWithRun();
  state.showChart = true;
  const chartOnly = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "ja",
    state,
    dispatch() {},
  }));
  assert.match(chartOnly, /<svg /);
  assert.match(chartOnly, /class="data-table trade-table"/);
  assert.match(chartOnly, /id="result-chart-panel-toggle"[^>]*aria-expanded="true"/);
  assert.match(chartOnly, /id="result-chart-panel-heading"[^>]*>.*?<span>資産推移<\/span>/s);
  assert.doesNotMatch(chartOnly, /display-toggle|result-display-heading|trade-display-icon/);
  assert.match(chartOnly, /class="sr-only" id="result-comparison-heading">実行結果の比較/);
  assert.match(chartOnly, /class="result-detail-name"[^>]*>\s*毎月定額積立/);

  state.showChart = false;
  const tradesOnly = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "ja",
    state,
    dispatch() {},
  }));
  assert.match(tradesOnly, /aria-expanded="false"[^>]*aria-controls="result-chart-panel-content"/);
  assert.match(tradesOnly, /id="result-chart-panel-content" class="collapsible-panel-body"[^>]*hidden=""/);
  assert.match(tradesOnly, /class="chart-panel chart-overlay/);
  assert.match(tradesOnly, /class="data-table trade-table"/);
});

test("VIX chart settings come from the focused frozen strategy snapshot", () => {
  const state = workspaceWithRun();
  state.focusedResultId = state.draft.strategies[0].id;
  state.selectedResultIds = [state.focusedResultId];
  state.showChart = true;
  state.draft.strategies[0].params["vix.buyThreshold"] = 99;
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state,
    dispatch() {},
  }));

  assert.match(html, /<button[^>]*chart-series-control[^>]*aria-label="隐藏标的收盘价曲线"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(html, /QQQ · 价格/);
  assert.match(html, /阈值 25/);
  assert.doesNotMatch(html, /阈值 99/);
  assert.match(html, /27\.4/);
});

test("editing shared settings and strategy parameters leaves the complete saved result markup unchanged", () => {
  const state = workspaceWithRun();
  const render = (value) => renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh", state: value, dispatch() {}, error: null,
  }));
  const original = render(state);
  const edited = { ...state, draft: structuredClone(state.draft) };
  edited.draft.shared.run.symbol = "INVALID";
  edited.draft.shared.contribution.amount = "-100";
  edited.draft.strategies[0].params["vix.buyThreshold"] = "-1";
  assert.equal(render(edited), original);
});

test("CSV eligibility includes completed zero-trade results and limits search exports", () => {
  const emptyTradeResult = {
    id: "zero-trade",
    presetId: "vix_dca",
    role: "strategy",
    status: "completed",
    metrics: metrics("100.00"),
    trades: [],
  };
  assert.equal(isExportAvailable(emptyTradeResult, "trades"), true);
  assert.equal(isExportAvailable(emptyTradeResult, "summary"), true);
  assert.equal(isExportAvailable(emptyTradeResult, "search-results"), false);
  const searchResult = {
    ...emptyTradeResult,
    presetId: "grid_search",
    searchResult: {
      strategyId: emptyTradeResult.id,
      dimensions: [],
      totalCandidateCount: 0,
      candidates: [],
      rankedCandidateIds: [],
    },
  };
  assert.equal(isExportAvailable(searchResult, "search-results"), true);

  const html = renderToStaticMarkup(React.createElement(ExportControls, {
    locale: "zh",
    runId: "saved-run",
    result: emptyTradeResult,
  }));
  assert.match(html, /data-export-kind="trades"(?![^>]*disabled)/);
  assert.match(html, /data-export-kind="search-results" disabled/);
  assert.match(html, /role="group" aria-label="导出结果 CSV"/);
});

test("an empty workspace keeps the details card first and every CSV kind visible and disabled", () => {
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state: createInitialWorkspaceState(catalog),
    dispatch() {},
  }));
  assert.ok(html.indexOf('id="result-details"') >= 0);
  assert.match(html, /还没有结果/);
  assert.equal((html.match(/<button[^>]*disabled/g) ?? []).length, 5);
  assert.doesNotMatch(html, /saved-data-button|保存データ|保存行情说明|Saved data/);
  assert.match(html, /data-report-kind="png" disabled/);
  assert.match(html, /data-export-kind="summary" disabled/);
  assert.match(html, /data-export-kind="search-results" disabled/);
});

test("comparison withholds failed metrics without role or status columns", () => {
  const state = workspaceWithRun();
  state.runResponse.status = "completed_with_warning";
  state.runResponse.result.strategyRuns[0].status = "failed";
  const render = () => renderToStaticMarkup(React.createElement(ResultViewer, { locale: "zh", state, dispatch() {}, error: null }));
  const partial = render();
  assert.doesNotMatch(partial, /status-tag/);
  assert.equal((partial.match(/>—(?:<\/span>)?<\/td>/g) ?? []).length, 10);
  assert.doesNotMatch(partial, /run-status-panel|run-strategy-statuses|部分策略已完成/);
  state.runResponse.status = "failed";
  state.runResponse.result.strategyRuns[1].status = "failed";
  const failed = render();
  assert.equal((failed.match(/>—(?:<\/span>)?<\/td>/g) ?? []).length, 16);
  assert.doesNotMatch(failed, /status-tag/);
});

test("clean completion and warnings never add a separate status list or run identity", () => {
  const state = workspaceWithRun();
  for (const status of ["completed", "completed_with_warning"]) {
    state.runResponse.status = status;
    const html = renderToStaticMarkup(React.createElement(ResultViewer, { locale: "zh", state, dispatch() {}, error: null }));
    assert.doesNotMatch(html, /run-status-panel|run-strategy-details|run-strategy-statuses|saved-run/);
    assert.match(html, /class="comparison-table"/);
  }
});

test("pending jobs withhold comparison metrics without a status column or progress panel", () => {
  const state = workspaceWithRun();
  state.runResponse.runId = "pending-run-id";
  state.runResponse.status = "running";
  state.runResponse.progress = { completedStrategies: 0, totalStrategies: 1, currentStrategyId: null };
  state.runResponse.result.strategyRuns.forEach(result => { result.status = "running"; });
  const html = renderToStaticMarkup(React.createElement(ResultViewer, { locale: "ja", state, dispatch() {}, error: null }));
  assert.doesNotMatch(html, /pending-run-id|run-status-panel|progress-copy|run-strategy-details/);
  assert.doesNotMatch(html, /status-tag/);
  assert.equal((html.match(/>—(?:<\/span>)?<\/td>/g) ?? []).length, 16);
});

test("result errors announce one localized reason when the API title duplicates its diagnostic", () => {
  const state = createInitialWorkspaceState(catalog);
  const diagnostic = { code: "calculation_failed", severity: "error", messageKey: "diagnostics.calculation_failed" };
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh", state, dispatch() {},
    error: new RunApiError(diagnostic.code, diagnostic.messageKey, [diagnostic], 500),
  }));
  assert.equal((html.match(/计算过程中发生错误/g) ?? []).length, 1);
  assert.match(html, /<div role="alert"><ul class="diagnostic-list"/);
  assert.doesNotMatch(html, /run-status-panel/);
});

 test("comparison is a primary overview and exports visibly indicate CSV download", () => {
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh", state: workspaceWithRun(), dispatch() {}, error: null,
  }));
  assert.doesNotMatch(html, /result-focus-select|result-panel-overview|result-panel-metrics/);
  assert.doesNotMatch(html, /id="result-tab-comparison"/);
  assert.ok(html.indexOf('id="result-panel-comparison"') < html.indexOf('id="result-panel-performance"'));
  assert.match(html, /汇总.csv/);
  assert.match(html, /class="export-download-icon"/);
});


test("result info and repeated ticker or dates are absent in every saved run state", () => {
  const state = workspaceWithRun();
  for (const status of ["queued", "running", "completed", "completed_with_warning", "unavailable", "failed"]) {
    state.runResponse.status = status;
    const html = renderToStaticMarkup(React.createElement(ResultViewer, { locale: "ja", state, dispatch() {}, error: null }));
    assert.doesNotMatch(html, /result-snapshot-info|保存した設定|result-saved-context|result-saved-range|QQQ · 相対|QQQ · 価格/);
    assert.match(html, /class="result-detail-name"[^>]*>\s*毎月定額積立/);
  }
});
