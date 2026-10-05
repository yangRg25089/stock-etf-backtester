import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { sortTableRows, nextTableSort } = require("../.test-output/features/results/tableSorting.js");

test("table sorting compares decimal strings exactly and always leaves missing values last", () => {
  const rows = [
    { id: "small", value: "0.0000000000000000000000000000000000002" },
    { id: "missing", value: null },
    { id: "large", value: "0.00000000000000000000000000000000000011" },
    { id: "also-missing", value: undefined },
  ];
  assert.deepEqual(sortTableRows(rows, { key: "value", direction: "ascending" }, row => row.value, "en").map(row => row.id),
    ["large", "small", "missing", "also-missing"]);
  assert.deepEqual(sortTableRows(rows, { key: "value", direction: "descending" }, row => row.value, "en").map(row => row.id),
    ["small", "large", "missing", "also-missing"]);
});

test("table sorting is stable for equal values and uses locale-aware natural text order", () => {
  const rows = [{ id: "A10", value: "Strategy 10" }, { id: "B2", value: "Strategy 2" }, { id: "A2", value: "Strategy 2" }];
  assert.deepEqual(sortTableRows(rows, { key: "name", direction: "ascending" }, row => row.value, "en").map(row => row.id), ["B2", "A2", "A10"]);
});

test("header sort state toggles the active key and applies the requested first direction", () => {
  const current = { key: "date", direction: "ascending" };
  assert.deepEqual(nextTableSort(current, "date"), { key: "date", direction: "descending" });
  assert.deepEqual(nextTableSort(current, "price"), { key: "price", direction: "ascending" });
  assert.deepEqual(nextTableSort(null, "drawdown", "descending"), { key: "drawdown", direction: "descending" });
});
