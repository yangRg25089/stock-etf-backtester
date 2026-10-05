import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
const require = createRequire(import.meta.url);
const { sortedComparisons, COMPARISON_COLUMNS } = require("../.test-output/features/results/comparisonModel.js");
const { resultColor } = require("../.test-output/features/results/colors.js");
const make = (id, profit, extras = {}) => ({ id, presetId: "composite_dca", role: "strategy", status: profit === undefined ? "queued" : "completed",
  metrics: profit === undefined ? null : { returnOnContributions: String(profit), investmentBasis: "original_principal", ...extras } });
const sort = { key: "returnOnContributions", direction: "descending" };
test("completed returns progressively rank above stable pending identities", () => {
  const results = [1,2,3,4,5,6].map(id => make(String(id)));
  results[4] = make("5", 0.2);
  assert.deepEqual(sortedComparisons(results, sort, "zh").map(result => result.id), ["5","1","2","3","4","6"]);
  results[2] = make("3", 0.5);
  assert.deepEqual(sortedComparisons(results, sort, "zh").map(result => result.id), ["3","5","1","2","4","6"]);
  assert.deepEqual(results.map(result => result.id), ["1","2","3","4","5","6"]);
});
test("numeric sorting handles negative, zero, null, legacy and stable ties", () => {
  const results = [make("negative", -0.4), make("zero", 0), make("pending"), make("ten", 0.2, { endingEquity:"10" }), make("two", 0.2, { endingEquity:"2" })];
  assert.deepEqual(sortedComparisons(results, sort, "ja").map(result => result.id), ["ten","two","zero","negative","pending"]);
  assert.deepEqual(sortedComparisons(results, { key:"endingEquity", direction:"ascending" }, "ja").map(result => result.id), ["two","ten","negative","zero","pending"]);
  assert.equal(COMPARISON_COLUMNS.length, 9);
  for (const { key } of COMPARISON_COLUMNS) assert.equal(sortedComparisons(results, { key, direction:"ascending" }, "zh").length, 5);
});

test("comparison sorting preserves precision beyond floating-point resolution", () => {
  const results = [make("small", 0.1, { endingEquity: "10.0000000000000000001" }),
    make("large", 0.2, { endingEquity: "10.0000000000000000002" })];
  assert.deepEqual(sortedComparisons(results, { key: "endingEquity", direction: "descending" }, "en").map(result => result.id), ["large", "small"]);
});

test("all allowed strategies and automatic benchmarks have distinct colors", () => {
  const catalog = JSON.parse(readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"));
  const fixed = catalog.presets.filter(preset => !["composite_dca", "monthly_dca", "lump_sum"].includes(preset.id)).length;
  const count = fixed + catalog.strategyLimits.maxTotalInstances + 2;
  const colors = Array.from({ length:count }, (_, index) => resultColor(index));
  assert.equal(new Set(colors).size, count);
  for (const color of colors) {
    const channels = color.slice(1).match(/../g).map(hex => parseInt(hex, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    assert.ok(1.05 / (luminance + 0.05) >= 4.5, color);
  }
});
