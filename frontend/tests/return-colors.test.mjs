import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { ReturnPercent } = require("../.test-output/features/results/ReturnPercent.js");
const { returnTone } = require("../.test-output/features/results/returnTone.js");
const { MonthlyHeatmap } = require("../.test-output/features/results/MonthlyHeatmap.js");
const { PeriodPerformance } = require("../.test-output/features/results/PeriodPerformance.js");

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
