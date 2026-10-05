import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { catalog } from "./helpers/contracts.mjs";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { PackageControls } = require("../.test-output/features/files/PackageControls.js");
const { RunActions } = require("../.test-output/features/runs/RunActions.js");
const { createInitialWorkspaceState } = require("../.test-output/features/strategies/model.js");
const { IndicatorChart } = require("../.test-output/features/results/chart/IndicatorChart.js");
const { FULL_CHART_VIEWPORT } = require("../.test-output/features/results/chartViewport.js");

test("file actions stay visible in the navigation without an overflow menu", () => {
  const html = renderToStaticMarkup(React.createElement(PackageControls, {
    catalog, draft: createInitialWorkspaceState(catalog).draft, run: null, locale: "en", busy: false, onImport() {},
  }));
  assert.doesNotMatch(html, /<details|<summary|package-menu/);
  assert.match(html, /package-actions/);
  assert.match(html, /Save strategy/);
  assert.match(html, /Load a file/);
});

for (const busy of [false, true]) test(`run, reset, stop keep three stable navigation positions when busy=${busy}`, () => {
  const html = renderToStaticMarkup(React.createElement(RunActions, {
    locale: "en", availability: { disabled: false, reasonKey: null }, busy, canStop: busy, stopping: false,
    canReset: true, onRun() {}, onReset() {}, onStop() {},
  }));
  assert.ok(html.indexOf("run-submit-button") < html.indexOf("run-reset-button"));
  assert.ok(html.indexOf("run-reset-button") < html.indexOf("run-stop-button"));
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  if (!busy) assert.match(html, /run-stop-button[^>]*disabled/);
});

for (const id of ["drawdown", "vix", "rsi"]) test(`${id} auxiliary chart has an axis title and bounded gradient area`, () => {
  const assets = ["2024-01-02", "2024-01-03", "2024-01-04"].map(date => ({ date, currency: "USD" }));
  const html = renderToStaticMarkup(React.createElement(IndicatorChart, {
    locale: "en", assets, series: { id, color: "#30497d", labelKey: `chart.${id}` },
    samples: assets.map((asset, index) => ({ date: asset.date, index, value: id === "drawdown" ? -index * 0.05 : 20 + index })),
    viewport: FULL_CHART_VIEWPORT, chartInteractionProps: {}, cursor: null,
    thresholdValue: null, hasBuySignalObservations: false,
  }));
  assert.match(html, /chart-y-axis-title/);
  assert.match(html, /linearGradient/);
  assert.match(html, /chart-highlight-area/);
  assert.match(html, /clip-path=/);
  assert.doesNotMatch(html, /<figcaption/);
});
