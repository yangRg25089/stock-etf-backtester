import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { ResultsCharts } = require("../.test-output/features/results/ResultsCharts.js");
const { TradeTable } = require("../.test-output/features/results/TradeTable.js");

const dailyAssets = [
  { date: "2024-01-02", simulationOpen: "98", simulationHigh: "110", simulationLow: "95", simulationPrice: "100", currency: "USD", totalAsset: "100", unitNav: "1", totalContributed: "100", drawdown: "0" },
  { date: "2024-01-03", simulationOpen: "100", simulationHigh: "116", simulationLow: "99", simulationPrice: "112", currency: "USD", totalAsset: "112", unitNav: "1.12", totalContributed: "100", drawdown: "-0.05" },
  { date: "2024-01-04", simulationOpen: "112", simulationHigh: "114", simulationLow: "101", simulationPrice: "104", currency: "USD", totalAsset: "104", unitNav: "1.04", totalContributed: "100", drawdown: "-0.12" },
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

test("asset-only comparison preserves saved trades on the visible asset curve", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "ja", dailyAssets, trades, signals: [], visibleSeriesIds: ["totalAsset"], onSeriesChange() {},
  }));
  assert.equal((html.match(/data-anchor-series="totalAsset"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /class="overlay-series overlay-price"/);
});

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
  assert.match(html, /class="chart-toolbar">[\s\S]*class="chart-controls"[\s\S]*class="chart-range-controls"/);
  assert.match(html, /表示期間（全図共通）/);
  assert.match(html, /価格 \(USD\)/);
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

test("linked view keeps a core comparison and natural-unit indicators underneath", () => {
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

  assert.equal((html.match(/class="overlay-series-line /g) ?? []).length, 2);
  assert.equal((html.match(/is-compact"/g) ?? []).length, 2);
  assert.match(html, /价格与本金收益/);
  assert.match(html, /data-baseline="100"/);
  assert.match(html, /class="chart-panel chart-overlay"/);
  assert.doesNotMatch(html, /class="candlestick candlestick-/);
  assert.doesNotMatch(html, /class="chart-panel chart-price"/);
  assert.match(html, /overlay-price/);
  assert.match(html, /chart-panel chart-drawdown is-compact/);
  assert.match(html, /chart-panel chart-vix is-compact/);
  assert.doesNotMatch(html, /overlay-drawdown|overlay-vix/);
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
  assert.match(html, /chart-baseline-label[^>]*>基準 100<\/text>/);
  assert.match(html, /総資産 \(USD\)/);
  assert.match(html, /\$104/);
});

test("cash contributions do not flatten the QQQ comparison line", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh",
    dailyAssets: [
      { date: "2024-01-02", simulationPrice: "100", currency: "USD", totalAsset: "100", unitNav: "1" },
      { date: "2024-02-01", simulationPrice: "105", currency: "USD", totalAsset: "5250", totalContributed: "5000", unitNav: "1.05" },
      { date: "2024-03-01", simulationPrice: "110", currency: "USD", totalAsset: "11000", totalContributed: "10000", unitNav: "1.1" },
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
  assert.match(html, /11,000/);
});

test("saved results without contributed principal explain why the asset return curve is unavailable", () => {
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

  assert.match(html, /此保存结果缺少累计本金/);
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

  assert.match(html, /aria-pressed="false" disabled="">連動表示<\/button>/);
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
  assert.match(html, /联动/);
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
  assert.match(html, /VIX 买入信号/);
  assert.doesNotMatch(html, /vix\.buy/);
  const failed = renderToStaticMarkup(React.createElement(TradeTable, {
    locale: "zh",
    status: "unavailable",
    trades: [],
  }));
  assert.doesNotMatch(failed, /还没有交易/);
  assert.match(failed, /交易明细不可用/);
});

test("comparison curves default to thin strokes and legends support keyboard highlight", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh", dailyAssets, trades: [], visibleSeriesIds: ["price", "totalAsset"], onSeriesChange() {},
  }));
  assert.match(html, /stroke-width="1.2"/);
  assert.match(html, /class="overlay-legend-item" role="listitem" tabindex="0"/);
  assert.doesNotMatch(html, /class="chart-highlight-area"/);
});


test("the main chart provides eight numeric ticks and seven date positions", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh",
    dailyAssets: Array.from({ length: 14 }, (_, index) => ({ ...dailyAssets[0], date: `2024-01-${String(index + 2).padStart(2, "0")}` })),
    trades: [], visibleSeriesIds: ["price", "totalAsset"], onSeriesChange() {},
  }));
  assert.equal((html.match(/chart-y-tick/g) ?? []).length, 8);
  assert.equal((html.match(/chart-x-tick/g) ?? []).length, 7);
});

test("hiding price preserves the asset chart and old snapshots cannot hide their last usable core series", () => {
  const render = (assets, ids) => renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh", dailyAssets: assets, trades: [], visibleSeriesIds: ids, onSeriesChange() {},
  }));
  const assetOnly = render(dailyAssets, ["totalAsset", "drawdown"]);
  assert.match(assetOnly, /overlay-series overlay-totalAsset/);
  assert.doesNotMatch(assetOnly, /overlay-series overlay-price/);
  assert.match(assetOnly, /class="chart-toolbar"/);
  const legacy = render(dailyAssets.map(({ totalContributed, ...asset }) => asset), ["price", "totalAsset"]);
  assert.match(legacy, /overlay-series overlay-price/);
  assert.match(legacy, /重新运行/);
  assert.match(legacy, /<button(?=[^>]*aria-pressed="true")(?=[^>]*disabled="")[^>]*>[\s\S]*?价格/);
  assert.doesNotMatch(legacy, /overlay-series overlay-totalAsset/);
});
