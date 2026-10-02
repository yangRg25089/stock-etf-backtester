import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createInitialWorkspaceState, workspaceReducer } = require("../.test-output/features/strategies/model.js");
const { restoreWorkspaceState, saveWorkspaceDraft } = require("../.test-output/features/strategies/workspacePersistence.js");
const catalog = JSON.parse(readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"));

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test("workspace browser storage restores shared and multi-strategy drafts without restoring a mutable result", () => {
  let state = createInitialWorkspaceState(catalog);
  state.draft.shared.run.symbol = "SMH";
  state.draft.shared.run.endDate = "2025-12-31";
  state.draft.strategies[0].params["vix.buyThreshold"] = "31";
  state.draft.strategies[0].rules.buy.params["vix.buyThreshold"] = "31";
  state = workspaceReducer(state, { type: "strategy.add", id: "strategy-ma_trend-2", presetId: "ma_trend" }, catalog);
  state.nextCustomNumber = 4;
  state.runResponse = { runId: "must-remain-independent" };
  const storage = new MemoryStorage();

  saveWorkspaceDraft(state, 8, storage);
  const raw = JSON.parse(storage.getItem("backtester.workspace.v1"));
  assert.equal("runResponse" in raw, false);
  const restored = restoreWorkspaceState(catalog, storage);

  assert.equal(restored.state.draft.shared.run.symbol, "SMH");
  assert.equal(restored.state.draft.shared.run.endDate, "2025-12-31");
  assert.equal(restored.state.draft.strategies[0].params["vix.buyThreshold"], "31");
  assert.equal(restored.state.draft.strategies[0].rules.buy.params["vix.buyThreshold"], "31");
  assert.deepEqual(restored.state.draft.strategies.map(({ id, presetId }) => ({ id, presetId })), [
    { id: "strategy-vix_dca-1", presetId: "vix_dca" },
    { id: "strategy-ma_trend-2", presetId: "ma_trend" },
  ]);
  assert.equal(restored.state.activeStrategyId, "strategy-ma_trend-2");
  assert.equal(restored.state.nextCustomNumber, 4);
  assert.equal(restored.nextStrategySequence, 8);
  assert.equal(restored.state.runResponse, null);
});

test("malformed or unknown workspace storage falls back to catalog defaults", () => {
  const storage = new MemoryStorage();
  storage.setItem("backtester.workspace.v1", "{invalid-json");
  const initial = createInitialWorkspaceState(catalog);
  const restored = restoreWorkspaceState(catalog, storage);
  assert.deepEqual(restored.state.draft, initial.draft);

  storage.setItem("backtester.workspace.v1", JSON.stringify({ version: 99, draft: {} }));
  assert.deepEqual(restoreWorkspaceState(catalog, storage).state.draft, initial.draft);
});

test("workspace restoration preserves nested custom conditions and uses fresh addition identities", () => {
  let state = createInitialWorkspaceState(catalog);
  state = workspaceReducer(state, { type: "strategy.add", id: "strategy-composite_dca-12", presetId: "composite_dca" }, catalog);
  const custom = state.draft.strategies.at(-1);
  custom.rules = { buy: { id: "nested-root", operator: "OR", children: [
    { id: "nested-group", operator: "AND", children: [
      { id: "vxn-leaf", kind: "vix", params: { "vix.symbol": "^VXN", "vix.buyThreshold": "33" }, enabled: false },
      { id: "ma-leaf", kind: "ma_trend", params: { "maTrend.fastPeriod": "50" } },
    ] },
  ] }, sell: null };
  const storage = new MemoryStorage();
  saveWorkspaceDraft(state, 3, storage);
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
  assert.equal(saveWorkspaceDraft(state, 2, storage), false);
});
