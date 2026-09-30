import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { ResultsCharts } = require("../.test-output/features/results/ResultsCharts.js");
const { TradeTable } = require("../.test-output/features/results/TradeTable.js");

const dailyAssets = [
  { date: "2024-01-02", simulationOpen: "98", simulationHigh: "110", simulationLow: "95", simulationPrice: "100", currency: "USD", totalAsset: "100", unitNav: "1", drawdown: "0" },
  { date: "2024-01-03", simulationOpen: "100", simulationHigh: "116", simulationLow: "99", simulationPrice: "112", currency: "USD", totalAsset: "112", unitNav: "1.12", drawdown: "-0.05" },
  { date: "2024-01-04", simulationOpen: "112", simulationHigh: "114", simulationLow: "101", simulationPrice: "104", currency: "USD", totalAsset: "104", unitNav: "1.04", drawdown: "-0.12" },
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

test("all financial charts use readable lines and saved results mark trades", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "ja",
    dailyAssets,
    trades,
    assetSymbol: "QQQ",
    visibleSeriesIds: ["price", "totalAsset", "drawdown", "vix"],
    onSeriesChange() {},
  }));

  assert.equal((html.match(/class="result-chart"/g) ?? []).length, 2);
  assert.equal((html.match(/<polyline /g) ?? []).length, 3);
  assert.equal((html.match(/class="price-trade-marker /g) ?? []).length, 2);
  assert.equal((html.match(/class="candlestick candlestick-/g) ?? []).length, 0);
  assert.match(html, /class="overlay-series overlay-price"/);
  assert.match(html, /class="overlay-series overlay-totalAsset"/);
  assert.match(html, /class="chart-baseline-line"[^>]*data-baseline="100"/);
  assert.ok((html.match(/class="chart-gridline/g) ?? []).length >= 12);
  assert.match(html, /chart-axis-title/);
  assert.match(html, /QQQ · 価格 \(USD\)/);
  assert.match(html, /総資産/);
  assert.match(html, /ドローダウン/);
  assert.match(html, /id="chart-aux-drawdown" class="collapsible-panel chart-aux-panel"/);
  assert.match(html, /aria-expanded="false"[^>]*aria-controls="chart-aux-drawdown-content"/);
  assert.match(html, /id="chart-aux-drawdown-content" class="collapsible-panel-body"[^>]*hidden=""/);
  assert.match(html, /class="chart-panel chart-drawdown/);
});

test("saved snapshots render a close-price trend line without requiring OHLC", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "ja",
    dailyAssets: dailyAssets.map(({ date, simulationPrice, currency, totalAsset, drawdown }) => ({
      date, simulationPrice, currency, totalAsset, drawdown,
    })),
    trades,
    visibleSeriesIds: ["price"],
    onSeriesChange() {},
  }));

  assert.match(html, /overlay-series overlay-price/);
  assert.doesNotMatch(html, /class="candlestick candlestick-/);
  assert.match(html, /<polyline[^>]*tabindex="0"[^>]*aria-label="価格 \(USD\) · 2024-01-04/);
});

test("overlay mode combines selected series on a base-100 index", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh",
    dailyAssets: dailyAssets.map((asset, index) => ({
      ...asset,
      simulationPrice: ["100", "120", "80"][index],
      totalAsset: ["50", "60", "40"][index],
      drawdown: ["0", "-0.2", "-0.1"][index],
    })),
    trades: [],
    signals: [
      { date: "2024-01-02", signalId: "vix.buy", state: "false", observedValue: "20" },
      { date: "2024-01-03", signalId: "vix.buy", state: "false", observedValue: "24" },
      { date: "2024-01-04", signalId: "vix.buy", state: "false", observedValue: "16" },
    ],
    vixSymbol: "^VIX",
    vixThreshold: "25",
    visibleSeriesIds: ["price", "totalAsset", "drawdown", "vix"],
    overlayMode: true,
    onOverlayModeChange() {},
    onSeriesChange() {},
  }));

  assert.equal((html.match(/class="overlay-series-line /g) ?? []).length, 4);
  assert.match(html, /起点 = 100/);
  assert.match(html, /data-baseline="100"/);
  assert.match(html, /class="chart-panel chart-overlay"/);
  assert.doesNotMatch(html, /class="candlestick candlestick-/);
  assert.doesNotMatch(html, /class="chart-panel chart-price"/);
  assert.match(html, /overlay-price/);
  assert.match(html, /overlay-drawdown/);
  assert.match(html, /aria-label="价格 \(USD\) · 2024-01-04 · US\$80/);
});

test("core comparison starts at 100 and keeps original total-asset currency in the legend", () => {
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
  assert.match(html, /chart-y-axis-title/);
  assert.match(html, /chart-baseline-label[^>]*>開始値 100<\/text>/);
  assert.match(html, /総資産 \(USD\)/);
  assert.match(html, /\$104/);
});

test("cash contributions do not flatten the QQQ comparison line", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh",
    dailyAssets: [
      { date: "2024-01-02", simulationPrice: "100", currency: "USD", totalAsset: "100", unitNav: "1" },
      { date: "2024-02-01", simulationPrice: "105", currency: "USD", totalAsset: "5000", unitNav: "1.05" },
      { date: "2024-03-01", simulationPrice: "110", currency: "USD", totalAsset: "10000", unitNav: "1.1" },
    ],
    trades: [],
    assetSymbol: "QQQ",
    visibleSeriesIds: ["price", "totalAsset"],
    onSeriesChange() {},
  }));
  const priceLine = html.match(/class="overlay-series-line overlay-price" points="([^"]+)"/)?.[1];
  assert.ok(priceLine, "expected a QQQ price polyline");
  const yCoordinates = priceLine.split(" ").map((point) => Number(point.split(",")[1]));
  assert.ok(Math.max(...yCoordinates) - Math.min(...yCoordinates) > 20);
  assert.match(html, /10,000/);
});

test("saved results without unit NAV explain why the total-asset relative curve is unavailable", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh",
    dailyAssets: [
      { date: "2024-01-02", simulationPrice: "100", currency: "USD", totalAsset: "100" },
      { date: "2024-02-01", simulationPrice: "105", currency: "USD", totalAsset: "5000" },
    ],
    trades: [],
    visibleSeriesIds: ["price", "totalAsset"],
    onSeriesChange() {},
  }));

  assert.match(html, /此保存结果缺少现金流调整后的净值数据/);
  assert.match(html, /overlay-series-line overlay-price/);
  assert.doesNotMatch(html, /overlay-series-line overlay-totalAsset/);
});

test("indicator overlay is disabled when no auxiliary series is selected", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "ja",
    dailyAssets,
    trades: [],
    visibleSeriesIds: ["price", "totalAsset"],
    onSeriesChange() {},
  }));

  assert.match(html, /aria-pressed="false" disabled="">選択した指標も重ねる<\/button>/);
});

test("chart legend only changes visible chart series", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh",
    dailyAssets,
    trades,
    visibleSeriesIds: ["totalAsset"],
    onSeriesChange() {},
  }));
  assert.equal((html.match(/class="result-chart"/g) ?? []).length, 1);
  assert.match(html, /class="icon-only-button chart-wheel-zoom-toggle"[^>]*aria-pressed="false"/);
  assert.match(html, /aria-pressed="false"><span/);
  assert.ok(html.includes("</span>回撤 (%)</button>"));
  assert.match(html, /aria-label="显示的图表"/);
  assert.match(html, /将其他所选曲线也叠加/);
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
    visibleSeriesIds: ["vix"],
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
    visibleSeriesIds: ["vix"],
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
