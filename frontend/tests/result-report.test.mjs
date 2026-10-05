import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildResultReport, isResultReportAvailable, wrapReportText, reportBitmapSize } = require("../.test-output/features/results/reportModel.js");
const catalog = JSON.parse(readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"));

function saved() {
  const result = {
    id: "strategy-one", presetId: "vix_dca", role: "strategy", status: "completed", diagnostics: [],
    metrics: { totalContributed: "100", actualInvested: "100", investmentBasis: "original_principal", endingEquity: "120", netProfit: "20", returnOnContributions: "0.2", capitalMultiple: "1.2", xirr: "0.1", maximumDrawdown: "0.05", currency: "USD", analysis: { monthlyReturns: [{ year: 2024, month: 1, navReturn: "0.1", startDate: "2024-01-02", endDate: "2024-01-03" }], annualReturns: [{ year: 2024, navReturn: "0.1", startDate: "2024-01-02", endDate: "2024-01-03" }] } },
    dailyAssets: [
      { date: "2024-01-02", simulationPrice: "100", totalAsset: "100", totalContributed: "100", drawdown: "0", currency: "USD" },
      { date: "2024-01-03", simulationPrice: "110", totalAsset: "120", totalContributed: "100", drawdown: "-0.05", currency: "USD" },
    ],
    trades: [{ date: "2024-01-03", side: "buy", reason: "signal_buy", cashAmount: "100", price: "110", quantity: "0.909", currency: "USD" }],
  };
  const strategy = { id: result.id, presetId: "vix_dca", params: { "accumulation.cashSafetyLimit": 1200, "accumulation.maxSignalBuysPerMonth": 1 }, rules: { buy: { type: "condition", id: "buy-vix", kind: "vix", enabled: true, params: { "vix.symbol": "^VXN", "vix.buyThreshold": "25" } }, sell: { type: "group", id: "sell-root", enabled: false, operator: "OR", children: [] } } };
  const run = {
    runId: "saved-run", status: "completed", selectedStrategyIds: [result.id],
    snapshot: { runId: "saved-run", catalogVersion: catalog.version, dataFingerprint: "data-fingerprint", engineVersion: "engine-test", createdAt: "2024-01-04T00:00:00Z", config: { shared: { run: { symbol: "QQQ", startDate: "2024-01-01", endDate: "2024-01-03" }, contribution: { amount: "100", day: 1 } }, strategies: [strategy] } },
    result: { runId: "saved-run", strategyRuns: [result] },
  };
  return { run, result, strategy };
}

test("report uses saved metrics/config/full-range curves and detaches from later edits", () => {
  const { run, result, strategy } = saved();
  const report = buildResultReport(run, result, "zh", catalog);
  assert.equal(report.periodReturns.yearTitle, "年");
  assert.equal(report.periodReturns.annualTitle, "年度收益");
  assert.notEqual(report.periodReturns.monthly, result.metrics.analysis.monthlyReturns);
  assert.deepEqual(report.periodReturns.monthly, result.metrics.analysis.monthlyReturns);
  assert.ok(report);
  assert.equal(report.symbol, "QQQ");
  assert.equal(report.period, "2024-01-02 → 2024-01-03");
  assert.equal(report.metrics.find(item => item.key === "endingEquity").value, "US$120.00");
  assert.deepEqual(report.lines.find(item => item.id === result.id).points.map(p => p.indexValue), [100, 120]);
  const price = report.lines.find(item => item.id === "price").points;
  assert.equal(price[0].indexValue, 100);
  assert.ok(Math.abs(price[1].indexValue - 110) < 1e-12);
  assert.match(JSON.stringify(report.sections), /VXN/);
  assert.match(JSON.stringify(report.sections), /25/);
  strategy.rules.buy.params["vix.buyThreshold"] = 99;
  result.metrics.endingEquity = "900";
  assert.doesNotMatch(JSON.stringify(report), /99|\$900/);
  assert.equal(report.filename, "QQQ-vix_dca-2024-01-03-saved-run.png");
});

test("report eligibility permits zero trades and warning completion, rejects unfinished or foreign results", () => {
  const { run, result } = saved();
  for (const status of ["completed", "completed_with_warning"]) {
    result.status = status; result.trades = [];
    assert.equal(isResultReportAvailable(run, result), true);
    assert.equal(buildResultReport(run, result, "ja", catalog).tradeSummary, "買付 0 · 売却 0");
  }
  for (const status of ["queued", "loading", "running", "unavailable", "failed", "cancelled"]) {
    result.status = status;
    assert.equal(isResultReportAvailable(run, result), false);
    assert.equal(buildResultReport(run, result, "zh", catalog), null);
  }
  result.status = "completed";
  assert.equal(isResultReportAvailable(null, result), false);
  assert.equal(isResultReportAvailable(run, { ...result, id: "foreign" }), false);
  result.dailyAssets = [];
  assert.equal(isResultReportAvailable(run, result), false);
});

test("a saved search candidate uses its own identity, values and metrics", () => {
  const { run, result, strategy } = saved();
  result.presetId = strategy.presetId = "grid_search";
  const candidate = structuredClone(result);
  candidate.id = "candidate-two";
  candidate.metrics.endingEquity = "135";
  result.searchResult = { strategyId: result.id, dimensions: [{ key: "vix.buyThreshold", values: [25, 30] }], totalCandidateCount: 2, rankedCandidateIds: ["candidate-two"], candidates: [{ candidateId: "candidate-two", sequence: 2, status: "completed", parameterValues: { "vix.buyThreshold": "30" }, metrics: candidate.metrics }] };
  const report = buildResultReport(run, candidate, "zh", catalog, result);
  assert.match(report.title, /#2/);
  assert.match(report.filename, /candidate-two/);
  assert.equal(report.resultId, "candidate-two");
  assert.equal(report.metrics.find(item => item.key === "endingEquity").value, "US$135.00");
  assert.match(JSON.stringify(report.sections), /30/);
  assert.doesNotMatch(JSON.stringify(report.sections), /99/);
  assert.equal(isResultReportAvailable(run, { ...candidate, id: "unknown" }, result), false);
});

test("legacy missing principal stays unavailable and unknown condition fields are preserved", () => {
  const { run, result, strategy } = saved();
  result.metrics.investmentBasis = "buy_turnover";
  result.metrics.actualInvested = "999";
  result.dailyAssets.forEach(row => delete row.totalContributed);
  strategy.rules.buy.params["future.test"] = "<script>hello</script>";
  const report = buildResultReport(run, result, "ja", catalog);
  assert.equal(report.metrics.find(item => item.key === "actualInvested").value, "—");
  assert.ok(!report.lines.some(item => item.id === result.id));
  assert.ok(report.notes.length > 0);
  assert.match(JSON.stringify(report.sections), /future.test/);
  assert.doesNotMatch(report.filename, /[<>/\\]/);
});

test("measured wrapping keeps long CJK/ASCII text and bitmap size respects memory limits", () => {
  const content = "长名称ABCDEFGHIJKLMNOPQRSTUVWXYZ\n第二行说明";
  const lines = wrapReportText(content, 60, text => [...text].length * 10);
  assert.ok(lines.every(line => [...line].length <= 6));
  assert.equal(lines.join(""), content.replace(/\n/g, ""));
  const bitmap = reportBitmapSize(1200, 11000);
  assert.ok(bitmap.width * bitmap.height <= 16000000);
  assert.ok(bitmap.height <= 16384);
  assert.ok(bitmap.scale > 0);
});

test("normal reports resolve the identity against the canonical run instead of accepting stale same-id data", () => {
  const { run, result } = saved();
  const stale = structuredClone(result);
  stale.metrics.endingEquity = "900";
  assert.equal(buildResultReport(run, stale, "zh", catalog).metrics.find(item => item.key === "endingEquity").value, "US$120.00");
  result.status = "running";
  assert.equal(isResultReportAvailable(run, stale), false);
});

test("reports include frozen execution assumptions and saved costs without changing net KPI values", () => {
  const { run, result } = saved();
  run.snapshot.config.shared.execution = { commission: "2", slippagePct: "0.1", spreadPct: "0.2", fractionalShares: false };
  result.metrics.tradingCosts = { commission: "4", slippageCost: "0.25", spreadCost: "0.25", totalTradingCost: "4.50" };
  const report = buildResultReport(run, result, "zh", catalog);
  const execution = report.sections.find(section => section.title === "成交假设");
  const costs = report.sections.find(section => section.title === "交易成本");
  assert.equal(execution.lines.length, 4);
  assert.match(execution.lines.join(" "), /US\$2\.00.*USD/);
  assert.match(execution.lines.join(" "), /0\.1 %/);
  assert.match(execution.lines.join(" "), /0\.2 %/);
  assert.match(execution.lines.join(" "), /已停用/);
  assert.equal(costs.lines.length, 5);
  assert.match(costs.lines.at(-1), /US\$4\.50.*USD/);
  assert.equal(report.metrics.find(item => item.key === "netProfit").value, "US$20.00");
  const frozen = JSON.stringify(report.sections);
  run.snapshot.config.shared.execution.commission = "99";
  result.metrics.tradingCosts.totalTradingCost = "100";
  assert.equal(JSON.stringify(report.sections), frozen);
});
