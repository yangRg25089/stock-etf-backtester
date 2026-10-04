import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { catalog } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const { readPackage, readPackageFile, createStrategyPackage, packageDraft, packageBlob, MAX_PACKAGE_BYTES } = require("../.test-output/features/files/packageModel.js");
const { createInitialWorkspaceState } = require("../.test-output/features/strategies/model.js");
const { importedCsv } = require("../.test-output/features/results/importedCsv.js");
const fixture = JSON.parse(readFileSync(new URL("../.test-output/portable-fixture.json", import.meta.url), "utf8"));
const partialFixture = JSON.parse(readFileSync(new URL("../.test-output/partial-fixture.json", import.meta.url), "utf8"));

test("partial failures preserve failed raw inputs and successful results for correction", () => {
  const source = structuredClone(partialFixture.package);
  const original = JSON.stringify(source);
  const file = readPackage(source, catalog);
  assert.equal(file.result.status, "completed_with_warning");
  assert.equal(file.result.result.strategyRuns.find(row => row.id === "file-vix").status, "failed");
  assert.ok(file.result.result.strategyRuns.filter(row => row.metrics).length >= 3);
  assert.deepEqual(file, partialFixture.package);
  const draft = packageDraft(file, catalog);
  assert.equal(draft.strategies.find(row => row.id === "file-vix").params["vix.buyThreshold"], "not-numeric");
  assert.throws(() => createStrategyPackage(draft, catalog), error => error.messageKey === "files.invalidConfiguration");
  draft.strategies[0].params["vix.buyThreshold"] = 25;
  assert.equal(createStrategyPackage(draft, catalog).type, "strategy");
  assert.equal(JSON.stringify(source), original);
});

test("failed saved conditions remain correctable without relaxing depth or identity bounds", () => {
  const file = structuredClone(partialFixture.package);
  for (const config of [file.config, file.result.snapshot.config]) {
    config.strategies[0].params = {};
    config.strategies[0].rules = { buy: { type: "group", id: "root", operator: "AND", children: [
      { type: "condition", id: "first", kind: "vix", params: { "vix.buyThreshold": "bad" } },
      { type: "condition", id: "second", kind: "vix", params: {} },
    ] }, sell: null };
  }
  const loaded = readPackage(file, catalog);
  assert.deepEqual(packageDraft(loaded, catalog).strategies[0].rules, file.config.strategies[0].rules);
  for (const invalid of ["depth", "duplicate-id", "object-value"]) {
    const broken = structuredClone(file);
    for (const config of [broken.config, broken.result.snapshot.config]) {
      const rule = config.strategies[0].rules.buy;
      if (invalid === "depth") for (let i = 0; i < 10; i++) config.strategies[0].rules.buy = { type: "group", id: `depth-${i}`, children: [config.strategies[0].rules.buy] };
      if (invalid === "duplicate-id") rule.children[1].id = rule.children[0].id;
      if (invalid === "object-value") rule.children[0].params["vix.buyThreshold"] = { nested: "unsafe" };
    }
    assert.throws(() => readPackage(broken, catalog), error => error.messageKey === "files.invalidConfiguration");
  }
});

test("real domain serialization round-trips all candidate values and frozen configuration", () => {
  const file = readPackage(structuredClone(fixture.package), catalog);
  assert.deepEqual(file.result, fixture.package.result);
  assert.deepEqual(file.config, fixture.package.config);
  assert.deepEqual(file.candidateDetails, fixture.package.candidateDetails);
  const draft = packageDraft(file, catalog);
  draft.strategies[0].params["vix.buyThreshold"] = 99;
  assert.notEqual(file.config.strategies[0].params["vix.buyThreshold"], 99);
  assert.equal(packageBlob(file).type, "application/json");
});

test("v12 backtests load without fabricating saved analysis and default only the next editable draft", () => {
  const file = structuredClone(fixture.package);
  file.catalogVersion = file.result.snapshot.catalogVersion = "catalog-v12";
  delete file.config.shared.analysis;
  delete file.result.snapshot.config.shared.analysis;
  for (const result of [...file.result.result.strategyRuns, ...Object.values(file.candidateDetails)]) {
    delete result.metrics?.analysis;
    for (const candidate of result.searchResult?.candidates ?? []) delete candidate.metrics?.analysis;
  }
  const before = JSON.stringify(file);
  const loaded = readPackage(file, catalog);
  assert.deepEqual(loaded.result, file.result);
  assert.deepEqual(loaded.candidateDetails, file.candidateDetails);
  assert.equal(loaded.catalogVersion, "catalog-v12");
  assert.equal(packageDraft(loaded, catalog).shared.analysis.riskFreeAnnualRatePct, "0");
  assert.equal(JSON.stringify(file), before);
});

test("loaded dates restore and export consistently without changing original submitted configuration", () => {
  const file = structuredClone(fixture.package);
  const snapshot = file.result.snapshot;
  const effectiveRun = structuredClone(snapshot.config.shared.run);
  snapshot.config.shared.run.startDate = "2020-01-01";
  file.config.shared.run.startDate = "2020-01-01";
  snapshot.submissionFingerprint = "original-submission";
  snapshot.dateAdjustments = [{ field: "startDate", requestedDate: "2020-01-01", effectiveDate: effectiveRun.startDate, reason: "market_available_from" }];
  snapshot.dataContext = { dataFingerprint: snapshot.dataFingerprint, dataProvenance: snapshot.dataProvenance,
    effectiveRun, dateAdjustments: snapshot.dateAdjustments };
  const checked = readPackage(file, catalog);
  assert.equal(packageDraft(checked, catalog).shared.run.startDate, effectiveRun.startDate);
  assert.equal(checked.config.shared.run.startDate, "2020-01-01");
  const result = checked.result.result.strategyRuns[0];
  const [headers, values] = importedCsv(checked.result, result, "summary").trim().split("\n").map(line => line.split(","));
  assert.equal(values[headers.indexOf("startDate")], effectiveRun.startDate);
});

test("offline CSV matches the backend field order and exact Decimal output for every result/candidate", () => {
  const file = readPackage(fixture.package, catalog);
  const results = [...file.result.result.strategyRuns, ...Object.values(file.candidateDetails)];
  let count = 0;
  for (const result of results) for (const kind of ["summary", "daily-assets", "trades", "search-results"]) {
    const expected = fixture.csv[`${result.id}/${kind}`];
    if (expected !== undefined) { assert.equal(importedCsv(file.result, result, kind), expected, `${result.id}/${kind}`); count++; }
  }
  assert.ok(count >= 16);
});

test("CSV never treats ticker or identity strings as decimal exponents", () => {
  const run = structuredClone(fixture.package.result);
  run.runId = "1E3";
  run.snapshot.runId = run.result.runId = run.runId;
  run.snapshot.config.shared.run.symbol = "2E3";
  if (run.snapshot.dataContext) run.snapshot.dataContext.effectiveRun.symbol = "2E3";
  const result = run.result.strategyRuns[0];
  const csv = importedCsv(run, result, "summary").split("\n");
  const columns = csv[0].split(",");
  const row = csv[1].split(",");
  assert.equal(row[columns.indexOf("runId")], "1E3");
  assert.equal(row[columns.indexOf("symbol")], "2E3");
});

test("strategy files contain inputs without page/run state and importing does not mutate their source", () => {
  const state = createInitialWorkspaceState(catalog);
  const file = createStrategyPackage(state.draft, catalog);
  assert.deepEqual(Object.keys(file).sort(), ["catalogVersion", "draft", "exportedAt", "format", "schemaVersion", "type"]);
  state.draft.shared.run.symbol = "SPY";
  assert.equal(file.draft.shared.run.symbol, "QQQ");
  assert.equal(readPackage(file, catalog).type, "strategy");
});

for (const [name, mutate, key] of [
  ["wrong format", file => { file.format = "other"; }, "files.invalidFormat"],
  ["future schema", file => { file.schemaVersion = 2; }, "files.newerVersion"],
  ["unmigratable old schema", file => { file.schemaVersion = 0; }, "files.unsupportedVersion"],
  ["catalog mismatch", file => { file.catalogVersion = "other"; }, "files.incompatibleCatalog"],
  ["inconsistent frozen config", file => { file.config = structuredClone(file.config); file.config.shared.run.symbol = "SPY"; }, "files.invalidResult"],
  ["missing candidates", file => { file.candidateDetails = {}; }, "files.invalidCandidates"],
  ["foreign candidate identity", file => { Object.values(file.candidateDetails)[0].id = "foreign"; }, "files.invalidCandidates"],
  ["invalid search structure", file => { file.result.result.strategyRuns[1].searchResult = {}; }, "files.invalidResult"],
  ["null candidate parameters", file => { file.result.result.strategyRuns[1].searchResult.candidates[0].parameterValues = null; }, "files.invalidResult"],
  ["array candidate parameters", file => { file.result.result.strategyRuns[1].searchResult.candidates[0].parameterValues = []; }, "files.invalidResult"],
  ["text candidate parameters", file => { file.result.result.strategyRuns[1].searchResult.candidates[0].parameterValues = "invalid"; }, "files.invalidResult"],
  ["empty completed result collection", file => { file.result.result.strategyRuns = []; }, "files.invalidResult"],
  ["missing selected strategy outcome", file => { file.result.result.strategyRuns.splice(0, 1); }, "files.invalidResult"],
  ["completed envelope with queued children", file => { for (const row of file.result.result.strategyRuns) { row.status = "queued"; row.metrics = null; } }, "files.invalidResult"],
  ["inconsistent nested aggregate status", file => { file.result.result.status = "queued"; }, "files.invalidResult"],
  ["broken signal observation", file => { delete file.result.result.strategyRuns[0].signals[0].signalId; }, "files.invalidResult"],
  ["completed result without metrics", file => { file.result.result.strategyRuns[0].metrics = null; }, "files.invalidResult"],
  ["missing ranked candidate", file => { file.result.result.strategyRuns[1].searchResult.rankedCandidateIds = []; }, "files.invalidResult"],
  ["repeated candidate sequence", file => { file.result.result.strategyRuns[1].searchResult.candidates[1].sequence = 1; }, "files.invalidResult"],
  ["impossible export timestamp", file => { file.exportedAt = "2024-02-31T12:00:00Z"; }, "files.invalidFormat"],
  ["unsafe object property", file => { file.result.snapshot.config.shared.data = JSON.parse('{"__proto__":{}}'); }, "files.invalidFormat"],
]) test(`import rejects ${name} without changing the source`, () => {
  const source = structuredClone(fixture.package);
  mutate(source);
  assert.throws(() => readPackage(source, catalog), error => error.messageKey === key);
  assert.equal(fixture.package.format, "stock-etf-backtester");
});

test("file size is rejected before reading and malformed JSON has a precise failure", async () => {
  let read = false;
  await assert.rejects(readPackageFile({ size: MAX_PACKAGE_BYTES + 1, async text() { read = true; return "{}"; } }, catalog), error => error.messageKey === "files.tooLarge");
  assert.equal(read, false);
  await assert.rejects(readPackageFile({ size: 1, async text() { return "{"; } }, catalog), error => error.messageKey === "files.invalidJson");
});

test("condition depth, duplicate kinds and unsupported parameter keys are bounded by the catalog", () => {
  for (const mutate of [
    file => { file.draft.strategies[0].params["unregistered.key"] = 1; },
    file => { const root = file.draft.strategies[0].rules.buy; file.draft.strategies[0].rules.buy = { id: "duplicate-root", type: "group", children: [root, { ...root, id: "duplicate-leaf" }] }; },
    file => { for (let i = 0; i < 10; i++) file.draft.strategies[0].rules.buy = { id: `depth-${i}`, type: "group", children: [file.draft.strategies[0].rules.buy] }; },
  ]) {
    const file = createStrategyPackage(createInitialWorkspaceState(catalog).draft, catalog);
    mutate(file);
    assert.throws(() => readPackage(file, catalog), error => error.messageKey === "files.invalidConfiguration");
  }
});
