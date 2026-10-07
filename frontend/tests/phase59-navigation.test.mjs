import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { catalog, wireRun } from "./helpers/contracts.mjs";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { PackageControls } = require("../.test-output/features/files/PackageControls.js");
const { RunActions } = require("../.test-output/features/runs/RunActions.js");
const { createInitialWorkspaceState } = require("../.test-output/features/strategies/model.js");
const { IndicatorChart } = require("../.test-output/features/results/chart/IndicatorChart.js");
const { FULL_CHART_VIEWPORT } = require("../.test-output/features/results/chartViewport.js");
const { ThemeControl } = require("../.test-output/shared/ui/ThemeControl.js");
const { SelectedStrategies } = require("../.test-output/features/results/SelectedStrategies.js");

test("file actions stay visible in the navigation without an overflow menu", () => {
  const html = renderToStaticMarkup(React.createElement(PackageControls, {
    catalog, draft: createInitialWorkspaceState(catalog).draft, run: null, locale: "en", busy: false, onImport() {},
  }));
  assert.doesNotMatch(html, /<details|<summary|package-menu/);
  assert.match(html, /package-actions/);
  assert.match(html, /Save strategy/);
  assert.match(html, /Load a file/);
  assert.match(html, />export<\/span>/);
  assert.match(html, />import<\/span>/);
  assert.match(html, /aria-label="export · Save strategy \(\.strategy\.json\)"/);
  assert.match(html, /aria-label="import · Load a file"/);
});

for (const [busy, canStop, count] of [[false, false, 2], [true, false, 2], [true, true, 3]]) test(`stop is shown only during cancellable execution: busy=${busy}, canStop=${canStop}`, () => {
  const html = renderToStaticMarkup(React.createElement(RunActions, {
    locale: "en", availability: { disabled: false, reasonKey: null }, busy, canStop, stopping: false,
    canReset: true, onRun() {}, onReset() {}, onStop() {},
  }));
  assert.ok(html.indexOf("run-submit-button") < html.indexOf("run-reset-button"));
  assert.equal((html.match(/<button/g) ?? []).length, count);
  if (canStop) assert.ok(html.indexOf("run-reset-button") < html.indexOf("run-stop-button"));
  else assert.doesNotMatch(html, /run-stop-button/);
});

test("theme selection preserves Classic and offers four popular palettes with short English names", () => {
  const previous = globalThis.localStorage;
  try {
    for (const stored of [null, "mint", "blue", "unknown", "forest"]) {
      globalThis.localStorage = { getItem: () => stored };
      const html = renderToStaticMarkup(React.createElement(ThemeControl, { locale: "en" }));
      assert.match(html, /<select[^>]*class="theme-select"[^>]*aria-label="Theme"/);
      assert.equal((html.match(/<option/g) ?? []).length, 5);
      assert.match(html, new RegExp(`<option value="${stored === "forest" ? "forest" : "classic"}" selected=""`));
      assert.doesNotMatch(html, /value="(?:blue|mint)"/);
    }
    globalThis.localStorage = { getItem() { throw new Error("blocked"); } };
    for (const locale of ["ja", "zh", "en"]) {
      const html = renderToStaticMarkup(React.createElement(ThemeControl, { locale }));
      assert.match(html, /value="classic" selected/);
      for (const name of ["Classic", "Wine", "Navy", "Blush", "Forest"]) assert.ok(html.includes(`>${name}</option>`));
    }
  } finally { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; }
});

test("header chips distinguish the current details target from other selected curves", () => {
  const run = wireRun("selected-header", "completed", ["a", "b"]);
  const html = renderToStaticMarkup(React.createElement(SelectedStrategies, { run, ids: ["a", "b"], focusedResultId: "b", locale: "en" }));
  assert.equal((html.match(/selected-strategy-chip/g) ?? []).length, 2);
  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
  assert.match(html, /selected-strategy-chip is-focused[^>]*data-result-id="b"[^>]*aria-current="true"/);
  assert.match(html, /selected-strategy-detail-label/);
  const unselectedFocus = renderToStaticMarkup(React.createElement(SelectedStrategies, { run, ids: ["a"], focusedResultId: "b", locale: "en" }));
  assert.doesNotMatch(unselectedFocus, /aria-current="true"|is-focused/);
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
