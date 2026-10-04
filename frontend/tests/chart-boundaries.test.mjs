import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);

test("chart composition delegates axes, scale and each plotting panel", () => {
  const root = readFileSync(new URL("../src/features/results/ResultsCharts.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(root, /function (?:ChartAxes|ChartDateAxis|chartScale|IndicatorChart|OverlayChart|HighlightArea)\b/);
  assert.match(root, /<OverlayChart/);
  assert.match(root, /<IndicatorChart/);
  assert.doesNotMatch(root, /className="chart-toolbar"/);
  assert.match(root, /<ChartControls/);
});

test("shared chart coordinates preserve linked geometry and date ticks", () => {
  const { CHART, COMPACT_CHART, chartScale, xPosition, dateTicks, lineCoordinates } = require("../.test-output/features/results/chart/chartScale.js");
  const full = { start: 0, end: 1 };
  assert.equal(xPosition(0, 8, full), CHART.left);
  assert.equal(xPosition(7, 8, full), CHART.width - CHART.right);
  assert.equal(xPosition(0, 1, full), (CHART.left + CHART.width - CHART.right) / 2);
  const dates = Array.from({ length: 20 }, (_, index) => `2024-01-${String(index + 1).padStart(2, "0")}`);
  assert.equal(dateTicks(dates, full).length, 7);
  assert.deepEqual(dateTicks([], full), []);
  for (const viewport of [full, { start: 0.2, end: 0.8 }]) {
    for (const tick of dateTicks(dates, viewport)) assert.ok(tick.x >= CHART.left && tick.x <= CHART.width - CHART.right);
  }
  const scale = chartScale([10, 20]);
  assert.equal(scale.minimum, 9.2);
  assert.equal(scale.maximum, 20.8);
  assert.equal(scale.y(scale.maximum), CHART.top);
  assert.equal(scale.y(scale.minimum), CHART.height - CHART.bottom);
  const compact = chartScale([-0.3, 0], { maximumAtZero: true }, COMPACT_CHART);
  assert.equal(compact.maximum, 0);
  assert.equal(compact.y(0), COMPACT_CHART.top);
  assert.equal(compact.y(compact.minimum), COMPACT_CHART.height - COMPACT_CHART.bottom);
  const fixed = chartScale([30, 50], { fixedBounds: [0, 100] }, COMPACT_CHART);
  assert.equal(fixed.minimum, 0);
  assert.equal(fixed.maximum, 100);
  const samples = [{ date: dates[0], index: 0, value: 10 }];
  assert.deepEqual(lineCoordinates(samples, scale, dates.length, full), [{ ...samples[0], x: CHART.left, y: scale.y(10) }]);
});

test("one saved series model aligns comparisons and preserves the principal denominator", () => {
  const { buildChartSeriesModel } = require("../.test-output/features/results/chart/chartSeriesModel.js");
  const assets = [
    { date: "2024-01-02", simulationPrice: "10", totalAsset: "100", totalContributed: "100", drawdown: "0" },
    { date: "2024-01-03", simulationPrice: "12", totalAsset: "220", totalContributed: "200", drawdown: "-0.1" },
    { date: "2024-01-04", simulationPrice: "15", totalAsset: "250", totalContributed: "200", drawdown: "0" },
  ];
  const trades = [{ date: "2024-01-03", side: "buy" }];
  const comparison = { id: "comparison", label: "定投", color: "#123456", trades,
    dailyAssets: [{ ...assets[1], totalAsset: "210" }, { ...assets[2], totalAsset: "240" }] };
  const model = buildChartSeriesModel(assets, [], [comparison]);
  assert.deepEqual(model.normalizedById.get("price").points.map(point => point.indexValue), [100, 120, 150]);
  assert.deepEqual(model.normalizedById.get("totalAsset").points.map(point => point.indexValue), [100, 110.00000000000001, 125]);
  assert.equal(model.comparisonAvailable, true);
  const aligned = model.comparisonNormalized[0];
  assert.equal(aligned.id, comparison.id);
  assert.equal(aligned.dailyAssets, comparison.dailyAssets);
  assert.equal(aligned.trades, trades);
  assert.deepEqual(aligned.result.points.map(point => [point.index, point.indexValue]), [[1, 105], [2, 120]]);
  const noOverlap = buildChartSeriesModel(assets, [], [{ ...comparison, dailyAssets: [{ ...assets[0], date: "2023-12-01" }] }]);
  assert.equal(noOverlap.comparisonAvailable, true);
  assert.deepEqual(noOverlap.comparisonNormalized, []);
  const unavailable = buildChartSeriesModel(assets, [], [{ ...comparison, dailyAssets: [{ ...assets[0], totalContributed: "0" }] }]);
  assert.equal(unavailable.comparisonAvailable, false);
  assert.deepEqual(unavailable.comparisonNormalized, []);
});
