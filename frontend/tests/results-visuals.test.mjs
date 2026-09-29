import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { ResultsCharts } = require("../.test-output/features/results/ResultsCharts.js");
const { TradeTable } = require("../.test-output/features/results/TradeTable.js");

const dailyAssets = [
  { date: "2024-01-02", totalAsset: "100", drawdown: "0" },
  { date: "2024-01-03", totalAsset: "112", drawdown: "-0.05" },
  { date: "2024-01-04", totalAsset: "104", drawdown: "-0.12" },
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

  assert.equal((html.match(/<svg /g) ?? []).length, 2);
  assert.equal((html.match(/<polyline /g) ?? []).length, 2);
  assert.equal((html.match(/class="trade-marker /g) ?? []).length, 2);
  assert.match(html, /総資産/);
  assert.match(html, /ドローダウン/);
});

test("chart legend only changes visible chart series", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh",
    dailyAssets,
    trades,
    visibleSeriesIds: ["totalAsset"],
    onSeriesChange() {},
  }));
  assert.equal((html.match(/<svg /g) ?? []).length, 1);
  assert.match(html, /aria-pressed="false"><span/);
  assert.ok(html.includes("</span>回撤</button>"));
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
