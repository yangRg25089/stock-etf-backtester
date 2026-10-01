import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { ResultComparison } = require("../.test-output/features/results/ResultSummary.js");

function metrics(endingEquity) {
  return {
    actualInvested: "80.00",
    investmentBasis: "original_principal",
    totalContributed: "100.00",
    endingEquity,
    netProfit: String(Number(endingEquity) - 100),
    returnOnContributions: "0.25",
    capitalMultiple: "1.25",
    xirr: "0.12",
    maximumDrawdown: "0.08",

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

test("comparison table focuses saved identity without role or status columns", () => {
  const html = renderToStaticMarkup(React.createElement(ResultComparison, {
    locale: "zh",
    strategyRuns: results,
    focusedResultId: "benchmark-dca",
    selectedResultIds: ["benchmark-dca"],
    onFocus() {},
  }));

  assert.match(html, /aria-pressed="true"><span>每月定额定投/);
  assert.match(html, /aria-pressed="false"><span>波动率信号定投/);
  assert.doesNotMatch(html, /benchmark-dca|vix-instance/);
  assert.doesNotMatch(html, /角色|状态|基准策略|已完成，有警告|status-tag/);
  assert.match(html, /资本倍数/);
});

test("comparison rows expose independent curve selection and stable row colors", () => {
  const html = renderToStaticMarkup(React.createElement(ResultComparison, {
    locale: "zh",
    strategyRuns: results,
    focusedResultId: "vix-instance",
    selectedResultIds: ["vix-instance"],
    onFocus() {},
    onToggleSelection() {},
  }));
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.match(html, /aria-pressed="true"><span>波动率信号定投/);
  assert.match(html, /data-result-color|--result-color/);
  assert.match(html, /aria-pressed="false"><span>每月定额定投/);
});

test("metric cards label contribution return separately from capital multiple", () => {
  const html = renderToStaticMarkup(React.createElement(ResultComparison, {
    locale: "zh",
    strategyRuns: [{ ...results[0], metrics: metrics("125.00") }],
    focusedResultId: results[0].id, onFocus() {},
  }));

  assert.match(html, /投入回报率/);
  assert.match(html, /资本倍数/);
  assert.match(html, /25%/);
  assert.match(html, /1\.25×/);
  assert.match(html, /12%/);
  assert.match(html, /最大回撤/);
});

test("unavailable optional metrics render as unavailable rather than zero", () => {
  const html = renderToStaticMarkup(React.createElement(ResultComparison, {
    locale: "ja",
    strategyRuns: [{ ...results[0], metrics: { ...metrics("125"), xirr: null, maximumDrawdown: null } }],
    focusedResultId: results[0].id, onFocus() {},
  }));
  assert.match(html, /—/);
  assert.doesNotMatch(html, /NaN|undefined/);
  assert.ok((html.match(/>—<\/td>/g) ?? []).length >= 2);
});

test("legacy gross turnover is not presented as invested principal", () => {
  const html = renderToStaticMarkup(React.createElement(ResultComparison, {
    locale: "zh", strategyRuns: [{ ...results[0], metrics: { ...metrics("125"), investmentBasis: "buy_turnover", actualInvested: "500" } }],
    focusedResultId: results[0].id, onFocus() {},
  }));
  assert.doesNotMatch(html, /\$500/);
  assert.match(html, /<td>—<\/td>/);
});

 test("comparison contains every performance field and short labels distinguish repeated presets", () => {
  const html = renderToStaticMarkup(React.createElement(ResultComparison, {
    locale: "zh", strategyRuns: [...results, { ...results[0], id: "second-vix" }],
    focusedResultId: "second-vix", onFocus() {},
  }));
  for (const label of ["已投入本金", "注入本金", "期末资产", "净盈亏", "投入回报率", "资本倍数", "年化回报", "最大回撤"]) assert.match(html, new RegExp(label));
  assert.match(html, /波动率信号定投 · 1/);
  assert.match(html, /波动率信号定投 · 2/);
});
