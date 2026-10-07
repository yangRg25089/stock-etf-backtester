import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { CHART, MAIN_WITHOUT_DATES, COMPACT_CHART, responsiveChartGeometry } = require("../.test-output/features/results/chart/chartScale.js");

test("narrow plots preserve horizontal date mapping and readable vertical space", () => {
  for (const width of [280, 304, 360, 420, 600]) {
    const main = responsiveChartGeometry(MAIN_WITHOUT_DATES, width);
    const indicator = responsiveChartGeometry(COMPACT_CHART, width);
    assert.equal(main.width, CHART.width);
    assert.equal(main.left, CHART.left);
    assert.equal(main.right, CHART.right);
    assert.ok(Math.abs(main.height * width / CHART.width - 240) < 1e-9);
    assert.ok(Math.abs(indicator.height * width / CHART.width - 90) < 1e-9);
    assert.ok(main.top < main.height - main.bottom);
    assert.ok(indicator.top < indicator.height - indicator.bottom);
  }
});

test("wide, unmeasured and invalid widths retain the existing geometry", () => {
  for (const width of [0, -1, NaN, Infinity, 680, 1000, 1360]) {
    assert.deepEqual(responsiveChartGeometry(MAIN_WITHOUT_DATES, width), MAIN_WITHOUT_DATES);
    assert.deepEqual(responsiveChartGeometry(COMPACT_CHART, width), COMPACT_CHART);
  }
});
