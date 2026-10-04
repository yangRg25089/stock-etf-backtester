import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { wireRun } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { PeriodPerformance } = require("../.test-output/features/results/PeriodPerformance.js");
const { formatExactPercent } = require("../.test-output/features/results/format.js");

test("period returns and episodes display frozen values and saved DCA without recomputing assets", () => {
  const result = wireRun().result.strategyRuns[0];
  const period = { year: 2024, startDate: "2024-02-01", endDate: "2024-02-29", navReturn: "0.01234567890123456789", priceReturn: "0.2" };
  result.metrics.analysis = { annualReturns: [period], monthlyReturns: [{ ...period, month: 2 }], drawdownEpisodes: [
    { peakDate: "2024-02-01", bottomDate: "2024-02-02", endDate: "2024-02-29", drawdown: "-0.123", durationDays: 28, recoveryDays: null, recoveredDate: null, state: "ongoing" },
  ] };
  const benchmark = structuredClone(result);
  benchmark.metrics.analysis.annualReturns[0].navReturn = "-0.3";
  const before = JSON.stringify([result, benchmark]);
  const html = renderToStaticMarkup(React.createElement(PeriodPerformance, { locale: "zh", result, benchmark }));
  assert.match(html, /20%/);
  assert.match(html, /-30%/);
  assert.match(html, /1\.234567890123456789%/);
  assert.match(html, /未恢复/);
  assert.match(html, /2024-02-01/);
  assert.match(html, /2024-02-29/);
  assert.equal((html.match(/class="heatmap-cell /g) ?? []).length, 1);
  assert.equal(JSON.stringify([result, benchmark]), before);
});

test("old saved analysis has one clear missing-period message, not invented series", () => {
  const result = wireRun().result.strategyRuns[0];
  result.metrics.analysis = { annualizedReturn: "0.2" };
  const html = renderToStaticMarkup(React.createElement(PeriodPerformance, { locale: "zh", result }));
  assert.match(html, /未保存分期表现/);
  assert.doesNotMatch(html, /<table|NaN|Infinity/);
});

test("exact percentage formatting preserves Decimal precision and scientific notation", () => {
  assert.equal(formatExactPercent("0.01234567890123456789"), "1.234567890123456789%");
  assert.equal(formatExactPercent("-1.23e-4"), "-0.0123%");
  assert.equal(formatExactPercent("1e2"), "10000%");
  assert.equal(formatExactPercent("-0.0000"), "0%");
  assert.equal(formatExactPercent(null), "—");
});
