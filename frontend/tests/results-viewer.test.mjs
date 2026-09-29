import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { StatusView } = require("../.test-output/features/runs/StatusView.js");
const { ExportControls } = require("../.test-output/features/results/ExportControls.js");
const { isExportAvailable } = require("../.test-output/features/results/exportModel.js");
const { ResultViewer } = require("../.test-output/features/results/ResultViewer.js");
const { createInitialWorkspaceState } = require("../.test-output/features/strategies/model.js");
const catalog = JSON.parse(readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"));

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
      { date: "2024-01-02", totalAsset: "100", drawdown: "0" },
      { date: "2024-01-03", totalAsset: "125", drawdown: "-0.01" },
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
      config: { shared: initial.draft.shared, strategies: initial.draft.strategies },
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
