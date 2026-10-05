import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { isRunResponse } = require("../.test-output/api/contractReader.js");
const record = JSON.parse(readFileSync(new URL("../.test-output/portable-fixture.json", import.meta.url), "utf8")).record;
for (const [name, mutate] of [
  ["empty completed results", run => { run.result.strategyRuns = []; }],
  ["missing selected result", run => { run.result.strategyRuns.splice(0, 1); }],
  ["queued completed children", run => { for (const row of run.result.strategyRuns) { row.status = "queued"; row.metrics = null; } }],
  ["inconsistent aggregate", run => { run.result.status = "queued"; }],
  ["broken signal", run => { delete run.result.strategyRuns[0].signals[0].signalId; }],
  ["missing metrics", run => { run.result.strategyRuns[0].metrics = null; }],
  ["missing ranking", run => { run.result.strategyRuns[1].searchResult.rankedCandidateIds = []; }],
  ["repeated candidate sequence", run => { run.result.strategyRuns[1].searchResult.candidates[1].sequence = 1; }],
  ...[null, [], "invalid"].map(value => ["invalid candidate params " + JSON.stringify(value), run => { run.result.strategyRuns[1].searchResult.candidates[0].parameterValues = value; }]),
  ["unsafe config", run => { run.snapshot.config.shared.data = JSON.parse('{"__proto__":{}}'); }],
]) test(`saved API contract rejects ${name} without changing input`, () => {
  const run = structuredClone(record.result); mutate(run);
  const before = JSON.stringify(run);
  assert.equal(isRunResponse(run), false);
  assert.equal(JSON.stringify(run), before);
});
