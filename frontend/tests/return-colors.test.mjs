import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { ReturnPercent } = require("../.test-output/features/results/ReturnPercent.js");
const { returnTone } = require("../.test-output/features/results/returnTone.js");
const { MonthlyHeatmap } = require("../.test-output/features/results/MonthlyHeatmap.js");
const { PeriodPerformance } = require("../.test-output/features/results/PeriodPerformance.js");
const { heatmapLevel } = require("../.test-output/features/results/heatmapLevel.js");

const heatmapCss = readFileSync(new URL("../src/styles/return-colors.css", import.meta.url), "utf8");
const reportImageSource = readFileSync(new URL("../src/features/results/reportImage.ts", import.meta.url), "utf8");

test("return direction preserves Decimal signs, treats negative zero as neutral and excludes invalid values", () => {
  for (const value of ["1e-1000", "0.01", 1]) assert.equal(returnTone(value), "positive");
  for (const value of ["-1e-1000", "-0.01", -1]) assert.equal(returnTone(value), "negative");
  for (const value of ["0", "-0.0000e-1000", -0]) assert.equal(returnTone(value), "neutral");
  for (const value of [null, undefined, "", "no data", NaN, Infinity]) assert.equal(returnTone(value), "missing");
  assert.equal(returnTone("0.2", "drawdown"), "negative");
  assert.equal(returnTone("-0.2", "drawdown"), "negative");
  assert.equal(returnTone(0, "drawdown"), "neutral");
});

test("shared return rendering keeps percentage values, loss magnitudes and missing observations intact", () => {
  const render = props => renderToStaticMarkup(React.createElement(ReturnPercent, { locale: "en", ...props }));
  assert.equal(render({ value: "-0.12" }), '<span class="return-value is-negative">-12%</span>');
  assert.equal(render({ value: "0.12", kind: "drawdown" }), '<span class="return-value is-negative">12%</span>');
  assert.equal(render({ value: "0" }), '<span class="return-value is-neutral">0%</span>');
  assert.equal(render({ value: null }), '<span class="return-value is-missing">—</span>');
});

test("monthly returns inherit the global convention without retaining a local preference or duplicate control", () => {
  const values = ["0.01", "-0.01", "0", null].map((navReturn, index) => ({
    year: 2024, month: index + 1, navReturn,
    startDate: `2024-0${index + 1}-01`, endDate: `2024-0${index + 1}-28`,
  }));
  const html = renderToStaticMarkup(React.createElement(MonthlyHeatmap, { locale: "zh", values }));
  for (const tone of ["positive", "negative", "neutral", "missing"]) assert.match(html, new RegExp(`heatmap-cell is-${tone}`));
  assert.doesNotMatch(html, /palette-option|palette-toggle|is-red-up|is-green-up/);
});

test("monthly and annual return heatmaps use the agreed fixed magnitude thresholds", () => {
  assert.deepEqual([0, .0001, .029999, .03, .079999, .08, .149999, .15, .6, .61].map(value => heatmapLevel(value)),
    [0, 1, 1, 2, 2, 3, 3, 4, 4, 4]);
  assert.deepEqual([.119999, .12, .319999, .32, .599999, .6].map(value => heatmapLevel(value, true)), [1, 2, 2, 3, 3, 4]);

  const monthlyReturns = [.01, .03, .0301, .08, .0801, .15, .1501, .2, -.01, -.0801, -.1501, -.2];
  const values = monthlyReturns.map((navReturn, index) => ({
    year: 2024, month: index + 1, navReturn: String(navReturn),
    startDate: `2024-${String(index + 1).padStart(2, "0")}-01`, endDate: `2024-${String(index + 1).padStart(2, "0")}-28`,
  }));
  const monthlyHtml = renderToStaticMarkup(React.createElement(MonthlyHeatmap, { locale: "en", values }));
  const monthlyLevels = [...monthlyHtml.matchAll(/class="heatmap-cell is-(positive|negative) is-level-(\d)/g)]
    .map(([, tone, level]) => [tone, Number(level)]);
  assert.deepEqual(monthlyLevels, [
    ["positive", 1], ["positive", 2], ["positive", 2], ["positive", 3],
    ["positive", 3], ["positive", 4], ["positive", 4], ["positive", 4],
    ["negative", 1], ["negative", 3], ["negative", 4], ["negative", 4],
  ]);

  const annualValues = [.08, .12, .32, .6].map((navReturn, index) => ({
    year: 2020 + index, month: null, navReturn: String(navReturn),
    startDate: `${2020 + index}-01-01`, endDate: `${2020 + index}-12-31`,
  }));
  const annualHtml = renderToStaticMarkup(React.createElement(MonthlyHeatmap, { locale: "en", values: [], annualValues }));
  const annualLevels = [...annualHtml.matchAll(/class="heatmap-cell is-positive is-level-(\d)/g)].map(([, level]) => Number(level));
  assert.deepEqual(annualLevels, [1, 2, 3, 4]);
});

test("monthly return heatmaps use the supplied red/green swatches and white text in either palette", () => {
  for (const [name, color] of [
    ["red-1", "#ef4a4a"], ["red-2", "#f72d2d"], ["red-3", "#bf2222"], ["red-4", "#9a1a1a"],
    ["green-1", "#18d57f"], ["green-2", "#1dc87a"], ["green-3", "#0c9a5a"], ["green-4", "#087443"],
  ]) assert.match(heatmapCss, new RegExp(`--heatmap-${name}:\\s*${color}`));
  assert.match(heatmapCss, /--heatmap-positive-1:\s*var\(--heatmap-red-1\)/);
  assert.match(heatmapCss, /--heatmap-negative-1:\s*var\(--heatmap-green-1\)/);
  assert.match(heatmapCss, /--heatmap-positive-1:\s*var\(--heatmap-green-1\)/);
  assert.match(heatmapCss, /--heatmap-negative-1:\s*var\(--heatmap-red-1\)/);
  assert.match(heatmapCss, /\.heatmap-cell\.is-positive,\s*\.heatmap-cell\.is-negative\s*\{[^}]*color:\s*#fff/s);
  assert.match(heatmapCss, /\.heatmap-cell\.is-positive\.is-level-4\s*\{[^}]*background:\s*var\(--heatmap-positive-4\)/s);
  assert.match(reportImageSource, /color\(`--heatmap-\$\{tone\}-\$\{level\}`\)/);
  assert.match(reportImageSource, /tone === "positive" \|\| tone === "negative" \? "#fff"/);
});

test("period performance keeps named scroll regions and headings without duplicate outer landmarks", () => {
  const result = { metrics: { analysis: {
    annualReturns: [{ year: 2024, navReturn: "0.05", priceReturn: "0.1" }],
    monthlyReturns: [{ year: 2024, month: 1, navReturn: "0.05" }],
    drawdownEpisodes: [{ peakDate: "2024-01-01", bottomDate: "2024-01-02", endDate: "2024-01-03", drawdown: "-0.03", durationDays: 2, recoveryDays: 1 }],
  } } };
  for (const locale of ["ja", "zh", "en"]) {
    const html = renderToStaticMarkup(React.createElement(PeriodPerformance, { locale, result }));
    assert.doesNotMatch(html, /<section[^>]*aria-labelledby="performance-(?:monthly|annual|episodes)-heading"/);
    assert.equal((html.match(/role="region"/g) ?? []).length, 2);
    for (const name of ["monthly", "episodes"]) assert.match(html, new RegExp(`<h4 id="performance-${name}-heading">`));
  }
});
