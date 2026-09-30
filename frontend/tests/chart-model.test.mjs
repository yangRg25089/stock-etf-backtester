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

test("total-asset comparison normalizes cashflow-adjusted unit NAV, not contributions", () => {
  const normalized = normalizeSeriesToBase100("totalAsset", [
    { date: "2024-01-02", index: 0, value: 100, normalizationValue: 1 },
    { date: "2024-02-01", index: 1, value: 5_000, normalizationValue: 1.05 },
    { date: "2024-03-01", index: 2, value: 10_000, normalizationValue: 1.1 },
  ]);

  assert.equal(normalized.baseValue, 1);
  assert.deepEqual(normalized.points.map(({ value }) => value), [100, 5_000, 10_000]);
  assert.ok(Math.abs(normalized.points[1].indexValue - 105) < 1e-9);
  assert.ok(Math.abs(normalized.points[2].indexValue - 110) < 1e-9);
});

test("total-asset comparison does not fall back to contributed account balances", () => {
  assert.equal(normalizeSeriesToBase100("totalAsset", [
    { date: "2024-01-02", index: 0, value: 100 },
    { date: "2024-02-01", index: 1, value: 5_000 },
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
