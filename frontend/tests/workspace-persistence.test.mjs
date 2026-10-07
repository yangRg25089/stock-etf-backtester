import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createInitialWorkspaceState, workspaceReducer } = require("../.test-output/features/strategies/model.js");
const { restoreWorkspaceState, saveLastRunStrategy } = require("../.test-output/features/strategies/workspacePersistence.js");
const { draftFromRun } = require("../.test-output/features/strategies/draftReader.js");
const catalog = JSON.parse(readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"));

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test("last partial run preserves bounded failed inputs until explicitly corrected and rerun", () => {
  const file = JSON.parse(readFileSync(new URL("../.test-output/partial-fixture.json", import.meta.url), "utf8")).record;
  const draft = draftFromRun(file.result, catalog);
  const failedIds = file.result.result.strategyRuns.filter(row => row.role === "strategy" && row.status === "failed").map(row => row.id);
  const storage = new MemoryStorage();
  assert.equal(saveLastRunStrategy(draft, catalog, storage, failedIds), true);
  assert.equal(restoreWorkspaceState(catalog, storage).state.draft.strategies[0].params["vix.buyThreshold"], "not-numeric");
  const key = "stock-etf-backtester.last-run-strategy.v1";
  const saved = JSON.parse(storage.getItem(key));
  assert.deepEqual(saved.failedStrategyIds, failedIds);
  for (const ids of [[...failedIds, "foreign-id"], [failedIds[0], failedIds[0]], "not-an-array"]) {
    storage.setItem(key, JSON.stringify({ ...saved, failedStrategyIds: ids }));
    assert.equal(restoreWorkspaceState(catalog, storage).state.draft.strategies[0].id, "strategy-vix_dca-1");
  }
  draft.strategies[0].params["vix.buyThreshold"] = 25;
  assert.equal(saveLastRunStrategy(draft, catalog, storage), true);
  assert.equal(Object.hasOwn(JSON.parse(storage.getItem(key)), "failedStrategyIds"), false);
});

test("last accepted configuration restores shared and multi-strategy inputs without editor or result state", () => {
  let state = createInitialWorkspaceState(catalog);
  state.draft.shared.run.symbol = "SMH";
  state.draft.shared.run.endDate = "2025-12-31";
  state.draft.strategies[0].params["vix.buyThreshold"] = "31";
  state.draft.strategies[0].rules.buy.params["vix.buyThreshold"] = "31";
  state = workspaceReducer(state, { type: "strategy.add", id: "strategy-ma_trend-2", presetId: "ma_trend" }, catalog);
  state.nextInstanceNumberByPreset = { vix_dca: 5, ma_trend: 4 };
  state.runResponse = { runId: "must-remain-independent" };
  const storage = new MemoryStorage();

  saveLastRunStrategy(state.draft, catalog, storage);
  const raw = JSON.parse(storage.getItem("stock-etf-backtester.last-run-strategy.v1"));
  assert.deepEqual(Object.keys(raw).sort(), ["catalogVersion", "draft", "savedAt", "schemaVersion"]);
  state.draft.shared.run.symbol = "SPY";
  const restored = restoreWorkspaceState(catalog, storage);

  assert.equal(restored.state.draft.shared.run.symbol, "SMH");
  assert.equal(restored.state.draft.shared.run.endDate, "2025-12-31");
  assert.equal(restored.state.draft.strategies[0].params["vix.buyThreshold"], "31");
  assert.equal(restored.state.draft.strategies[0].rules.buy.params["vix.buyThreshold"], "31");
  assert.deepEqual(restored.state.draft.strategies.map(({ id, presetId }) => ({ id, presetId })), [
    { id: "strategy-vix_dca-1", presetId: "vix_dca" },
    { id: "strategy-ma_trend-2", presetId: "ma_trend" },
  ]);
  assert.equal(restored.state.activeStrategyId, "strategy-vix_dca-1");
  assert.equal(restored.state.nextInstanceNumberByPreset.vix_dca, 2);
  assert.equal(restored.state.nextInstanceNumberByPreset.ma_trend, 2);
  assert.equal(restored.nextStrategySequence, 3);
  assert.equal(restored.state.runResponse, null);
});

test("malformed or unknown workspace storage falls back to catalog defaults", () => {
  const storage = new MemoryStorage();
  storage.setItem("stock-etf-backtester.last-run-strategy.v1", "{invalid-json");
  const initial = createInitialWorkspaceState(catalog);
  const restored = restoreWorkspaceState(catalog, storage);
  assert.deepEqual(restored.state.draft, initial.draft);

  storage.setItem("stock-etf-backtester.last-run-strategy.v1", JSON.stringify({ schemaVersion: 99, draft: {} }));
  assert.deepEqual(restoreWorkspaceState(catalog, storage).state.draft, initial.draft);
});

test("pre-v19 last-run inputs are rejected after the breaking catalog removal", () => {
  const draft = createInitialWorkspaceState(catalog).draft;
  draft.shared.run.symbol = "SPY";
  const storage = new MemoryStorage();
  const key = "stock-etf-backtester.last-run-strategy.v1";
  const saved = JSON.stringify({ schemaVersion: 1, catalogVersion: "catalog-v12", savedAt: "2026-10-04T00:00:00Z", draft });
  storage.setItem(key, saved);
  const restored = restoreWorkspaceState(catalog, storage);
  assert.equal(restored.state.draft.shared.run.symbol, "QQQ");
  assert.equal(restored.state.draft.shared.analysis.riskFreeAnnualRatePct, "0");
  assert.equal(restored.state.runResponse, null);
  assert.equal(storage.getItem(key), saved);
});

test("workspace restoration preserves nested custom conditions and uses fresh addition identities", () => {
  let state = createInitialWorkspaceState(catalog);
  state = workspaceReducer(state, { type: "strategy.add", id: "strategy-composite_dca-12", presetId: "composite_dca" }, catalog);
  const custom = state.draft.strategies.at(-1);
  custom.rules = { buy: { id: "nested-root", operator: "OR", children: [
    { id: "nested-group", operator: "AND", children: [
      { id: "vxn-leaf", kind: "vix", params: { "vix.symbol": "^VXN", "vix.buyThreshold": "33" }, enabled: false },
      { id: "ma-leaf", kind: "ma_trend", params: { "ma.period": "50" } },
    ] },
  ] }, sell: null };
  const storage = new MemoryStorage();
  saveLastRunStrategy(state.draft, catalog, storage);
  const restored = restoreWorkspaceState(catalog, storage);
  assert.deepEqual(restored.state.draft.strategies.at(-1).rules, custom.rules);
  assert.equal(restored.nextStrategySequence, 13);
  const added = workspaceReducer(restored.state, { type: "strategy.add", id: "strategy-composite_dca-13", presetId: "composite_dca" }, catalog);
  assert.equal(added.draft.strategies.at(-1).instanceNumber, 2);
  assert.equal(new Set(added.draft.strategies.map(item => item.id)).size, 3);
});

test("unavailable browser storage is handled without breaking the workspace", () => {
  const storage = { getItem() { throw new Error("storage denied"); }, setItem() { throw new Error("quota exceeded"); } };
  const state = createInitialWorkspaceState(catalog);
  assert.deepEqual(restoreWorkspaceState(catalog, storage).state.draft, state.draft);
  assert.equal(saveLastRunStrategy(state.draft, catalog, storage), false);
});
