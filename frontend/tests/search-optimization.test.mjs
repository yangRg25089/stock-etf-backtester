import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { catalog } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const { isCandidateForSearch } = require("../.test-output/features/results/candidateReader.js");
const { buildResultReport } = require("../.test-output/features/results/reportModel.js");
const { savedResultConfiguration, savedPeriodBenchmarks } = require("../.test-output/features/results/savedConfiguration.js");
const { isRunResponse } = require("../.test-output/api/contractReader.js");
const { searchOutcomes } = require("../.test-output/api/searchResults.js");
const fixture = JSON.parse(readFileSync(new URL("../.test-output/split-fixture.json", import.meta.url), "utf8"));

test("Train/Test domain saved API records preserve independent curves, reports and CSV identities", () => {
  const file = structuredClone(fixture.record);
  assert.ok(isRunResponse(file.result));
  const parent = file.result.result.strategyRuns.find(row => row.presetId === "grid_search");
  assert.equal(parent.searchResult.optimizationMode, "train_test");
  assert.equal(Object.keys(file.candidateDetails).length, 4);
  assert.equal(parent.searchResult.periodBenchmarks.length, 4);
  const candidates = parent.searchResult.candidates;
  for (const row of candidates) {
    const train = file.candidateDetails[row.candidateId], testing = file.candidateDetails[row.testResult.resultId];
    assert.equal(train.evaluationPeriod.phase, "train");
    assert.equal(testing.evaluationPeriod.phase, "test");
    assert.deepEqual(savedResultConfiguration(file.result, testing, parent).candidate, row);
    for (const result of [train, testing]) {
      const baselines = savedPeriodBenchmarks(file.result, result, parent);
      assert.equal(baselines.length, 2);
      assert.ok(baselines.every(baseline => baseline.evaluationPeriod.phase === result.evaluationPeriod.phase));
      const report = buildResultReport(file.result, result, "zh", catalog, parent);
      assert.ok(report);
      assert.match(report.title, result === train ? /训练/ : /测试/);
      const dates = result.dailyAssets.map(asset => asset.date);
      assert.ok(report.lines.every(line => line.points.every(point => dates.includes(point.date))));
    }
  }
  for (const result of [...file.result.result.strategyRuns, ...Object.values(file.candidateDetails)]) {
    for (const kind of ["summary", "daily-assets", "trades", "search-results"]) {
      const expected = fixture.csv[`${result.id}/${kind}`];
      if (expected !== undefined) assert.ok(expected.includes(result.id) || kind === "trades" && result.trades.length === 0 && expected.trim().split("\n").length === 1, `${result.id}/${kind}`);
    }
  }
});

test("split files reject missing/swapped test detail, mixed windows and malformed saved baselines", () => {
  for (const mutate of [
    file => { const row = file.result.result.strategyRuns.find(row => row.searchResult).searchResult.candidates[0]; delete file.candidateDetails[row.testResult.resultId]; },
    file => { const row = file.result.result.strategyRuns.find(row => row.searchResult).searchResult.candidates[0]; file.candidateDetails[row.testResult.resultId] = file.candidateDetails[row.candidateId]; },
    file => { file.result.result.strategyRuns.find(row => row.searchResult).searchResult.testPeriod.startDate = "2024-01-01"; },
    file => { file.result.result.strategyRuns.find(row => row.searchResult).searchResult.periodBenchmarks.pop(); },
    file => { file.result.result.strategyRuns.find(row => row.searchResult).searchResult.candidates[0].testResult.metrics.tradingCosts.commission = "-1"; },
    file => { file.result.result.strategyRuns.find(row => row.searchResult).searchResult.testPeriod.effectiveEndDate = "2024-12-31"; },
    file => { file.result.result.strategyRuns.find(row => row.searchResult).searchResult.dimensions[0].values = [true, false]; },
    file => { file.result.result.strategyRuns.find(row => row.searchResult).searchResult.dimensions[0].values = ["20", "20.00"]; },
    file => { const dimensions = file.result.result.strategyRuns.find(row => row.searchResult).searchResult.dimensions; dimensions.push(structuredClone(dimensions[0])); },
  ]) {
    const file = structuredClone(fixture.record);
    mutate(file);
    assert.ok(!isRunResponse(file.result) || searchOutcomes(file.result.result.strategyRuns.find(row => row.searchResult).searchResult).some(row => !isCandidateForSearch(file.candidateDetails[row.id], file.result.result.strategyRuns.find(row => row.searchResult), row.id)));
  }
});

test("training ranks and costs are preserved independently of test status", () => {
  const run = structuredClone(fixture.record.result);
  const search = run.result.strategyRuns.find(row => row.searchResult).searchResult;
  const ranks = [...search.rankedCandidateIds];
  const original = JSON.stringify(search.candidates[0].metrics);
  search.candidates[0].testResult = { resultId: search.candidates[0].testResult.resultId,
    status: "unavailable", diagnostics: [{ code: "no_valid_contribution", severity: "error", messageKey: "calendar.no_valid_contribution" }] };
  assert.ok(isRunResponse(run));
  assert.deepEqual(search.rankedCandidateIds, ranks);
  assert.equal(JSON.stringify(search.candidates[0].metrics), original);
});
