import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { wireRun } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { PeriodPerformance } = require("../.test-output/features/results/PeriodPerformance.js");
const { formatExactPercent } = require("../.test-output/features/results/format.js");
const { MonthlyHeatmap } = require("../.test-output/features/results/MonthlyHeatmap.js");

test("monthly inspection uses compact percentages while preserving exact saved values in the tooltip", () => {
  const values = [{ year: 2023, month: 11, startDate: "2023-11-01", endDate: "2023-11-30",
    navReturn: "0.108188106783985417959598754055960775191", priceReturn: null }];
  const before = JSON.stringify(values);
  for (const locale of ["ja", "zh"]) {
    const html = renderToStaticMarkup(React.createElement(MonthlyHeatmap, { locale, values }));
    assert.match(html, /aria-label="2023-11 · 10\.82%"/);
    assert.match(html, /title="2023-11 · 10\.8188106783985417959598754055960775191% · 2023-11-01 → 2023-11-30"/);
    assert.match(html, /class="icon-only-button table-expand-button"/);
    assert.match(html, /aria-expanded="false"/);
    const controls = html.match(/aria-controls="([^"]+)"/)[1];
    assert.ok(html.includes(`id="${controls}"`));
  }
  assert.equal(JSON.stringify(values), before);
  const busy = renderToStaticMarkup(React.createElement(MonthlyHeatmap, { locale: "zh", values, busy: true }));
  assert.match(busy, /class="icon-only-button table-expand-button"[^>]*disabled=""/);
});

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

test("exact percentage expansion preserves leading/trailing-zero policy and exponent boundaries", () => {
  for (const [value, expected] of [
    ["00012.300", "1230%"], [".00100", "0.1%"], ["+.5", "50%"], ["1.2e3", "120000%"],
    ["1.2300e-5", "0.00123%"], ["1e4097", "—"], ["1e-4097", "—"], ["abc", "—"], [".", "—"],
  ]) assert.equal(formatExactPercent(value), expected, value);
  assert.equal(formatExactPercent("1e-4096"), `0.${"0".repeat(4093)}1%`);
});
