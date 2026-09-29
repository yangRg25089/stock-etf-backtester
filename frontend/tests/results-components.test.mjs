import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { MetricGrid, ResultComparison } = require("../.test-output/features/results/ResultSummary.js");

function metrics(endingEquity) {
  return {
    totalContributed: "100.00",
    endingEquity,
    netProfit: String(Number(endingEquity) - 100),
    returnOnContributions: "0.25",
    capitalMultiple: "1.25",
    xirr: "0.12",
    maximumDrawdown: "0.08",
    relativeToDca: "5.00",
    currency: "USD",
    diagnostics: [],
  };
}

const results = [
  {
    id: "vix-instance",
    presetId: "vix_dca",
    role: "strategy",
    status: "completed",
    metrics: metrics("125.00"),
    diagnostics: [],
    dailyAssets: [],
    trades: [],
  },
  {
    id: "benchmark-dca",
    presetId: "monthly_dca",
    role: "benchmark",
    status: "completed_with_warning",
    metrics: metrics("130.00"),
    diagnostics: [],
    dailyAssets: [],
    trades: [],
  },
];

test("comparison table focuses the saved result identity and shows backend statuses", () => {
  const html = renderToStaticMarkup(React.createElement(ResultComparison, {
    locale: "zh",
    strategyRuns: results,
    focusedResultId: "benchmark-dca",
    onFocus() {},
  }));

  assert.match(html, /aria-pressed="true"><span>每月定额定投/);
  assert.match(html, /aria-pressed="false"><span>VIX 信号定投/);
  assert.match(html, /已完成，有警告/);
  assert.match(html, /资本倍数/);
});

test("metric cards label contribution return separately from capital multiple", () => {
  const html = renderToStaticMarkup(React.createElement(MetricGrid, {
    locale: "zh",
    metrics: metrics("125.00"),
  }));

  assert.match(html, /投入回报率/);
  assert.match(html, /资本倍数/);
  assert.match(html, /25%/);
  assert.match(html, /1\.25×/);
  assert.match(html, /12%/);
  assert.match(html, /最大回撤/);
});

test("unavailable optional metrics render as unavailable rather than zero", () => {
  const html = renderToStaticMarkup(React.createElement(MetricGrid, {
    locale: "ja",
    metrics: { ...metrics("125"), xirr: null, maximumDrawdown: null },
  }));
  assert.match(html, /—/);
  assert.match(html, /算出できません/);
});
