import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const { CHART, MAIN_WITHOUT_DATES, COMPACT_CHART, responsiveChartGeometry, chartScale, chartPlotHeights } = require("../.test-output/features/results/chart/chartScale.js");

test("narrow plots preserve horizontal date mapping and readable vertical space", () => {
  for (const width of [280, 304, 360, 420, 600]) {
    const main = responsiveChartGeometry(MAIN_WITHOUT_DATES, width);
    const indicator = responsiveChartGeometry(COMPACT_CHART, width);
    assert.equal(main.width, CHART.width);
    assert.equal(main.left, CHART.left);
    assert.equal(main.right, CHART.right);
    assert.ok(Math.abs(main.height * width / CHART.width - 280) < 1e-9);
    assert.ok(Math.abs(indicator.height * width / CHART.width - 100) < 1e-9);
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

test('measured wide plots use actual pixel height instead of growing with width', () => {
  for (const width of [800, 1100, 1360]) {
    const main=responsiveChartGeometry(MAIN_WITHOUT_DATES,width,340);
    const auxiliary=responsiveChartGeometry(COMPACT_CHART,width,72);
    assert.equal(Math.round(main.height*width/CHART.width),340);
    assert.equal(Math.round(auxiliary.height*width/CHART.width),72);
    assert.ok(main.height>main.top+main.bottom);
  }
});

test("vertical chart panning shifts only the value domain while preserving the plot's pixel mapping", () => {
  const values = [10, 20, 30];
  const automatic = chartScale(values);
  const shifted = chartScale(values, { verticalOffsetRatio: 0.25 });
  const span = automatic.maximum - automatic.minimum;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;

  assert.ok(Math.abs(shifted.minimum - automatic.minimum - span * 0.25) < 1e-9);
  assert.ok(Math.abs(shifted.maximum - automatic.maximum - span * 0.25) < 1e-9);
  assert.ok(Math.abs(shifted.y(20) - automatic.y(20) - plotHeight * 0.25) < 1e-9);
});

test("mobile viewport prevents page pinch zoom while charts own their touch gestures", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const charts = readFileSync(new URL("../src/styles/charts.css", import.meta.url), "utf8");
  const linked = readFileSync(new URL("../src/styles/linked-charts.css", import.meta.url), "utf8");

  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1\.0"/);
  assert.doesNotMatch(html, /maximum-scale|user-scalable/);
  assert.match(app, /touches\.length > 1[^\n]*preventDefault/s);
  assert.match(app, /addEventListener\("gesturestart"/);
  assert.match(app, /target\.closest\("svg\.result-chart"\)/);
  assert.match(charts, /\.result-chart\s*\{[^}]*touch-action:\s*none/s);
  assert.doesNotMatch(linked, /touch-action:\s*(?:pan-y|pinch-zoom)/);
});

test("wide plot height budget prioritizes the larger main chart and remains scrollable when crowded", () => {
  assert.deepEqual(chartPlotHeights(640, 1), { main: 440, auxiliary: 96 });
  assert.deepEqual(chartPlotHeights(640, 3), { main: 400, auxiliary: 80 });
  assert.deepEqual(chartPlotHeights(400, 3), { main: 280, auxiliary: 80 });
});
