import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { ResultsCharts } = require("../.test-output/features/results/ResultsCharts.js");
const { TradeTable } = require("../.test-output/features/results/TradeTable.js");

const dailyAssets = [
  { date: "2024-01-02", simulationOpen: "98", simulationHigh: "110", simulationLow: "95", simulationPrice: "100", currency: "USD", totalAsset: "100", drawdown: "0" },
  { date: "2024-01-03", simulationOpen: "100", simulationHigh: "116", simulationLow: "99", simulationPrice: "112", currency: "USD", totalAsset: "112", drawdown: "-0.05" },
  { date: "2024-01-04", simulationOpen: "112", simulationHigh: "114", simulationLow: "101", simulationPrice: "104", currency: "USD", totalAsset: "104", drawdown: "-0.12" },
];
const trades = [
  {
    date: "2024-01-03",
    side: "buy",
    reason: "signal_buy",
    quantity: "0.125",
    price: "100.25",
    cashAmount: "12.53125",
    currency: "USD",
    signalId: "vix.buy",
  },
  {
    date: "2024-01-04",
    side: "sell",
    reason: "signal_sell",
    quantity: "0.05",
    price: "104",
    cashAmount: "5.2",
    currency: "USD",
    signalId: "exit.vix",
  },
];

test("asset and drawdown charts use saved daily assets and mark saved trades", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "ja",
    dailyAssets,
    trades,
    visibleSeriesIds: ["totalAsset", "drawdown"],
    onSeriesChange() {},
  }));

  assert.equal((html.match(/<svg /g) ?? []).length, 3);
  assert.equal((html.match(/<polyline /g) ?? []).length, 2);
  assert.equal((html.match(/class="trade-marker /g) ?? []).length, 2);
  assert.equal((html.match(/class="candlestick candlestick-/g) ?? []).length, 3);
  assert.ok((html.match(/class="chart-gridline/g) ?? []).length >= 12);
  assert.match(html, /chart-axis-title/);
  assert.match(html, /価格 \(USD\)/);
  assert.match(html, /総資産/);
  assert.match(html, /ドローダウン/);
});

test("older result snapshots without OHLC render a close-price line instead of candles", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "ja",
    dailyAssets: dailyAssets.map(({ date, simulationPrice, currency, totalAsset, drawdown }) => ({
      date, simulationPrice, currency, totalAsset, drawdown,
    })),
    trades,
    visibleSeriesIds: ["totalAsset"],
    onSeriesChange() {},
  }));

  assert.match(html, /price-close-line/);
  assert.doesNotMatch(html, /class="candlestick candlestick-/);
});

test("total-asset chart keeps its currency axis at zero or above", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "ja",
    dailyAssets: dailyAssets.map((asset, index) => ({
      ...asset,
      totalAsset: index === 0 ? "0" : asset.totalAsset,
    })),
    trades: [],
    visibleSeriesIds: ["totalAsset"],
    onSeriesChange() {},
  }));
  const assetChart = html.match(/<figure class="chart-panel chart-totalAsset">([\s\S]*?)<\/figure>/)?.[1] ?? "";
  const yTickLabels = [...assetChart.matchAll(/class="chart-tick-label chart-y-tick"[^>]*>(.*?)<\/text>/g)]
    .map((match) => match[1] ?? "");

  assert.ok(yTickLabels.length > 0);
  assert.ok(yTickLabels.every((label) => !label.includes("-") && !label.includes("−")));
});

test("chart legend only changes visible chart series", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh",
    dailyAssets,
    trades,
    visibleSeriesIds: ["totalAsset"],
    onSeriesChange() {},
  }));
  assert.equal((html.match(/<svg /g) ?? []).length, 2);
  assert.match(html, /aria-pressed="false"><span/);
  assert.ok(html.includes("</span>回撤 (%)</button>"));
});

test("VIX chart uses saved observed signal values and frozen threshold", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh",
    dailyAssets,
    trades,
    signals: [
      { date: "2024-01-02", signalId: "vix.buy", state: "false", observedValue: "18.2" },
      { date: "2024-01-03", signalId: "vix.buy", state: "true", observedValue: "27.4" },
      { date: "2024-01-04", signalId: "vix.buy", state: "false", observedValue: "20.1" },
    ],
    vixSymbol: "^VIX",
    vixThreshold: "25",
    visibleSeriesIds: ["totalAsset", "drawdown"],
    onSeriesChange() {},
  }));
  assert.match(html, /VIX 指数/);
  assert.match(html, /25/);
  assert.match(html, /27\.4/);
  assert.match(html, /chart-threshold-line/);
});

test("VIX exit-only observations do not show the buy threshold", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh",
    dailyAssets,
    trades: [],
    signals: [
      { date: "2024-01-02", signalId: "vix.exit.low1", state: "false", observedValue: "18.2" },
      { date: "2024-01-03", signalId: "vix.exit.low1", state: "false", observedValue: "27.4" },
    ],
    vixSymbol: "^VIX",
    vixThreshold: "25",
    visibleSeriesIds: ["totalAsset"],
    onSeriesChange() {},
  }));

  assert.match(html, /27\.4/);
  assert.doesNotMatch(html, /chart-threshold-line/);
  assert.doesNotMatch(html, /阈值 25/);
});

test("successful zero-trade results keep an empty transaction table exportable", () => {
  const html = renderToStaticMarkup(React.createElement(TradeTable, {
    locale: "ja",
    status: "completed",
    trades: [],
  }));
  assert.match(html, /<table class="data-table trade-table">/);
  assert.match(html, /日付/);
  assert.match(html, /取引はありません/);
});

test("trade details show execution fields and do not call failed results zero-trade successes", () => {
  const html = renderToStaticMarkup(React.createElement(TradeTable, {
    locale: "zh",
    status: "completed_with_warning",
    trades,
  }));
  assert.match(html, /2024-01-03/);
  assert.match(html, /买入/);
  assert.match(html, /卖出/);
  assert.match(html, /vix\.buy/);
  const failed = renderToStaticMarkup(React.createElement(TradeTable, {
    locale: "zh",
    status: "unavailable",
    trades: [],
  }));
  assert.doesNotMatch(failed, /还没有交易/);
  assert.match(failed, /交易明细不可用/);
});
