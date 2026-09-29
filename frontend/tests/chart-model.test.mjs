import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { normalizeSeriesToBase100 } = require("../.test-output/features/results/chartModel.js");

test("positive price, portfolio, and VIX series use their first positive value as 100", () => {
  const points = [
    { date: "2024-01-02", index: 0, value: 0 },
    { date: "2024-01-03", index: 1, value: 50 },
    { date: "2024-01-04", index: 2, value: 60 },
  ];

  const normalized = normalizeSeriesToBase100("price", points);

  assert.equal(normalized.baseDate, "2024-01-03");
  assert.deepEqual(normalized.points.map((point) => point.indexValue), [100, 120]);
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
