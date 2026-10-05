import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { wireRun } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const { explainTrade, explainUnexecutedSignal } = require("../.test-output/features/results/tradeExplanation.js");
const { savedResultConfiguration } = require("../.test-output/features/results/savedConfiguration.js");

function saved() {
  const run = wireRun();
  const result = run.result.strategyRuns[0];
  const strategy = run.snapshot.config.strategies[0];
  strategy.rules = { buy: { type: "group", id: "root", operator: "AND", children: [
    { type: "group", id: "nested", operator: "OR", children: [
      { type: "condition", id: "buy-vix", kind: "vix", params: { "vix.symbol": "^VIX", "vix.buyThreshold": "25" } },
      { type: "condition", id: "buy-rsi", kind: "rsi", params: { "rsi.period": 14, "rsi.buyThreshold": "30" } },
    ] },
  ] }, sell: { type: "condition", id: "sell-rsi", kind: "rsi", params: { "exit.rsi.threshold": "70", "exit.rsi.ratio": "0.5" } } };
  result.dailyAssets = [{ date: "2024-01-31" }, { date: "2024-02-01" }, { date: "2024-02-02" }];
  result.signals = [
    { date: "2024-01-31", signalId: "vix.buy", conditionId: "buy-vix", conditionKind: "vix", sourceSymbol: "^VIX", observedValue: "31.42", state: "true" },
    { date: "2024-01-31", signalId: "rsi.buy", conditionId: "buy-rsi", conditionKind: "rsi", observedValue: "45", state: "false" },
    { date: "2024-01-31", signalId: "conditions.buy:nested", conditionId: "nested", state: "true" },
    { date: "2024-01-31", signalId: "conditions.buy:root", conditionId: "root", state: "true" },
    { date: "2024-01-31", signalId: "accumulation.buy", state: "true" },
    { date: "2024-02-01", signalId: "vix.buy", conditionId: "buy-vix", conditionKind: "vix", observedValue: "10", state: "false" },
  ];
  result.trades = [{ date: "2024-02-01", side: "buy", reason: "signal_buy", quantity: "0.5", price: "200", cashAmount: "100", currency: "USD", signalId: "accumulation.buy",
    cashBefore: "100", cashAfter: "0", quantityBefore: "0", quantityAfter: "0.5", executionBasePrice: "200", executionPrice: "200" }];
  return { run, result, strategy };
}

test("trade explanation reads the previous saved session and keeps nested AND/OR and false observations", () => {
  const { run, result } = saved();
  const explanation = explainTrade(run, result, 0, "zh");
  assert.equal(explanation.trade, result.trades[0]);
  assert.equal(explanation.signalDate, "2024-01-31");
  assert.equal(explanation.conditions[0].operator, "AND");
  const nested = explanation.conditions[0].children[0];
  assert.equal(nested.operator, "OR");
  assert.equal(nested.children[0].expression, "31.42 ≥ 25");
  assert.equal(nested.children[1].expression, "45 ≤ 30");
  assert.equal(nested.children[1].state, "false");
  assert.equal(nested.children[0].sourceSymbol, "^VIX");
  assert.equal(explanation.trade.cashAfter, "0");
});

test("saved candidate parameter overrides apply without mutating the parent or mixing result identities", () => {
  const { run, result: parent, strategy } = saved();
  parent.presetId = strategy.presetId = "grid_search";
  const result = { ...parent, id: "candidate-2", searchResult: null };
  parent.searchResult = { dimensions: [{ key: "vix.buyThreshold", values: ["25", "30"] }], rankedCandidateIds: ["candidate-2"],
    candidates: [{ candidateId: "candidate-2", sequence: 2, parameterValues: { "vix.buyThreshold": "30" }, status: "completed" }] };
  const before = JSON.stringify(run);
  const explanation = explainTrade(run, result, 0, "zh", parent);
  assert.equal(explanation.conditions[0].children[0].children[0].expression, "31.42 ≥ 30");
  assert.equal(savedResultConfiguration(run, result, parent).candidate.sequence, 2);
  assert.equal(JSON.stringify(run), before);
});

test("sell explanations use saved ratios and legacy files show missing values without inventing balances", () => {
  const { run, result } = saved();
  result.signals.push({ date: "2024-02-01", signalId: "rsi.exit", conditionId: "sell-rsi", conditionKind: "rsi", observedValue: "75", state: "true", sellRatio: "0.5" });
  result.trades.push({ date: "2024-02-02", side: "sell", reason: "signal_sell", quantity: "0.25", price: "200", cashAmount: "50", currency: "USD", signalId: "rsi.exit" });
  const explanation = explainTrade(run, result, 1, "ja");
  assert.equal(explanation.sellRatio, "0.5");
  assert.equal(explanation.conditions[0].expression, "75 ≥ 70");
  assert.equal(explanation.trade.cashBefore, undefined);
  assert.equal(explainTrade(run, result, 100, "ja"), null);
  result.trades[0].reason = "fixed_dca";
  assert.deepEqual(explainTrade(run, result, 0, "ja").conditions, []);
});

test("unexecuted explanations select their exact signal date and retain the saved no-following-session reason", () => {
  const { run, result } = saved();
  const signal = { signalDate: "2024-02-01", signalId: "vix.buy:buy-vix", reason: "no_following_backtest_session" };
  const explanation = explainUnexecutedSignal(run, result, signal, "zh");
  assert.equal(explanation.signal, signal);
  assert.equal(explanation.conditions[0].children[0].children[0].expression, "10 ≥ 25");
  assert.equal(explanation.conditions[0].state, null);
});

test("MA and Bollinger explanations label saved price differences rather than treating them as indicator prices", () => {
  const { run, result, strategy } = saved();
  for (const kind of ["ma_trend", "bollinger"]) {
    strategy.rules.buy = { type: "condition", id: "rule", kind, params: { "ma.period": 200, "bollinger.period": 20, "bollinger.stddev": 2 } };
    result.signals = [{ date: "2024-01-31", signalId: "observed", conditionId: "rule", conditionKind: kind, observedValue: "-5", state: "true" }];
    const condition = explainTrade(run, result, 0, "zh").conditions[0];
    assert.match(condition.expression, kind === "ma_trend" ? /-5 > 0/ : /-5 ≤ 0/);
    assert.match(condition.label, kind === "ma_trend" ? /MA\(200\)/ : /BOLL\(20/);
  }
});
