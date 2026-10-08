import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { buildResultSelection } = require("../.test-output/features/results/buildResultSelection.js");
const { isCompletedResult } = require("../.test-output/features/results/model.js");
const { savedPeriodBenchmarks } = require("../.test-output/features/results/savedConfiguration.js");
const { resultColor } = require("../.test-output/features/results/colors.js");

test("empty selection does not invent a chart, markers, indicators or trade owner", () => {
  const selection = buildResultSelection({ run: null, focusedResult: null, candidateResult: null, selectedIds: [], orderedResults: [], locale: "ja" });
  assert.equal(selection.chartResult, undefined);
  assert.equal(selection.showFocusedAsset, false);
  assert.deepEqual(selection.selectedComparisons, []);
  assert.deepEqual(selection.technicalIndicators, []);
  assert.deepEqual(selection.volatility, []);
  assert.deepEqual(selection.strategyOrder, []);
  assert.equal(selection.findTradeResult("unknown"), undefined);
});

test("a search candidate keeps its detail owner but deselecting its parent removes the candidate curve and indicators", () => {
  const file = JSON.parse(readFileSync(new URL("../.test-output/portable-fixture.json", import.meta.url), "utf8")).record;
  const run = file.result;
  const parent = run.result.strategyRuns.find(result => result.searchResult);
  const candidateResult = Object.values(file.candidateDetails)[0];
  const selection = buildResultSelection({ run, focusedResult: parent, candidateResult, selectedIds: [], orderedResults: run.result.strategyRuns, locale: "ja" });
  assert.equal(selection.chartResult, candidateResult);
  assert.equal(selection.showFocusedAsset, false);
  assert.deepEqual(selection.technicalIndicators, []);
  assert.deepEqual(selection.volatility, []);
  assert.deepEqual(selection.selectedComparisons, []);
});

test("frozen selection projection preserves candidate ownership, matching-period benchmarks, ordering and colors", () => {
  for (const filename of ["portable-fixture", "split-fixture", "walk-fixture"]) {
    const path = new URL(`../.test-output/${filename}.json`, import.meta.url);
    const file = JSON.parse(readFileSync(path, "utf8")).record;
    const run = file.result;
    const results = run.result.strategyRuns;
    const parent = results.find(result => result.searchResult);
    const selectedIds = results.map(result => result.id);
    const orderedResults = [...results].reverse();
    const before = JSON.stringify(file);
    for (const candidateResult of [null, ...Object.values(file.candidateDetails)]) {
      const selection = buildResultSelection({ run, focusedResult: parent, candidateResult, selectedIds, orderedResults, locale: "zh" });
      const chart = candidateResult ?? parent;
      assert.equal(selection.chartResult, chart);
      assert.equal(selection.showFocusedAsset, true);
      assert.equal(selection.totalAssetColor, resultColor(results.indexOf(parent)));
      const baselines = savedPeriodBenchmarks(run, chart, parent);
      const expectedComparisons = results.filter(result => result.id !== parent.id && isCompletedResult(result))
        .flatMap(result => {
          const period = chart.evaluationPeriod;
          const matching = !period || (result.evaluationPeriod?.phase === period.phase && result.evaluationPeriod.startDate === period.startDate && result.evaluationPeriod.endDate === period.endDate);
          const displayed = period && result.role === "benchmark" ? baselines.find(row => row.presetId === result.presetId) : matching ? result : undefined;
          return displayed?.dailyAssets?.length ? [displayed] : [];
        });
      assert.deepEqual(selection.selectedComparisons.map(row => row.id), expectedComparisons.map(row => row.id));
      for (const [index, displayed] of expectedComparisons.entries()) {
        assert.equal(selection.selectedComparisons[index].dailyAssets, displayed.dailyAssets);
        assert.equal(selection.selectedComparisons[index].trades, displayed.trades);
        assert.equal(selection.findTradeResult(displayed.id), displayed);
      }
      for (const [index, result] of orderedResults.entries()) {
        const expected = candidateResult && result.id === parent.id ? candidateResult.id
          : chart.evaluationPeriod && result.role === "benchmark" ? baselines.find(row => row.presetId === result.presetId)?.id ?? result.id : result.id;
        assert.equal(selection.strategyOrder[index], expected);
      }
      if (candidateResult) assert.equal(selection.findTradeResult(candidateResult.id), candidateResult);
      assert.equal(selection.findTradeResult("unknown"), undefined);
      assert.equal(JSON.stringify(file), before);
    }
  }
});

test("no selection keeps price data available without showing focused assets or volatility", () => {
  const file = JSON.parse(readFileSync(new URL("../.test-output/portable-fixture.json", import.meta.url), "utf8")).record;
  const run = file.result;
  const results = run.result.strategyRuns;
  const focusedResult = results.find(isCompletedResult);
  const selection = buildResultSelection({ run, focusedResult, candidateResult: null, selectedIds: [], orderedResults: results, locale: "zh" });
  assert.equal(selection.chartResult, focusedResult);
  assert.equal(selection.showFocusedAsset, false);
  assert.deepEqual(selection.selectedComparisons, []);
  assert.deepEqual(selection.volatility, []);
  assert.deepEqual(selection.technicalIndicators, []);
});

test("a same-preset user strategy is never replaced with a period benchmark", () => {
  const file = JSON.parse(readFileSync(new URL("../.test-output/split-fixture.json", import.meta.url), "utf8")).record;
  const run = file.result;
  const parent = run.result.strategyRuns.find(row => row.searchResult);
  const candidateResult = Object.values(file.candidateDetails)[0];
  const user = structuredClone(run.result.strategyRuns.find(row => row.role === "benchmark"));
  user.id = "user-same-preset"; user.role = "strategy";
  run.result.strategyRuns.push(user);
  const select = () => buildResultSelection({ run, focusedResult: parent, candidateResult,
    selectedIds: [parent.id, user.id], orderedResults: run.result.strategyRuns, locale: "ja" });
  assert.deepEqual(select().selectedComparisons, []); // Full-run data cannot be compared with a partial evaluation.
  user.evaluationPeriod = structuredClone(candidateResult.evaluationPeriod);
  assert.deepEqual(select().selectedComparisons.map(row => row.id), [user.id]);
});
