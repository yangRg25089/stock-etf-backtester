import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  FULL_CHART_VIEWPORT,
  clampChartViewport,
  nearestChartIndex,
  panChartViewport,
  pinchChartViewport,
  samplesInViewport,
  zoomChartViewport,
} = require("../.test-output/features/results/chartViewport.js");

test("zoom preserves the date under the pointer and clamps to the full history", () => {
  const initial = { start: 0.2, end: 0.8 };
  const anchorDate = initial.start + (initial.end - initial.start) * 0.25;
  const zoomed = zoomChartViewport(initial, 0.5, 0.25);

  assert.equal(zoomed.start + (zoomed.end - zoomed.start) * 0.25, anchorDate);
  assert.deepEqual(zoomChartViewport(FULL_CHART_VIEWPORT, 0.5), { start: 0.25, end: 0.75 });
  assert.deepEqual(zoomChartViewport(zoomed, 10), FULL_CHART_VIEWPORT);
});

test("drag pans the same fraction of the visible history without crossing its limits", () => {
  const zoomed = { start: 0.2, end: 0.8 };
  const panned = panChartViewport(zoomed, 0.25);
  assert.ok(Math.abs(panned.start - 0.05) < 1e-9);
  assert.ok(Math.abs(panned.end - 0.65) < 1e-9);
  const pannedRight = panChartViewport(zoomed, -1);
  assert.ok(Math.abs(pannedRight.start - 0.4) < 1e-9);
  assert.equal(pannedRight.end, 1);
  assert.deepEqual(panChartViewport(FULL_CHART_VIEWPORT, 0.2), FULL_CHART_VIEWPORT);
});

test("pinch zoom uses the distance ratio and keeps the initial center date under the moving center", () => {
  const zoomed = pinchChartViewport(FULL_CHART_VIEWPORT, 100, 200, 0.5, 0.6);

  assert.ok(Math.abs(zoomed.end - zoomed.start - 0.5) < 1e-12);
  assert.ok(Math.abs(zoomed.start + (zoomed.end - zoomed.start) * 0.6 - 0.5) < 1e-12);
  assert.deepEqual(pinchChartViewport({ start: 0.2, end: 0.8 }, 200, 100, 0.5, 0.5), {
    start: 0, end: 1,
  });
  assert.deepEqual(pinchChartViewport({ start: 0.2, end: 0.8 }, 200, 1, 0.5, 0.5), FULL_CHART_VIEWPORT);
});

test("viewport clamping keeps a usable range and samples include both line-edge neighbors", () => {
  assert.deepEqual(clampChartViewport({ start: 0.99, end: 1 }), { start: 0.98, end: 1 });
  const samples = [0, 1, 2, 3, 4].map((index) => ({ index, value: index * 10 }));
  assert.deepEqual(
    samplesInViewport(samples, { start: 0.25, end: 0.75 }, 5).map(({ index }) => index),
    [0, 1, 2, 3, 4],
  );
});

test("cursor snaps to a saved point inside the visible range without interpolating dates", () => {
  assert.equal(nearestChartIndex(5, FULL_CHART_VIEWPORT, 0), 0);
  assert.equal(nearestChartIndex(5, FULL_CHART_VIEWPORT, 0.49), 2);
  assert.equal(nearestChartIndex(5, FULL_CHART_VIEWPORT, 1), 4);
  assert.equal(nearestChartIndex(11, { start: 0.24, end: 0.76 }, 0), 3);
  assert.equal(nearestChartIndex(11, { start: 0.24, end: 0.76 }, 1), 7);
  assert.equal(nearestChartIndex(3, { start: 0.2, end: 0.4 }, 0.5), null);
  assert.equal(nearestChartIndex(0, FULL_CHART_VIEWPORT, 0.5), null);
  assert.equal(nearestChartIndex(1, FULL_CHART_VIEWPORT, 0.5), 0);
  assert.equal(nearestChartIndex(5, FULL_CHART_VIEWPORT, -0.1), null);
  assert.equal(nearestChartIndex(5, FULL_CHART_VIEWPORT, 1.1), null);
  assert.equal(nearestChartIndex(5, FULL_CHART_VIEWPORT, NaN), null);
});
