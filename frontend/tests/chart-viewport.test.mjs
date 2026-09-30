import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  FULL_CHART_VIEWPORT,
  clampChartViewport,
  panChartViewport,
  samplesInViewport,
  wheelZoomFactor,
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

test("wheel zoom follows accumulated delta instead of counting trackpad events", () => {
  const oneWheelGesture = wheelZoomFactor(-160);
  const splitTrackpadGesture = Array.from({ length: 16 }, () => wheelZoomFactor(-10))
    .reduce((factor, nextFactor) => factor * nextFactor, 1);

  assert.ok(Math.abs(oneWheelGesture - 0.92) < 1e-12);
  assert.ok(Math.abs(splitTrackpadGesture - oneWheelGesture) < 1e-12);
  assert.ok(Math.abs(wheelZoomFactor(160) * oneWheelGesture - 1) < 1e-12);
});

test("wheel line and page deltas normalize to equivalent chart distances", () => {
  const pixelDelta = wheelZoomFactor(-160, 0);
  const lineDelta = wheelZoomFactor(-10, 1);
  const pageDelta = wheelZoomFactor(-0.5, 2);

  assert.ok(Math.abs(lineDelta - pixelDelta) < 1e-12);
  assert.ok(Math.abs(pageDelta - pixelDelta) < 1e-12);
});

test("viewport clamping keeps a usable range and samples include both line-edge neighbors", () => {
  assert.deepEqual(clampChartViewport({ start: 0.99, end: 1 }), { start: 0.98, end: 1 });
  const samples = [0, 1, 2, 3, 4].map((index) => ({ index, value: index * 10 }));
  assert.deepEqual(
    samplesInViewport(samples, { start: 0.25, end: 0.75 }, 5).map(({ index }) => index),
    [0, 1, 2, 3, 4],
  );
});
