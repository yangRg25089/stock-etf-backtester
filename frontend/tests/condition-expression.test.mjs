import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { formatConditionDisplayRule } = require("../.test-output/features/strategies/conditionExpression.js");
const { translate } = require("../.test-output/i18n/messages.js");
const catalog = require("../.test-output/catalog.json");

test("condition summaries use the catalog comparators, parameters, and sell tiers", () => {
  const vix = catalog.conditions.find(item => item.kind === "vix");
  const buy = formatConditionDisplayRule(vix.buyDisplayRule,
    { "vix.symbol": "^VIX", "vix.buyThreshold": 25 }, catalog.parameters, "en");
  assert.deepEqual(buy.clauses.map(clause => [clause.left, clause.operator, clause.right]), [
    ["VIX (^VIX)", "≥", "25"],
  ]);

  const sell = formatConditionDisplayRule(vix.sellDisplayRule, {
    "vix.symbol": "^VIX", "exit.vix.low1": 12, "exit.vix.ratio1": 0.2,
    "exit.vix.low2": 10, "exit.vix.ratio2": 0.5,
  }, catalog.parameters, "en");
  assert.equal(sell.logic, "OR");
  assert.deepEqual(sell.clauses.map(clause => [clause.operator, clause.right, clause.sellRatio]), [
    ["≤", "12", "20%"], ["≤", "10", "50%"],
  ]);
  assert.match(sell.note, /use the lower threshold tier/);
});

test("composite conditions spell out strict Bollinger VIX and moving-average comparisons", () => {
  const bollinger = catalog.conditions.find(item => item.kind === "bollinger");
  const sell = formatConditionDisplayRule(bollinger.sellDisplayRule, {
    "bollinger.period": 20, "bollinger.stddev": 2, "vix.symbol": "^VIX",
    "exit.bollinger.vixCeiling": 25, "exit.bollinger.ratio": 0.3,
  }, catalog.parameters, "zh");
  assert.equal(sell.logic, "AND");
  assert.equal(sell.clauses[0].operator, "≥");
  assert.equal(sell.clauses[0].right, "布林带上轨（20 个交易日，2σ）");
  assert.equal(sell.clauses[1].operator, "<");
  assert.equal(sell.clauses[1].right, "25");
  assert.equal(sell.sellRatio, "30%");

  const trend = catalog.conditions.find(item => item.kind === "ma_trend");
  const buy = formatConditionDisplayRule(trend.buyDisplayRule, { "ma.period": 50 }, catalog.parameters, "ja");
  assert.deepEqual(buy.clauses.map(clause => [clause.left, clause.operator, clause.right]), [
    ["終値", ">", "移動平均（50取引日）"],
  ]);

  const deviation = catalog.conditions.find(item => item.kind === "ma_deviation");
  const deviationBuy = formatConditionDisplayRule(deviation.buyDisplayRule, {
    "ma.period": 20, "ma.buyDeviationPct": -1,
  }, catalog.parameters, "zh");
  assert.match(deviationBuy.clauses[0].left, /20 个交易日窗口/);
  assert.equal(deviationBuy.clauses[0].operator, "≤");
  assert.equal(deviationBuy.clauses[0].right, "-1%");
});

test("condition labels and timing guidance are translated in Japanese, Chinese, and English", () => {
  for (const locale of ["ja", "zh", "en"]) {
    for (const key of [
      "conditions.triggerPrefix", "conditions.executionTiming", "conditions.calculationWindowSuffix",
      "conditions.ruleNote.vixSell",
      "conditions.operator.gt", "conditions.operator.gte", "conditions.operator.lt", "conditions.operator.lte",
      "conditions.metric.vix", "conditions.metric.rsi", "conditions.metric.maDeviation",
      "conditions.metric.close", "conditions.metric.movingAverage", "conditions.metric.bollingerLower",
      "conditions.metric.bollingerUpper", "conditions.metric.rate",
    ]) assert.notEqual(translate(locale, key), key, `${locale} is missing ${key}`);
  }
});
