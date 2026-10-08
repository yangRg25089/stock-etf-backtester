import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const assets = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"].map((date, index) => ({ date,
  currency: "USD", simulationPrice: String(100 + index * 10), totalAsset: "100", totalContributed: "100", drawdown: "0" }));
const ma = { kind: "ma", period: 200, samples: assets.map((asset, index) => ({ date: asset.date, value: index === 1 ? null : String(90 + index * 10) })) };

test("saved technical values deduplicate equal parameters and samples while preserving different periods", () => {
  const { savedTechnicalIndicators, technicalChartLines } = require("../.test-output/features/results/technicalIndicators.js");
  const series = savedTechnicalIndicators([{ technicalIndicators: [ma] }, { technicalIndicators: [structuredClone(ma), { ...ma, period: 50 }] }, {}]);
  assert.equal(series.length, 2);
  const lines = technicalChartLines(series, assets, "zh");
  assert.deepEqual(lines.map(line => line.label), ["MA200", "MA50"]);
  assert.notEqual(lines[0].color, lines[1].color);
  assert.equal(technicalChartLines(series.slice(1), assets, "zh")[0].id, lines[1].id,
    "deselecting an unrelated indicator must retain the remaining legend identity");
  assert.deepEqual(lines[0].samples.map(sample => [sample.index, sample.value]), [[0, 90], [2, 110], [3, 120]]);
});

test("technical gaps break lines and never interpolate unavailable warmup", () => {
  const { chartSegments } = require("../.test-output/features/results/technicalIndicators.js");
  assert.deepEqual(chartSegments([{ index: 0 }, { index: 2 }, { index: 3 }]).map(segment => segment.map(point => point.index)), [[0], [2, 3]]);
  assert.deepEqual(chartSegments([]), []);
});

test("MA and Bollinger use the saved price baseline and indicators appear in permanent readings", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { ResultsCharts } = require("../.test-output/features/results/ResultsCharts.js");
  const band = { kind: "bollinger", period: 20, deviations: "2", samples: assets.map(asset => ({ date: asset.date, value: "110", upper: "150", lower: "70" })) };
  const strength = { kind: "rsi", period: 14, samples: assets.map(asset => ({ date: asset.date, value: "60" })) };
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, { locale: "zh", dailyAssets: assets,
    trades: [], signals: [], technicalIndicators: [ma, band, strength], visibleSeriesIds: ["price", "totalAsset"], onSeriesChange() {} }));
  assert.match(html, /MA200/);
  assert.match(html, /BOLL\(20, 2σ\)/);
  assert.match(html, /RSI14/);
  assert.match(html, /MA200<\/span> <strong>120\.00 USD/);
  assert.match(html, /data-kind="ma"[^>]*data-baseline="100"/);
  assert.match(html, /data-kind="bollinger"[^>]*data-baseline="100"/);
  assert.match(html, /chart-panel chart-rsi is-compact/);
  assert.equal((html.match(/chart-x-axis-title/g) ?? []).length, 1);
  const withoutPrice = renderToStaticMarkup(React.createElement(ResultsCharts, { locale: "zh", dailyAssets: assets,
    trades: [], signals: [], technicalIndicators: [ma], visibleSeriesIds: ["totalAsset"], onSeriesChange() {} }));
  assert.match(withoutPrice, /class="chart-technical-line"/);
});

for (const kind of ["ma", "rsi"]) test(`long saved histories with many ${kind.toUpperCase()} periods do not overflow chart aggregation`, () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { ResultsCharts } = require("../.test-output/features/results/ResultsCharts.js");
  const history = Array.from({ length: 9000 }, (_, index) => ({ ...assets[0],
    date: new Date(Date.UTC(1990, 0, index + 1)).toISOString().slice(0, 10),
    simulationPrice: String(100 + index % 20) }));
  const samples = history.map(asset => ({ date: asset.date, value: kind === "rsi" ? "50" : asset.simulationPrice }));
  const indicators = Array.from({ length: 18 }, (_, index) => ({ kind, period: index + 2, samples }));
  const html = renderToStaticMarkup(React.createElement(ResultsCharts, { locale: "zh", dailyAssets: history,
    trades: [], signals: [], technicalIndicators: indicators, visibleSeriesIds: ["price", "totalAsset"], onSeriesChange() {} }));
  assert.doesNotMatch(html, /\b(?:NaN|Infinity)\b/);
  assert.equal((html.match(kind === "ma" ? /class="chart-technical-line"/g : /class="chart-series-line"/g) ?? []).length, 18);
});
