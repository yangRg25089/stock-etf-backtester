import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { normalizeSeriesToBase100 } = require("../.test-output/features/results/chartModel.js");
const { selectedChartSeries } = require("../.test-output/features/results/chart/chartSeriesModel.js");

test("price normalization uses the first positive saved value as 100", () => {
  const points = [
    { date: "2024-01-02", index: 0, value: 0 },
    { date: "2024-01-03", index: 1, value: 50 },
    { date: "2024-01-04", index: 2, value: 60 },
  ];

  const normalized = normalizeSeriesToBase100("price", points);

  assert.equal(normalized.baseDate, "2024-01-03");
  assert.deepEqual(normalized.points.map((point) => point.indexValue), [100, 120]);
});

test("total-asset comparison uses each day's contributed principal without rebasing", () => {
  const normalized = normalizeSeriesToBase100("totalAsset", [
    { date: "2024-01-31", index: 0, value: 0, contributed: 0 },
    { date: "2024-02-01", index: 1, value: 110, contributed: 100 },
    { date: "2024-03-01", index: 2, value: 230, contributed: 200 },
    { date: "2024-03-04", index: 3, value: 0, contributed: 200 },
  ]);
  assert.equal(normalized.baseDate, "2024-02-01");
  assert.deepEqual(normalized.points.map(({ value }) => value), [110, 230, 0]);
  assert.deepEqual(normalized.points.map(({ indexValue }) => Math.round(indexValue)), [110, 115, 0]);
});

test("missing, zero, or negative principal does not fabricate a relative asset curve", () => {
  assert.equal(normalizeSeriesToBase100("totalAsset", [
    { date: "2024-01-02", index: 0, value: 100 },
    { date: "2024-02-01", index: 1, value: 5000, contributed: 0 },
    { date: "2024-03-01", index: 2, value: 5000, contributed: -100 },
  ]), null);
});

test("drawdown overlays start at 100 and express drawdown as peak-relative value", () => {
  const normalized = normalizeSeriesToBase100("drawdown", [
    { date: "2024-01-02", index: 0, value: 0 },
    { date: "2024-01-03", index: 1, value: -0.2 },
    { date: "2024-01-04", index: 2, value: -0.1 },
  ]);

  assert.deepEqual(normalized.points.map((point) => point.indexValue), [100, 80, 90]);
});

test("unusable zero or negative baselines do not fabricate an overlay series", () => {
  assert.equal(normalizeSeriesToBase100("vix", [
    { date: "2024-01-02", index: 0, value: 0 },
    { date: "2024-01-03", index: 1, value: -1 },
  ]), null);
});

test("core chart visibility follows explicit user selection, including no visible core series", () => {
  const available = [{ id: "price" }, { id: "totalAsset" }, { id: "drawdown" }];
  assert.deepEqual(selectedChartSeries(available, []), []);
  assert.deepEqual(selectedChartSeries(available, ["drawdown"]).map(series => series.id), ["drawdown"]);
  assert.deepEqual(selectedChartSeries(available, ["price"]).map(series => series.id), ["price"]);
});
