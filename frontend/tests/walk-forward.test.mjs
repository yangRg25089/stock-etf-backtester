import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { catalog } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const { readPackage } = require("../.test-output/features/files/packageModel.js");
const { importedCsv } = require("../.test-output/features/results/importedCsv.js");
const { savedResultConfiguration, savedPeriodBenchmarks } = require("../.test-output/features/results/savedConfiguration.js");
const { buildResultReport } = require("../.test-output/features/results/reportModel.js");
const { explainTrade } = require("../.test-output/features/results/tradeExplanation.js");
const fixture = JSON.parse(readFileSync(new URL("../.test-output/walk-fixture.json", import.meta.url), "utf8"));

test("walk-forward files preserve OOS, every training detail, and byte-exact offline CSV", () => {
  const file = readPackage(structuredClone(fixture.package), catalog);
  const parent = file.result.result.strategyRuns.find(row => row.searchResult);
  const search = parent.searchResult;
  assert.equal(search.optimizationMode, "walk_forward");
  assert.equal(Object.keys(file.candidateDetails).length, 5);
  const oos = file.candidateDetails[search.outOfSample.resultId];
  assert.deepEqual(parent.metrics, oos.metrics);
  assert.deepEqual(parent.dailyAssets, oos.dailyAssets);
  assert.equal(savedResultConfiguration(file.result, oos, parent, "2020-12-31").parameters["vix.buyThreshold"], "20");
  assert.equal(savedResultConfiguration(file.result, oos, parent, "2021-01-02").parameters["vix.buyThreshold"], "30");
  assert.equal(savedPeriodBenchmarks(file.result, oos, parent).length, 2);
  for (const window of search.walkForwardWindows) {
    for (const id of window.candidateIds) {
      const detail = file.candidateDetails[id];
      assert.deepEqual(detail.evaluationPeriod, window.trainPeriod);
      assert.equal(savedPeriodBenchmarks(file.result, detail, parent).length, 0);
    }
  }
  const report = buildResultReport(file.result, oos, "zh", catalog, parent);
  assert.ok(report);
  assert.match(report.title, /滚动样本外/);
  assert.equal(report.lines.length, 4);
  assert.ok(report.sections.some(section => section.title.includes("2021-01-01")));
  const first = explainTrade(file.result, oos, 0, "zh", parent);
  assert.ok(JSON.stringify(first.conditions).includes("≥ 20"));
  for (const row of [...file.result.result.strategyRuns, ...Object.values(file.candidateDetails)]) {
    for (const kind of ["summary", "daily-assets", "trades", "search-results"]) {
      const expected = fixture.csv[`${row.id}/${kind}`];
      if (expected !== undefined) assert.equal(importedCsv(file.result, row, kind), expected, `${row.id}/${kind}`);
    }
  }
});

test("walk-forward files reject window gaps, missing OOS, invalid winners and swapped periods", () => {
  for (const mutate of [
    (file, search) => { delete file.candidateDetails[search.outOfSample.resultId]; },
    (file, search) => { search.walkForwardWindows[0].selectedCandidateId = search.walkForwardWindows[0].rankedCandidateIds[1]; },
    (file, search) => { search.walkForwardWindows[1].testPeriod.startDate = "2021-01-03"; },
    (file, search) => { search.walkForwardWindows[1].candidateIds = search.walkForwardWindows[0].candidateIds; },
    (file, search) => { search.periodBenchmarks.pop(); },
    (file, search) => { file.candidateDetails[search.candidates[0].candidateId].evaluationPeriod = search.outOfSamplePeriod; },
    (file, search) => { search.outOfSample.metrics.endingEquity = "100000000"; },
  ]) {
    const file = structuredClone(fixture.package), search = file.result.result.strategyRuns.find(row => row.searchResult).searchResult;
    mutate(file, search);
    assert.throws(() => readPackage(file, catalog));
  }
});
