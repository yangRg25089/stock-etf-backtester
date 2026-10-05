import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { buildSearchHeatmap, buildSearchNeighborhood, searchMetricValue, searchOutcomeId } = require("../.test-output/features/results/searchLabModel.js");
const { SearchLab } = require("../.test-output/features/results/SearchLab.js");

function savedSearch() {
  const candidates = [];
  for (const cash of [100, 200]) for (const vix of [30, 20, 25]) for (const rsi of [35, 25]) {
    const sequence = candidates.length + 1;
    candidates.push({ candidateId: `grid:candidate:${sequence}`, sequence, status: "completed",
      parameterValues: { "vix.buyThreshold": String(vix), "rsi.buyThreshold": rsi, "accumulation.cashSafetyLimit": String(cash) },
      metrics: { xirr: String((cash + vix + rsi) / 1000), maximumDrawdown: "0.1", analysis: { sharpeRatio: "1.5", calmarRatio: "2" } },
      testResult: { resultId: `grid:test:${sequence}`, status: "completed", metrics: { xirr: "-0.05", maximumDrawdown: "0.3", analysis: { sharpeRatio: null, calmarRatio: "-1" } } },
    });
  }
  return { strategyId: "grid", dimensions: [
    { key: "vix.buyThreshold", values: ["30", "20", "25"] }, { key: "rsi.buyThreshold", values: [35, 25] },
    { key: "accumulation.cashSafetyLimit", values: [100, 200] },
  ], candidates, rankedCandidateIds: [], totalCandidateCount: 12, optimizationMode: "train_test" };
}

test("heatmap sorts numeric axes, freezes every other dimension and transposes identities", () => {
  const result = savedSearch();
  const original = JSON.stringify(result);
  const matrix = buildSearchHeatmap(result, "vix.buyThreshold", "rsi.buyThreshold", { "accumulation.cashSafetyLimit": "100.00" });
  assert.deepEqual(matrix.xValues, ["20", "25", "30"]);
  assert.deepEqual(matrix.yValues, [25, 35]);
  assert.equal(matrix.cells.length, 2);
  assert.ok(matrix.cells.flat().every(row => row.parameterValues["accumulation.cashSafetyLimit"] === "100"));
  const transposed = buildSearchHeatmap(result, "rsi.buyThreshold", "vix.buyThreshold", { "accumulation.cashSafetyLimit": 100 });
  assert.equal(matrix.cells[1][2].candidateId, transposed.cells[2][1].candidateId);
  assert.equal(JSON.stringify(result), original);
});

test("heatmap rejects an unfixed third dimension, duplicate axes and unconfigured values", () => {
  const result = savedSearch();
  for (const [x, y, fixed] of [
    ["vix.buyThreshold", "rsi.buyThreshold", {}],
    ["vix.buyThreshold", "vix.buyThreshold", { "accumulation.cashSafetyLimit": 100 }],
    ["vix.buyThreshold", "rsi.buyThreshold", { "accumulation.cashSafetyLimit": 999 }],
  ]) assert.throws(() => buildSearchHeatmap(result, x, y, fixed));
});

test("neighbor slice fixes all other values and reads Train/Test metrics independently", () => {
  const result = savedSearch();
  const slice = buildSearchNeighborhood(result, "vix.buyThreshold", { "rsi.buyThreshold": 25, "accumulation.cashSafetyLimit": 200 });
  assert.deepEqual(slice.values, ["20", "25", "30"]);
  assert.ok(slice.candidates.every(row => row.parameterValues["accumulation.cashSafetyLimit"] === "200"));
  assert.equal(searchMetricValue(slice.candidates[0], "test", "xirr"), "-0.05");
  assert.equal(searchMetricValue(slice.candidates[0], "train", "sharpe"), "1.5");
  assert.equal(searchMetricValue(slice.candidates[0], "test", "sharpe"), null);
  assert.equal(searchOutcomeId(slice.candidates[0], "test"), slice.candidates[0].testResult.resultId);
  slice.candidates[0].testResult.status = "unavailable";
  assert.equal(searchMetricValue(slice.candidates[0], "test", "xirr"), null);
  assert.equal(searchOutcomeId(slice.candidates[0], "test"), null);
});

test("search heatmap axes and neighbor values expose accessible sorting controls", () => {
  const result = savedSearch();
  const matrix = renderToStaticMarkup(React.createElement(SearchLab, { result, locale: "en" }));
  assert.match(matrix, /class="search-matrix-caption"/);
  assert.match(matrix, /aria-label="Sort X axis descending"/);
  assert.match(matrix, /aria-label="Sort Y axis descending"/);

  const neighbors = renderToStaticMarkup(React.createElement(SearchLab, { result: {
    ...result, dimensions: [result.dimensions[0]],
  }, locale: "en" }));
  assert.match(neighbors, /aria-label="Sort Index buy threshold ascending"/);
  assert.match(neighbors, /aria-label="Sort XIRR descending"/);
});
