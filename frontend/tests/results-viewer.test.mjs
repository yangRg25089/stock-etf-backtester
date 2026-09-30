import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { RunApiError } = require("../.test-output/api/runs.js");
const { StatusView } = require("../.test-output/features/runs/StatusView.js");
const statusViewSource = readFileSync(new URL("../src/features/runs/StatusView.tsx", import.meta.url), "utf8");
const { ExportControls } = require("../.test-output/features/results/ExportControls.js");
const { isExportAvailable } = require("../.test-output/features/results/exportModel.js");
const { ResultViewer } = require("../.test-output/features/results/ResultViewer.js");
const { createInitialWorkspaceState } = require("../.test-output/features/strategies/model.js");
const catalog = JSON.parse(readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"));
const resultViewerSource = readFileSync(new URL("../src/features/results/ResultViewer.tsx", import.meta.url), "utf8");

function metrics(endingEquity) {
  return {
    totalContributed: "100.00",
    endingEquity,
    netProfit: String(Number(endingEquity) - 100),
    returnOnContributions: "0.2",
    capitalMultiple: "1.2",
    xirr: "0.1",
    maximumDrawdown: "-0.05",
    relativeToDca: "0.00",
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
      { date: "2024-02-01", simulationPrice: "100", currency: "USD", totalAsset: "110", unitNav: "1", drawdown: "0" },
      { date: "2024-02-02", simulationPrice: "105", currency: "USD", totalAsset: "130", unitNav: "1.1", drawdown: "-0.02" },
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
    runRequestedEndMode: "fixed",
    runRequestedScope: "active",
  };
}

test("KPI, chart, trades, and exports use the focused saved result, not the active editor", () => {
  const state = workspaceWithRun();
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state,
    dispatch() {},
  }));

  assert.match(html, /每月定额定投 · 基准/);
  assert.match(html, /VIX 买入信号/);
  assert.doesNotMatch(html, /移動平均トレンド/);
  assert.match(html, /2024-02-02/);
  assert.match(html, /data-export-kind="summary"/);
  assert.match(html, /class="collapsible-panel-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="result-details-content"/);
  assert.match(html, /id="result-details-content" class="collapsible-panel-body"/);
});

test("the result details card leads, clean success status is omitted, and overview holds five core KPIs", () => {
  const state = workspaceWithRun();
  state.showChart = true;
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state,
    dispatch() {},
  }));

  const detailsPosition = html.indexOf('id="result-details"');
  const metricsPosition = html.indexOf('id="result-panel-overview"');
  const chartPosition = html.indexOf('id="result-chart-panel"');
  assert.ok(detailsPosition >= 0 && detailsPosition < chartPosition);
  assert.ok(metricsPosition > detailsPosition && metricsPosition < chartPosition);
  assert.ok(chartPosition >= 0);
  assert.doesNotMatch(html, /class="run-status-panel/);
  assert.doesNotMatch(html, /results\.detailsEntry/);
  assert.match(html, /QQQ · 2020-01-01 — 2024-02-02/);
  assert.match(html, /<code class="result-run-id">saved-run<\/code>/);
  assert.match(html, /aria-label="查看结果"/);
  assert.match(html, /aria-controls="result-chart-panel-content"[^>]*aria-expanded="true"|aria-expanded="true"[^>]*aria-controls="result-chart-panel-content"/);
  assert.match(html, /value="benchmark-dca"/);
  assert.match(html, /data-export-kind="summary"/);
  const overviewMetrics = html.slice(metricsPosition, html.indexOf('id="result-panel-comparison"'));
  assert.equal((overviewMetrics.match(/class="metric-card"/g) ?? []).length, 5);
  assert.match(overviewMetrics, /实际投入金额/);
  assert.match(html, /期末资产/);
  assert.match(html, /投入回报率/);
  assert.match(html, /年化回报/);
  assert.match(html, /最大回撤/);
});

test("warning status and diagnostics stay inside the result details card", () => {
  const state = workspaceWithRun();
  state.runResponse.status = "completed_with_warning";
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state,
    dispatch() {},
  }));
  const detailsPosition = html.indexOf('id="result-details"');
  const alwaysVisiblePosition = html.indexOf('class="collapsible-panel-always-visible"');
  const runStatusPosition = html.indexOf('class="run-status-panel"');
  const detailsBodyPosition = html.indexOf('id="result-details-content"');
  const metricsPosition = html.indexOf('id="result-panel-overview"');
  assert.ok(detailsPosition >= 0 && detailsPosition < runStatusPosition);
  assert.ok(alwaysVisiblePosition < runStatusPosition && runStatusPosition < detailsBodyPosition);
  assert.ok(runStatusPosition < metricsPosition);
  assert.doesNotMatch(html, /class="run-status-panel is-compact"/);
});

test("request failures, partial failures, and stale-snapshot notices stay with the saved result context", () => {
  const emptyState = createInitialWorkspaceState(catalog);
  const requestError = new RunApiError("provider_request_failed", "api.errors.connection_failed", [], 503);
  const requestFailureHtml = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state: emptyState,
    dispatch() {},
    error: requestError,
  }));
  assert.ok(requestFailureHtml.indexOf('id="result-details"') < requestFailureHtml.indexOf('class="catalog-error"'));
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
  assert.ok(partialHtml.indexOf('id="result-details"') < partialHtml.indexOf('class="run-status-panel"'));
  assert.ok(partialHtml.indexOf('class="run-status-panel"') < partialHtml.indexOf('id="result-details-content"'));
  assert.match(partialHtml, /部分策略已完成/);
  assert.match(partialHtml, /计算过程中发生错误/);
  assert.equal((partialHtml.match(/计算过程中发生错误/g) ?? []).length, 1);
  assert.equal((partialHtml.match(/class="metric-card"/g) ?? []).length, 8);

  const staleState = workspaceWithRun();
  staleState.draft.shared.run.symbol = "SPY";
  const staleHtml = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state: staleState,
    dispatch() {},
  }));
  assert.match(staleHtml, /当前设置与保存此结果时不同/);
  assert.ok(staleHtml.indexOf('class="result-saved-context"') < staleHtml.indexOf('class="snapshot-warning"'));
  assert.match(staleHtml, /QQQ · 2020-01-01 — 2024-02-02/);
});

test("saved result details default to overview, keep other metrics separate, and gate search by result data", () => {
  const state = workspaceWithRun();
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "ja",
    state,
    dispatch() {},
  }));
  assert.match(html, /role="tablist" aria-label="実行結果"/);
  assert.match(html, /id="result-details"[^>]*tabindex="-1"/);
  assert.ok(resultViewerSource.includes('key={run?.runId ?? "no-run"}'));
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>概要/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>戦略比較/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>取引明細/);
  assert.doesNotMatch(html, /role="tab"[^>]*>検索結果/);
  const metricsPosition = html.indexOf('id="result-panel-metrics"');
  const metricsEnd = html.indexOf("</section></div>", metricsPosition);
  const additionalMetrics = html.slice(metricsPosition, metricsEnd);
  assert.equal((additionalMetrics.match(/class="metric-card"/g) ?? []).length, 3);
  assert.doesNotMatch(additionalMetrics, /実際の投入額|期末資産|投入額に対する利益率|年率リターン|最大ドローダウン/);
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
  assert.match(searchHtml, /role="tab"[^>]*>検索結果/);
});

test("chart and trade display controls are independent and chart legend remains a separate control", () => {
  const state = workspaceWithRun();
  state.showChart = true;
  state.showTrades = false;
  const chartOnly = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "ja",
    state,
    dispatch() {},
  }));
  assert.match(chartOnly, /<svg /);
  assert.doesNotMatch(chartOnly, /class="data-table trade-table"/);
  assert.match(chartOnly, /id="result-chart-panel-toggle"[^>]*aria-expanded="true"/);
  assert.match(chartOnly, /id="result-chart-panel-heading"[^>]*>.*?<span>資産推移<\/span>/s);
  assert.match(chartOnly, /class="display-toggle icon-only-button"[^>]*aria-pressed="false"[^>]*aria-label="取引明細を表示"/);
  assert.match(chartOnly, /<svg class="trade-display-icon"/);
  assert.match(chartOnly, /class="sr-only" id="result-comparison-heading">実行結果の比較/);
  assert.match(chartOnly, /class="sr-only" id="result-trades-heading">取引明細/);

  state.showChart = false;
  state.showTrades = true;
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
  state.showChart = true;
  state.draft.strategies[0].params["vix.buyThreshold"] = 99;
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state,
    dispatch() {},
  }));

  assert.match(html, /QQQ · 价格/);
  assert.match(html, /阈值 25/);
  assert.doesNotMatch(html, /阈值 99/);
  assert.match(html, /27\.4/);
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
  assert.equal((html.match(/<button[^>]*disabled/g) ?? []).length, 4);
  assert.match(html, /data-export-kind="summary" disabled/);
  assert.match(html, /data-export-kind="search-results" disabled/);
});

test("result statuses distinguish partial success, full failure, and completed empty trades", () => {
  const partialHtml = renderToStaticMarkup(React.createElement(StatusView, {
    locale: "zh",
    error: null,
    run: {
      runId: "partial-run",
      status: "completed_with_warning",
      selectedStrategyIds: ["good", "bad"],
      snapshot: { runId: "partial-run", config: {} },
      result: { runId: "partial-run", strategyRuns: [
        { id: "good", presetId: "vix_dca", role: "strategy", status: "completed" },
        { id: "bad", presetId: "composite_dca", role: "strategy", status: "failed" },
      ] },
    },
  }));
  assert.match(partialHtml, /部分策略已完成/);

  const failedHtml = renderToStaticMarkup(React.createElement(StatusView, {
    locale: "zh",
    error: null,
    run: {
      runId: "failed-run",
      status: "failed",
      selectedStrategyIds: ["bad"],
      snapshot: { runId: "failed-run", config: {} },
      result: { runId: "failed-run", strategyRuns: [
        { id: "bad", presetId: "vix_dca", role: "strategy", status: "failed" },
      ] },
    },
  }));
  assert.match(failedHtml, /失败/);
  assert.doesNotMatch(failedHtml, /部分策略已完成/);
});

test("clean completed runs collapse duplicate per-strategy statuses while warnings stay expanded", () => {
  const run = {
    runId: "clean-run",
    status: "completed",
    selectedStrategyIds: ["one", "two"],
    snapshot: { runId: "clean-run", config: {} },
    result: { runId: "clean-run", strategyRuns: [
      { id: "one", presetId: "vix_dca", role: "strategy", status: "completed" },
      { id: "two", presetId: "monthly_dca", role: "benchmark", status: "completed" },
    ] },
  };
  const cleanHtml = renderToStaticMarkup(React.createElement(StatusView, {
    locale: "zh",
    error: null,
    run,
  }));
  assert.match(cleanHtml, /<details class="run-strategy-details">/);
  assert.match(cleanHtml, /<summary>已运行策略与基准（2 项）<\/summary>/);
  assert.match(cleanHtml, /clean-run/);
  assert.match(cleanHtml, /two/);
  assert.match(cleanHtml, /每月定额定投/);

  run.status = "completed_with_warning";
  const warningHtml = renderToStaticMarkup(React.createElement(StatusView, {
    locale: "zh",
    error: null,
    run,
  }));
  assert.match(warningHtml, /<details class="run-strategy-details" open="">/);
  assert.match(warningHtml, /已完成，有警告/);
});

test("running jobs keep the run ID visible before strategy results exist", () => {
  const html = renderToStaticMarkup(React.createElement(StatusView, {
    locale: "ja",
    error: null,
    run: {
      runId: "pending-run-id",
      status: "running",
      selectedStrategyIds: ["strategy-one"],
      progress: { completedStrategies: 0, totalStrategies: 1, currentStrategyId: null },
      snapshot: { runId: "pending-run-id", config: {} },
      result: { runId: "pending-run-id", strategyRuns: [] },
    },
  }));
  assert.match(html, /<p class="run-id">pending-run-id<\/p>/);
  assert.doesNotMatch(html, /class="run-strategy-details"/);
});

test("strategy status details reset their expanded state for each saved run", () => {
  assert.ok(statusViewSource.includes('<details className="run-strategy-details" key={run?.runId ?? "no-run"} open={expandStrategyDetails}>'));
});
