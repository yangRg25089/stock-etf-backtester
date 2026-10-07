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

test("unselected focused assets never return and selected comparison curves remain when price is hidden", () => {
  const render = (comparisonSeries, visibleSeriesIds) => renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh", dailyAssets, trades, signals: [], showFocusedAsset: false, comparisonSeries,
    visibleSeriesIds, onSeriesChange() {},
  }));
  const comparisons = [{ id: "dca", label: "定投", color: "#c47a1f", dailyAssets }];
  const assetOnly = render(comparisons, ["totalAsset"]);
  assert.match(assetOnly, /data-result-id="dca"/);
  assert.doesNotMatch(assetOnly, /class="overlay-series overlay-totalAsset"|class="overlay-series overlay-price"|chart-trade-marker/);
  const none = render([], ["totalAsset"]);
  assert.match(none, /class="overlay-series overlay-price"/);
  assert.doesNotMatch(none, /chart-trade-marker|comparison-overlay-series|class="overlay-series overlay-totalAsset"/);
});

test("shared chart details are visible before interaction and use the last saved day", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "ja", dailyAssets, trades: [], visibleSeriesIds: ["price", "totalAsset", "drawdown", "vix"],
    signals: dailyAssets.map(asset => ({ date: asset.date, signalId: "vix.buy", state: "false", observedValue: "20" })),
    onSeriesChange() {},
  }));
  assert.equal((html.match(/class="chart-crosshair-readout"/g) ?? []).length, 1);
  assert.match(html, /class="chart-crosshair-readout" data-date="2024-01-04"/);
  assert.match(html, /104\.00 USD/);
  assert.match(html, /100\.00 USD/);
  assert.match(html, /ドローダウン/);
  assert.match(html, /VIX/);
  assert.doesNotMatch(html, /class="chart-crosshair"/);
});

test("core series inspection is part of permanent readings with no separate caption or legend", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh", dailyAssets, trades, signals: [], visibleSeriesIds: ["price", "totalAsset"],
    totalAssetResultId: "strategy-a", totalAssetLabel: "策略 A", onSeriesChange() {},
  }));
  const core = html.match(/<figure class="chart-panel chart-overlay"[\s\S]*?<\/figure>/)[0];
  assert.doesNotMatch(core, /<figcaption|overlay-legend/);
  const readout = core.slice(0, core.indexOf('<div class="chart-canvas">'));
  assert.match(readout, /<button[^>]*chart-series-control[^>]*aria-label="标的收盘价 \(USD\)"[^>]*aria-pressed="false"/);
  assert.match(readout, /<button[^>]*chart-strategy-readout[^>]*aria-label="策略 A"[^>]*aria-pressed="false"/);
  assert.match(readout, /104\.00 USD/);
  assert.match(readout, /100\.00 USD/);
});

test("chart readouts separate market data from strategy rows in comparison order", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh", dailyAssets, trades: [], signals: [], visibleSeriesIds: ["price", "totalAsset", "drawdown"],
    totalAssetResultId: "first", totalAssetLabel: "策略甲", strategyOrder: ["second", "first"],
    comparisonSeries: [{ id: "second", label: "策略乙", color: "#395cb7", dailyAssets: dailyAssets.map(asset => ({ ...asset, totalAsset: "140", totalContributed: "120" })) }],
    onSeriesChange() {},
  }));
  const market = html.match(/<div class="chart-market-readout"[^>]*>(.*?)<\/div>/)[1];
  assert.match(market, /标的收盘价/);
  assert.match(market, /回撤/);
  assert.doesNotMatch(market, /策略甲|策略乙|本金/);
  const rows = [...html.matchAll(/<button[^>]*class="[^"]*chart-strategy-readout[^"]*"[^>]*data-result-id="([^"]+)"[^>]*>(.*?)<\/button>/g)];
  assert.deepEqual(rows.map(row => row[1]), ["second", "first"]);
  assert.match(rows[0][2], /140\.00 USD/);
  assert.match(rows[0][2], /120\.00 USD/);
  assert.match(rows[0][2], /116\.7/);
  assert.match(rows[1][2], /104\.00 USD/);
});

test("trades anchor to the contributed-capital asset curve even when price is visible", () => {
  const assets = dailyAssets.map((asset, index) => ({ ...asset, totalAsset: ["100", "198", "203"][index], totalContributed: ["100", "200", "200"][index] }));
  const render = visibleSeriesIds => renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "ja", dailyAssets: assets, trades, signals: [], visibleSeriesIds, onSeriesChange() {},
  }));
  const html = render(["price", "totalAsset"]);
  const assetPoints = html.match(/<polyline class="overlay-series-line overlay-totalAsset[^\"]*" points="([^\"]+)"/)[1].split(" ").map(point => point.split(",").map(Number));
  assert.doesNotMatch(html, /chart-trade-marker/);
  const { tradeMarkerPoints } = require("../.test-output/features/results/chartTradeMarkers.js");
  const markers = tradeMarkerPoints(trades, assets.map((asset, index) => ({ date: asset.date, x: assetPoints[index][0], y: assetPoints[index][1] })))
    .map(marker => marker.coordinates.split(" ")[0].split(",").map(Number));
  assert.equal(markers.length, trades.length);
  for (const [index, [x, y]] of markers.entries()) {
    const curve = assetPoints[index + 1];
    assert.equal(x, curve[0]);
    assert.ok(Math.abs(y - curve[1] - (trades[index].side === "buy" ? 7 : -7)) < 1e-8);
  }
  assert.doesNotMatch(html, /data-anchor-series="totalAsset"/);
  assert.doesNotMatch(render(["price"]), /chart-trade-marker/);
});

test("each selected comparison anchors its own saved trades and identity to its own curve", () => {
  const comparisons = [
    { id: "strategy-a", label: "策略 A", color: "#9360bd", dailyAssets, trades: [trades[0]] },
    { id: "strategy-b", label: "策略 B", color: "#9a541d", dailyAssets: dailyAssets.map(asset => ({ ...asset, totalAsset: String(Number(asset.totalAsset) * 1.2) })), trades: [trades[1]] },
  ];
  const render = (series, ids) => renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh", dailyAssets, trades, signals: [], comparisonSeries: series, showFocusedAsset: false,
    visibleSeriesIds: ids, onSeriesChange() {},
  }));
  const html = render(comparisons, ["price", "totalAsset"]);
  for (const [index, comparison] of comparisons.entries()) {
    const curveGroup = html.match(new RegExp(`<g class="comparison-overlay-series" data-result-id="${comparison.id}"[\\s\\S]*?<\\/g>`))[0];
    const curvePoints = curveGroup.match(/points="([^\"]+)"/)[1].split(" ").map(point => point.split(",").map(Number));
    const { tradeMarkerPoints } = require("../.test-output/features/results/chartTradeMarkers.js");
    const [marker] = tradeMarkerPoints(comparison.trades, comparison.dailyAssets.map((asset, index) => ({ date: asset.date, x: curvePoints[index][0], y: curvePoints[index][1] })));
    const [x, y] = marker.coordinates.split(" ")[0].split(",").map(Number);
    assert.equal(x, curvePoints[index + 1][0]);
    assert.ok(Math.abs(y - curvePoints[index + 1][1] - (comparison.trades[0].side === "buy" ? 7 : -7)) < 1e-8);
    assert.match(curveGroup, new RegExp(`stroke="${comparison.color}"`));

  }
  const onlyA = render(comparisons.slice(0, 1), ["totalAsset"]);
  assert.match(onlyA, /data-result-id="strategy-a"/);
  assert.doesNotMatch(onlyA, /data-result-id="strategy-b"/);
  assert.doesNotMatch(onlyA, /chart-trade-marker/);
  assert.doesNotMatch(render(comparisons, ["price"]), /chart-trade-marker/);
});

test("linked figures have one bottom date axis and no separate-layout controls", () => {
  for (const visibleSeriesIds of [["price"], ["price", "drawdown"], ["price", "vix"], ["price", "drawdown", "vix"]]) {
    const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
      locale: "ja", dailyAssets, trades: [], visibleSeriesIds,
      signals: dailyAssets.map(row => ({ date: row.date, signalId: "vix.buy", state: "false", observedValue: "20" })),
      onSeriesChange() {},
    }));
    assert.equal((html.match(/class="chart-axis-title chart-x-axis-title"/g) ?? []).length, 1);
    assert.equal((html.match(/class="chart-tick-label chart-x-tick"/g) ?? []).length, dailyAssets.length);
    assert.match(html, new RegExp(`data-tick-index="${dailyAssets.length - 1}"[^>]*text-anchor="end"`));
    assert.match(html, /class="chart-linked-stack"/);
    assert.doesNotMatch(html, /chart-layout-controls|chart-aux-panel|分割表示|連動表示/);
    for (const id of visibleSeriesIds.filter(id => id !== "price")) {
      assert.match(html, new RegExp(`data-chart-id="${id}"`));
      assert.match(html, /viewBox="0 0 800 72"/);
    }
  }
});

test("the shared date axis centers a single saved day", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh", dailyAssets: dailyAssets.slice(0, 1), trades: [], visibleSeriesIds: ["price"], onSeriesChange() {},
  }));
  assert.equal((html.match(/class="chart-tick-label chart-x-tick"/g) ?? []).length, 1);
  assert.match(html, /data-tick-index="0"[^>]*text-anchor="middle"/);
});

test("compact indicators retain accessible natural units with measured pixel geometry", () => {
  for (const [locale, pointUnit] of [["ja", "ポイント"], ["zh", "点"]]) {
    const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
      locale, dailyAssets, trades: [], visibleSeriesIds: ["price", "drawdown", "vix"],
      signals: dailyAssets.map(row => ({ date: row.date, signalId: "vix.buy", state: "false", observedValue: "20" })),
      onSeriesChange() {},
    }));
    const indicators = [...html.matchAll(/<figure class="chart-panel chart-(drawdown|vix) is-compact"[\s\S]*?<\/figure>/g)];
    assert.equal(indicators.length, 2);
    for (const [figure, id] of indicators) {
      assert.match(figure, /<text class="chart-axis-title chart-y-axis-title"/);
      assert.match(figure, /linearGradient/);
      assert.doesNotMatch(figure, /<figcaption|overlay-legend/);
      assert.match(figure, /data-plot-top="8" data-plot-bottom="64"/);
      assert.ok(figure.match(/<title[^>]*>[\s\S]*?<\/title>/)[0].includes(id === "vix" ? pointUnit : "%"));
    }
    assert.match(html, /<svg class="chart-date-axis"/);
    assert.equal((html.match(/class="chart-axis-title chart-x-axis-title"/g) ?? []).length, 1);
    for (const figure of html.matchAll(/<figure[\s\S]*?<\/figure>/g)) assert.doesNotMatch(figure[0], /chart-x-axis-title|chart-x-tick/);
  }
});

test("asset-only comparison keeps its curve and hides idle trade markers", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "ja", dailyAssets, trades, signals: [], visibleSeriesIds: ["totalAsset"], onSeriesChange() {},
  }));
  assert.doesNotMatch(html, /data-anchor-series="totalAsset"/);
  assert.match(html, /class="overlay-series overlay-totalAsset"/);
  assert.doesNotMatch(html, /class="overlay-series overlay-price"/);
});

test("all financial charts use readable lines and idle charts hide saved trade markers", () => {
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
  assert.doesNotMatch(html, /chart-trade-marker/);
  assert.equal((html.match(/class="candlestick candlestick-/g) ?? []).length, 0);
  assert.match(html, /class="overlay-series overlay-price"/);
  assert.match(html, /class="overlay-series overlay-totalAsset"/);
  assert.match(html, /class="chart-baseline-line"[^>]*data-baseline="100"/);
  assert.ok((html.match(/class="chart-gridline/g) ?? []).length >= 12);
  assert.match(html, /chart-axis-title/);
  assert.match(html, /class="chart-toolbar">[\s\S]*class="chart-controls"[\s\S]*class="chart-range-controls"/);
  assert.match(html, /表示期間（全図共通）/);
  assert.match(html, /銘柄の終値 \(USD\)/);
  assert.match(html, /総資産/);
  assert.match(html, /ドローダウン/);
  assert.match(html, /class="chart-linked-stack"/);
  assert.doesNotMatch(html, /chart-aux-drawdown|chart-layout-controls/);
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
  assert.match(html, /<polyline[^>]*tabindex="0"[^>]*aria-label="銘柄の終値 \(USD\) · 2024-01-04/);
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
  assert.match(html, /aria-label="标的收盘价 \(USD\) · 2024-01-04 · US\$80/);
});

test("core comparison starts at 100 and keeps the original asset amount and currency in the readout", () => {
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
  assert.match(html, /<strong>104\.00 USD<\/strong>/);
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

test("a core-only chart stays linked without a redundant layout switch", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "ja",
    dailyAssets,
    trades: [],
    visibleSeriesIds: ["price", "totalAsset"],
    onSeriesChange() {},
  }));

  assert.doesNotMatch(html, /chart-layout-controls|連動表示|分割表示/);
  assert.match(html, /class="chart-linked-stack"/);
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
  assert.match(html, /class="chart-linked-stack"/);
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
  assert.match(html, /波动率指数/);
  assert.match(html, /VIX ·/);
  assert.match(html, /25/);
  assert.match(html, /20\.1/);
  assert.match(html, /chart-threshold-line/);
  assert.doesNotMatch(html, /vix-observation|chart-single-point/);
});

test("custom VIX nodes use saved source metadata without mixing other indexes", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh", dailyAssets, trades: [], visibleSeriesIds: ["price", "vix"],
    vixSymbol: "^VXN", vixThreshold: "40", onSeriesChange() {},
    signals: dailyAssets.flatMap(asset => [
      { date: asset.date, signalId: "vix.buy:chosen", conditionKind: "vix", sourceSymbol: "^VXN", observedUnit: "index_points", state: "true", observedValue: "46" },
      { date: asset.date, signalId: "vix.buy:other", conditionKind: "vix", sourceSymbol: "^VIX", observedUnit: "index_points", state: "false", observedValue: "18" },
    ]),
  }));
  assert.match(html, /data-chart-id="vix"/);
  assert.match(html, /<strong>46<\/strong>/);
  assert.match(html, /chart-threshold-line/);
  assert.doesNotMatch(html, /<strong>18<\/strong>/);
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
  assert.match(html, /波动率买入信号/);
  assert.doesNotMatch(html, /vix\.buy/);
  const failed = renderToStaticMarkup(React.createElement(TradeTable, {
    locale: "zh",
    status: "unavailable",
    trades: [],
  }));
  assert.doesNotMatch(failed, /还没有交易/);
  assert.match(failed, /交易明细不可用/);
});

test("trade details translate a condition-specific volatility signal without falling back to a generic label", () => {
  const specific = trades.map(trade => ({ ...trade, signalId: trade.side === "buy" ? "vix.buy:vix25" : trade.signalId }));
  const html = renderToStaticMarkup(React.createElement(TradeTable, { locale: "zh", status: "completed", trades: specific }));
  assert.match(html, /波动率买入信号/);
  assert.doesNotMatch(html, /其他信号/);
});

test("trade columns are sortable while the initial execution order remains unchanged", () => {
  const html = renderToStaticMarkup(React.createElement(TradeTable, { locale: "en", status: "completed", trades }));
  assert.equal((html.match(/class="table-sort"/g) ?? []).length, 7);
  assert.equal((html.match(/aria-sort=/g) ?? []).length, 0);
  assert.ok(html.indexOf("2024-01-03") < html.indexOf("2024-01-04"));
});

test("trade height expansion is disabled for empty trades and while calculations run", () => {
  const render = (trades, busy) => renderToStaticMarkup(React.createElement(TradeTable, { locale: "ja", status: "completed", trades, busy }));
  assert.match(render(trades, false), /table-expand-button[^>]*aria-label="取引明細を全行表示"[^>]*aria-expanded="false"/);
  assert.match(render([], false), /table-expand-button[^>]*disabled=""/);
  assert.match(render(trades, true), /table-expand-button[^>]*disabled=""/);
});

test("comparison curves default to thin strokes and reading controls support keyboard highlight", () => {
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, {
    locale: "zh", dailyAssets, trades: [], visibleSeriesIds: ["price", "totalAsset"], onSeriesChange() {},
  }));
  assert.match(html, /stroke-width="1.2"/);
  assert.match(html, /<button type="button" class="chart-series-control" aria-label="标的收盘价 \(USD\)" aria-pressed="false"/);
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

test("trade marker coordinates keep buy and sell directions and omit unsaved or invalid points", () => {
  const { tradeMarkerPoints } = require("../.test-output/features/results/chartTradeMarkers.js");
  const points = dailyAssets.map((asset, index) => ({ date: asset.date, x: index * 10, y: 100 - index * 5 }));
  const result = tradeMarkerPoints([...trades, { ...trades[0], date: "2023-12-31" }, { ...trades[0], price: "invalid" }], points);
  assert.equal(result.length, 2);
  assert.equal(result[0].coordinates, "10,102 7,91 13,91");
  assert.equal(result[1].coordinates, "20,83 17,94 23,94");
  assert.deepEqual(result.map(item => item.trade.side), ["buy", "sell"]);
});
