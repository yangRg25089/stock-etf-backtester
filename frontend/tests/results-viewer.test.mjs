import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
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
    trades: [trade("active-vix-trade", "2024-01-03")],
    diagnostics: [],
  };
  const benchmark = {
    id: "benchmark-dca",
    presetId: "monthly_dca",
    role: "benchmark",
    status: "completed",
    metrics: metrics("130.00"),
    dailyAssets: [
      { date: "2024-02-01", totalAsset: "110", drawdown: "0" },
      { date: "2024-02-02", totalAsset: "130", drawdown: "-0.02" },
    ],
    trades: [trade("focused-benchmark-trade", "2024-02-02")],
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
          run: { ...initial.draft.shared.run, symbol: "QQQ" },
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

  assert.match(html, /当前结果：每月定额定投/);
  assert.match(html, /focused-benchmark-trade/);
  assert.doesNotMatch(html, /active-vix-trade/);
  assert.match(html, /2024-02-02/);
  assert.match(html, /data-export-kind="summary"/);
});

test("the result overview leads with four core KPIs and the main chart before comparison details", () => {
  const state = workspaceWithRun();
  state.showChart = true;
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state,
    dispatch() {},
  }));

  const metricsPosition = html.indexOf('id="focused-metrics-heading"');
  const chartPosition = html.indexOf("<svg ");
  const comparisonPosition = html.indexOf('id="result-comparison-heading"');
  assert.ok(metricsPosition >= 0 && metricsPosition < chartPosition);
  assert.ok(chartPosition >= 0 && chartPosition < comparisonPosition);
  const overviewMetrics = html.slice(metricsPosition, chartPosition);
  assert.equal((overviewMetrics.match(/class="metric-card"/g) ?? []).length, 4);
  assert.match(html, /期末资产/);
  assert.match(html, /投入回报率/);
  assert.match(html, /年化回报/);
  assert.match(html, /最大回撤/);
});

test("saved result details have accessible tabs with comparison selected first and search gated by result data", () => {
  const state = workspaceWithRun();
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "ja",
    state,
    dispatch() {},
  }));
  assert.match(html, /role="tablist" aria-label="結果詳細"/);
  assert.match(html, /id="result-details"[^>]*tabindex="-1"/);
  assert.ok(resultViewerSource.includes('key={`${run.runId}:${focusedResult?.id ?? "no-focused-result"}`}'));
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>戦略比較/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>取引明細/);
  assert.doesNotMatch(html, /role="tab"[^>]*>検索結果/);

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
  assert.match(chartOnly, /aria-pressed="true">資産チャートを表示/);
  assert.match(chartOnly, /aria-pressed="false">取引明細を表示/);

  state.showChart = false;
  state.showTrades = true;
  const tradesOnly = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "ja",
    state,
    dispatch() {},
  }));
  assert.doesNotMatch(tradesOnly, /<svg /);
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

  const html = renderToStaticMarkup(React.createElement(ExportControls, {
    locale: "zh",
    runId: "saved-run",
    result: emptyTradeResult,
  }));
  assert.match(html, /data-export-kind="trades"(?![^>]*disabled)/);
  assert.match(html, /data-export-kind="search-results" disabled/);
  assert.match(html, /role="group" aria-label="导出结果 CSV"/);
});

test("an empty workspace keeps every CSV kind visible and disabled", () => {
  const html = renderToStaticMarkup(React.createElement(ResultViewer, {
    locale: "zh",
    state: createInitialWorkspaceState(catalog),
    dispatch() {},
  }));
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
