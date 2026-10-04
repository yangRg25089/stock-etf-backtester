import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { wireRun } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const { savedDataInformation } = require("../.test-output/features/results/dataInformation.js");

test("data information uses frozen dates, sources and distinct saved observations without treating false as missing", () => {
  const run = wireRun();
  run.snapshot.dataContext = { effectiveRun: { symbol: "QQQ", startDate: "2024-02-01", endDate: "2024-03-01" }, dataFingerprint: "loaded",
    dataProvenance: { sources: ["yahoo"], marketDataThrough: "2024-03-01", calendarAsOf: "2024-03-01" } };
  const result = run.result.strategyRuns[0];
  result.dailyAssets = [{ date: "2024-02-01", currency: "USD" }, { date: "2024-03-01", currency: "USD" }];
  result.signals = [
    { date: "2024-02-01", signalId: "vix.buy", conditionKind: "vix", sourceSymbol: "^VIX", observedValue: "20", state: "false", observedUnit: "index_points" },
    { date: "2024-02-01", signalId: "vix.exit.low1", conditionKind: "vix", sourceSymbol: "^VIX", observedValue: "20", state: "false", observedUnit: "index_points" },
    { date: "2024-03-01", signalId: "vix.buy", conditionKind: "vix", sourceSymbol: "^VIX", observedValue: "30", state: "true", observedUnit: "index_points" },
  ];
  const before = JSON.stringify(run);
  const info = savedDataInformation(run);
  assert.equal(info.symbol, "QQQ");
  assert.deepEqual(info.sources, ["yahoo"]);
  assert.deepEqual(info.requested, { start: "2024-01-01", end: "2024-03-01" });
  assert.deepEqual(info.actual, { start: "2024-02-01", end: "2024-03-01" });
  assert.equal(info.sessions, 2);
  assert.equal(info.currency, "USD");
  assert.equal(info.series[0].available, 2);
  assert.equal(info.series[0].total, 2);
  assert.equal(JSON.stringify(run), before);
});

test("missing PE and unknown loaded context retain their saved reason without fabricating providers or zero coverage", () => {
  const run = wireRun();
  const result = run.result.strategyRuns[0];
  result.status = "unavailable";
  result.metrics = null;
  result.diagnostics = [{ code: "required_data_unavailable", messageKey: "valuation.source_unconfigured", severity: "error", fieldPath: "pe.buyEnabled", details: { symbol: "QQQ", dataKind: "valuation" } }];
  run.snapshot.config.strategies[0].rules = { buy: { type: "condition", id: "pe", kind: "pe", params: {} } };
  run.snapshot.dataFingerprint = null;
  const info = savedDataInformation(run);
  assert.equal(info.sessions, null);
  assert.equal(info.actual, null);
  assert.deepEqual(info.sources, []);
  assert.equal(info.series[0].kind, "pe");
  assert.equal(info.series[0].total, null);
  assert.equal(info.series[0].diagnostics[0].messageKey, "valuation.source_unconfigured");
});
