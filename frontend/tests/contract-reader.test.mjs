import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { wireRun } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const { isRunResponse, isBoundedJson, isNumericSearchValue } = require("../.test-output/api/contractReader.js");

test("Decimal text budgets use effective exponent including fractional places", () => {
  for (const value of ["0.1e-4096", `0.${"0".repeat(4096)}1`, "1e-4097", "NaN", " 1 "]) assert.equal(isNumericSearchValue(value), false, value.slice(0, 30));
  for (const value of ["1e-4096", "0.1e-4095", `0.${"0".repeat(4095)}1`, "1.00e-4094", "25.00"]) assert.equal(isNumericSearchValue(value), true, value.slice(0, 30));
});
const { fetchRun, fetchActiveRun, RunApiError } = require("../.test-output/api/runs.js");

test("response aggregate status and selected strategy outcomes are checked at the wire boundary", () => {
  const good = wireRun();
  assert.equal(isRunResponse(good), true);
  for (const mutate of [
    run => { run.result.strategyRuns = []; },
    run => { run.result.strategyRuns[0].status = "queued"; run.result.strategyRuns[0].metrics = null; },
    run => { run.result.status = "queued"; },
    run => { run.status = "completed_with_warning"; },
    run => { run.result.strategyRuns[0].role = "benchmark"; },
  ]) {
    const bad = structuredClone(good);
    mutate(bad);
    assert.equal(isRunResponse(bad), false);
  }
  const partial = wireRun("partial", "completed_with_warning", ["first", "second"]);
  partial.result.strategyRuns[0].status = "completed";
  Object.assign(partial.result.strategyRuns[1], { status: "unavailable", metrics: null, diagnostics: [{ code: "required_data_unavailable", severity: "error", messageKey: "data.missing" }] });
  assert.equal(isRunResponse(partial), true);
  partial.status = "failed";
  assert.equal(isRunResponse(partial), false);
});

test("execution spread constraints and cost signs preserve exact small decimals", () => {
  const run = wireRun();
  const settings = { commission: "0", slippagePct: "60", spreadPct: "80", fractionalShares: true };
  run.snapshot.config.shared.execution = settings;
  assert.equal(isRunResponse(run), false);
  settings.slippagePct = "59.999999999999999999999999999";
  assert.equal(isRunResponse(run), true);
  settings.commission = "-1e-1000";
  assert.equal(isRunResponse(run), false);
  settings.commission = "0";
  const costs = { commission: "0", slippageCost: "-1e-1000", spreadCost: "0", totalTradingCost: "0" };
  run.result.strategyRuns[0].metrics.tradingCosts = costs;
  assert.equal(isRunResponse(run), false);
  costs.slippageCost = "0";
  assert.equal(isRunResponse(run), true);
});

test("saved analysis rejects out-of-range exact decimal values without rounding valid boundaries", () => {
  const run = wireRun();
  const metrics = run.result.strategyRuns[0].metrics;
  assert.equal(isRunResponse(run), true);
  metrics.analysis = { analysisMethod: "unit-nav-v1", tradingDaysPerYear: 252, durationUnit: "calendar_days",
    riskFreeAnnualRate: "0.05", buyCount: 0, sellCount: 0 };
  assert.equal(isRunResponse(run), true);
  for (const [key, value] of [["riskFreeAnnualRate", "-1"], ["annualizedReturn", "-1.00000000000000001"],
    ["annualizedVolatility", "-1e-1000"], ["turnover", "-0.001"], ["averageCashRatio", "1.00000000000000001"],
    ["averageCashRatio", "-1e-1000"], ["buyCount", -1], ["recoveryDuration", -1]]) {
    const bad = structuredClone(run);
    bad.result.strategyRuns[0].metrics.analysis[key] = value;
    assert.equal(isRunResponse(bad), false, `${key}=${value}`);
  }
  metrics.analysis.riskFreeAnnualRate = "-0.99999999999999999999999";
  metrics.analysis.annualizedReturn = "-1";
  metrics.analysis.annualizedVolatility = "1e-1000";
  metrics.analysis.averageCashRatio = "1";
  assert.equal(isRunResponse(run), true);
  metrics.analysis.averageCashRatio = null;
  assert.equal(isRunResponse(run), true);
});

test("saved periods and drawdown episodes reject inconsistent dates, ranks and conditional fields", () => {
  const run = wireRun();
  const period = { year: 2024, month: null, startDate: "2024-02-01", endDate: "2024-02-02", navReturn: "0.1", priceReturn: "0.2" };
  run.result.strategyRuns[0].metrics.analysis = { analysisMethod: "unit-nav-v1", tradingDaysPerYear: 252, durationUnit: "calendar_days",
    riskFreeAnnualRate: "0", buyCount: 0, sellCount: 0, annualReturns: [period], monthlyReturns: [{ ...period, month: 2 }],
    drawdownEpisodes: [{ peakDate: "2024-01-01", bottomDate: "2024-01-02", recoveredDate: "2024-01-03", endDate: "2024-01-03",
      drawdown: "-0.1", durationDays: 2, recoveryDays: 1, state: "recovered" }] };
  assert.equal(isRunResponse(run), true);
  for (const mutate of [
    value => { value.annualReturns[0].month = 2; },
    value => { value.monthlyReturns[0].month = null; },
    value => { value.monthlyReturns[0].year = 2023; },
    value => { value.monthlyReturns[0].navReturn = null; },
    value => { value.monthlyReturns[0].priceReturn = "-1.000000000000000001"; },
    value => { value.monthlyReturns.push(value.monthlyReturns[0]); },
    value => { value.drawdownEpisodes[0].recoveredDate = "2024-01-02"; },
    value => { value.drawdownEpisodes[0].durationDays = 3; },
    value => { value.drawdownEpisodes[0].drawdown = "0"; },
    value => { value.drawdownEpisodes[0].state = "ongoing"; },
  ]) {
    const invalid = structuredClone(run);
    mutate(invalid.result.strategyRuns[0].metrics.analysis);
    assert.equal(isRunResponse(invalid), false);
  }
});

test("saved trade explanation fields remain optional and reject invalid balances and prices", () => {
  const run = wireRun();
  const trade = { date: "2024-02-01", side: "buy", reason: "signal_buy", quantity: "1.25", price: "80", cashAmount: "100", currency: "USD" };
  run.result.strategyRuns[0].trades = [trade];
  assert.equal(isRunResponse(run), true);
  Object.assign(trade, { cashBefore: "100", cashAfter: "0", quantityBefore: "2", quantityAfter: "3.25", executionBasePrice: "80", executionPrice: "80" });
  assert.equal(isRunResponse(run), true);
  for (const key of ["cashBefore", "cashAfter", "quantityBefore", "quantityAfter", "executionBasePrice", "executionPrice"]) {
    const previous = trade[key];
    trade[key] = "-1";
    assert.equal(isRunResponse(run), false, key);
    trade[key] = previous;
  }
  trade.executionPrice = "81";
  assert.equal(isRunResponse(run), false);
  trade.executionPrice = "8e1";
  assert.equal(isRunResponse(run), true);
  trade.executionPrice = "80.00000000000000001";
  assert.equal(isRunResponse(run), false);
});

test("runtime reader accepts the contract and rejects malformed search and signal structures", () => {
  const run = wireRun();
  assert.equal(isRunResponse(run), true);
  run.result.strategyRuns[0].searchResult = {};
  assert.equal(isRunResponse(run), false);
  delete run.result.strategyRuns[0].searchResult;
  run.result.strategyRuns[0].signals = [{ date: "2024-02-01", state: "true", observedValue: "30" }];
  assert.equal(isRunResponse(run), false);
});
test("reader rejects mismatched identities, impossible dates and excessive numeric strings", () => {
  const run = wireRun();
  run.snapshot.runId = "other";
  assert.equal(isRunResponse(run), false);
  run.snapshot.runId = run.runId;
  run.snapshot.config.shared.run.startDate = "2024-02-31";
  assert.equal(isRunResponse(run), false);
  run.snapshot.config.shared.run.startDate = "2024-01-01";
  run.result.strategyRuns[0].metrics.endingEquity = "9".repeat(400);
  assert.equal(isRunResponse(run), false);
  assert.equal(isBoundedJson(JSON.parse('{"__proto__":{"bad":true}}')), false);
});
test("historical descriptions fit the bound without accepting arbitrarily large strings", () => {
  const run = wireRun();
  run.snapshot.config.strategies[0].params["future.note"] = "SOURCE_VALIDATION_".repeat(1500);
  assert.equal(isRunResponse(run), true);
  run.snapshot.config.strategies[0].params["future.note"] = "x".repeat(65_537);
  assert.equal(isRunResponse(run), false);
});
test("successful HTTP JSON is checked before entering result state; active never restores terminal data", async () => {
  const previous = globalThis.fetch;
  try {
    for (const payload of [{}, { ...wireRun(), result: { runId: "test-run", strategyRuns: [{ id: "one" }] } }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload));
      await assert.rejects(fetchRun("test-run"), error => error instanceof RunApiError && error.code === "invalid_response");
    }
    globalThis.fetch = async () => new Response(JSON.stringify(wireRun()));
    await assert.rejects(fetchActiveRun(), error => error instanceof RunApiError && error.code === "invalid_response");
  } finally { globalThis.fetch = previous; }
});

test("async submissions have no invented data identity and completed rows require loaded data", () => {
  const run = wireRun("queued-run", "queued");
  run.snapshot.submissionFingerprint = "submission-v1";
  run.snapshot.dataFingerprint = null;
  run.snapshot.dataProvenance = {};
  run.snapshot.dateAdjustments = [];
  run.snapshot.dataContext = null;
  assert.equal(isRunResponse(run), true);
  delete run.snapshot.submissionFingerprint;
  assert.equal(isRunResponse(run), false);
  run.snapshot.submissionFingerprint = "submission-v1";
  run.snapshot.dataProvenance = { sources: ["not-loaded"] };
  assert.equal(isRunResponse(run), false);
  run.snapshot.dataProvenance = {};
  run.status = "completed";
  Object.assign(run.result.strategyRuns[0], wireRun().result.strategyRuns[0]);
  assert.equal(isRunResponse(run), false);
});

test("loaded context must match projections and only documented dates may resolve frozen inputs", () => {
  const run = wireRun();
  run.snapshot.submissionFingerprint = "submission-v1";
  run.snapshot.dateAdjustments = [{ field: "startDate", requestedDate: "2024-01-01", effectiveDate: "2024-01-31", reason: "market_available_from" }];
  run.snapshot.dataContext = { dataFingerprint: run.snapshot.dataFingerprint,
    dataProvenance: structuredClone(run.snapshot.dataProvenance),
    effectiveRun: { ...run.snapshot.config.shared.run, startDate: "2024-01-31" },
    dateAdjustments: structuredClone(run.snapshot.dateAdjustments) };
  assert.equal(isRunResponse(run), true);
  for (const mutate of [
    value => { value.snapshot.dataFingerprint = "forged"; },
    value => { value.snapshot.dataProvenance.sources = ["forged"]; },
    value => { value.snapshot.dateAdjustments = []; },
    value => { value.snapshot.dataContext.effectiveRun.symbol = "SPY"; },
    value => { value.snapshot.dataContext.effectiveRun.endDate = "2024-04-01"; },
    value => { value.snapshot.dataContext.dateAdjustments[0].requestedDate = "2020-01-01"; value.snapshot.dateAdjustments = structuredClone(value.snapshot.dataContext.dateAdjustments); },
    value => { value.snapshot.dataContext.dateAdjustments.push(value.snapshot.dataContext.dateAdjustments[0]); value.snapshot.dateAdjustments = structuredClone(value.snapshot.dataContext.dateAdjustments); },
  ]) {
    const invalid = structuredClone(run);
    mutate(invalid);
    assert.equal(isRunResponse(invalid), false);
  }
});
