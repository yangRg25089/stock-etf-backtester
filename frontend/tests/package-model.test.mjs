import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { catalog } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const { readPackage, readPackageFile, createStrategyPackage, packageDraft, packageBlob, MAX_PACKAGE_BYTES } = require("../.test-output/features/files/packageModel.js");
const { createInitialWorkspaceState, workspaceReducer } = require("../.test-output/features/strategies/model.js");
test("strategy files contain inputs without page/run state and importing does not mutate their source", () => {
  const state = createInitialWorkspaceState(catalog);
  const file = createStrategyPackage(state.draft, catalog);
  assert.deepEqual(Object.keys(file).sort(), ["catalogVersion", "draft", "exportedAt", "format", "schemaVersion", "type"]);
  state.draft.shared.run.symbol = "SPY";
  assert.equal(file.draft.shared.run.symbol, "QQQ");
  assert.equal(readPackage(file, catalog).type, "strategy");
});

function maximumInstanceDraft() {
  let state = createInitialWorkspaceState(catalog);
  for (let number = 2; number <= 5; number++) state = workspaceReducer(state, {
    type: "strategy.duplicate", sourceId: state.draft.strategies[0].id, id: `file-vix-${number}`,
  }, catalog);
  for (let number = 1; number <= 5; number++) state = workspaceReducer(state, {
    type: "strategy.add", presetId: "composite_dca", id: `file-custom-${number}`,
  }, catalog);
  return state.draft;
}

test("maximum-instance strategy JSON roundtrip preserves numbering and independent nested parameters", async () => {
  const draft = maximumInstanceDraft();
  assert.equal(draft.strategies.length, 10);
  draft.strategies[1].rules.buy.params["vix.buyThreshold"] = "31.234567890123456789";
  const original = JSON.stringify(draft);
  const exported = createStrategyPackage(draft, catalog);
  const loaded = readPackage(JSON.parse(await packageBlob(exported).text()), catalog);
  assert.deepEqual(packageDraft(loaded, catalog), exported.draft);
  assert.equal(new Set(loaded.draft.strategies.map(item => item.id)).size, 10);
  for (const presetId of ["vix_dca", "composite_dca"]) assert.deepEqual(
    loaded.draft.strategies.filter(item => item.presetId === presetId).map(item => item.instanceNumber), [1, 2, 3, 4, 5],
  );
  assert.equal(loaded.draft.strategies[1].rules.buy.params["vix.buyThreshold"], "31.234567890123456789");
  loaded.draft.strategies[0].rules.buy.params["vix.buyThreshold"] = "99";
  assert.equal(loaded.draft.strategies[1].rules.buy.params["vix.buyThreshold"], "31.234567890123456789");
  assert.equal(JSON.stringify(draft), original);
});

test("file readers enforce current per-preset and total limits without dropping excess strategies", () => {
  const valid = createStrategyPackage(maximumInstanceDraft(), catalog);
  for (const limit of ["per-preset", "total"]) {
    const file = structuredClone(valid);
    const extra = { ...structuredClone(file.draft.strategies[0]), id: "extra-vix", instanceNumber: 6 };
    if (limit === "per-preset") file.draft.strategies.pop();
    file.draft.strategies.push(extra);
    assert.throws(() => readPackage(file, catalog), error => error.messageKey === "files.invalidConfiguration");
    assert.equal(file.draft.strategies.length, limit === "per-preset" ? 10 : 11);
  }
  assert.equal(valid.draft.strategies.length, 10);
});

for (const [name, mutate, key] of [
  ["wrong format", file => { file.format = "other"; }, "files.invalidFormat"],
  ["removed result file type", file => { file.type = "backtest"; }, "files.invalidFormat"],
  ["unknown key", file => { file.result = {}; }, "files.invalidFormat"],
  ["future schema", file => { file.schemaVersion = 2; }, "files.newerVersion"],
  ["old schema", file => { file.schemaVersion = 0; }, "files.unsupportedVersion"],
  ["catalog mismatch", file => { file.catalogVersion = "other"; }, "files.incompatibleCatalog"],
  ["impossible timestamp", file => { file.exportedAt = "2024-02-31T12:00:00Z"; }, "files.invalidFormat"],
  ["unsafe object", file => { file.draft.shared.data = JSON.parse('{"__proto__":{}}'); }, "files.invalidFormat"],
]) test(`strategy import rejects ${name} without changing the source`, () => {
  const source = createStrategyPackage(createInitialWorkspaceState(catalog).draft, catalog);
  mutate(source);
  const before = JSON.stringify(source);
  assert.throws(() => readPackage(source, catalog), error => error.messageKey === key);
  assert.equal(JSON.stringify(source), before);
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
