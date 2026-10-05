import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { catalog } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const { createInitialWorkspaceState, createStrategyDraft, workspaceReducer } = require("../.test-output/features/strategies/model.js");

test("any strategy duplication deep-copies settings, allocates a per-preset number and leaves results untouched", () => {
  let state = createInitialWorkspaceState(catalog);
  const source = state.draft.strategies[0];
  source.params["vix.buyThreshold"] = "37";
  source.rules.buy.params["vix.buyThreshold"] = "37";
  const saved = { runId: "immutable-saved-result" };
  state = { ...state, runResponse: saved, selectedResultIds: ["old-result"] };
  const next = workspaceReducer(state, { type: "strategy.duplicate", sourceId: source.id, id: "vix-2" }, catalog);
  const copied = next.draft.strategies[1];
  assert.equal(copied.id, "vix-2");
  assert.equal(copied.instanceNumber, 2);
  assert.deepEqual(copied.params, source.params);
  assert.deepEqual(copied.rules, source.rules);
  assert.notEqual(copied.params, source.params);
  assert.notEqual(copied.rules, source.rules);
  copied.params["vix.buyThreshold"] = "50";
  copied.rules.buy.params["vix.buyThreshold"] = "99";
  assert.equal(source.params["vix.buyThreshold"], "37");
  assert.notEqual(source.rules.buy.params["vix.buyThreshold"], "99");
  assert.equal(next.runResponse, saved);
  assert.equal(next.selectedResultIds, state.selectedResultIds);
  assert.equal(next.activeStrategyId, copied.id);
  const removed = workspaceReducer(next, { type: "strategy.remove", id: copied.id }, catalog);
  const again = workspaceReducer(removed, { type: "strategy.duplicate", sourceId: source.id, id: "vix-3" }, catalog);
  assert.equal(again.draft.strategies[1].instanceNumber, 3);
});

test("duplication rejects unknown sources, ID collisions, per-type limits and total limit", () => {
  let state = createInitialWorkspaceState(catalog);
  assert.equal(workspaceReducer(state, { type: "strategy.duplicate", sourceId: "missing", id: "copy" }, catalog), state);
  for (let index = 2; index <= catalog.strategyLimits.maxInstancesPerPreset; index++) {
    state = workspaceReducer(state, { type: "strategy.add", presetId: "vix_dca", id: `vix-${index}` }, catalog);
  }
  assert.equal(workspaceReducer(state, { type: "strategy.duplicate", sourceId: "strategy-vix_dca-1", id: "beyond-limit" }, catalog), state);
  assert.equal(workspaceReducer(state, { type: "strategy.duplicate", sourceId: "strategy-vix_dca-1", id: "vix-2" }, catalog), state);
  for (let index = 1; state.draft.strategies.length < catalog.strategyLimits.maxTotalInstances; index++) {
    state = workspaceReducer(state, { type: "strategy.add", presetId: "rsi_dca", id: `rsi-${index}` }, catalog);
  }
  assert.equal(workspaceReducer(state, { type: "strategy.duplicate", sourceId: "strategy-vix_dca-1", id: "blocked-copy" }, catalog), state);
});

test("every selectable preset can be copied with an independent identity and next type ordinal", () => {
  for (const preset of catalog.presets.filter(item => !["monthly_dca", "lump_sum"].includes(item.id))) {
    let state = createInitialWorkspaceState(catalog);
    let source = state.draft.strategies[0];
    if (preset.id !== source.presetId) {
      state = workspaceReducer(state, { type: "strategy.add", presetId: preset.id, id: `${preset.id}-first` }, catalog);
      source = state.draft.strategies.at(-1);
    }
    const copied = workspaceReducer(state, { type: "strategy.duplicate", sourceId: source.id, id: `${preset.id}-second` }, catalog);
    const item = copied.draft.strategies.at(-1);
    assert.equal(item.presetId, preset.id);
    assert.equal(item.instanceNumber, 2);
    assert.notEqual(item.id, source.id);
    assert.deepEqual(item.params, source.params);
    assert.notEqual(item.params, source.params);
    assert.deepEqual(item.rules, source.rules);
    assert.notEqual(item.rules, source.rules);
  }
});

test("reset uses catalog defaults while retaining identity, custom numbering and saved outputs", () => {
  for (const presetId of ["vix_dca", "composite_dca", "ma_trend", "grid_search"]) {
    let state = createInitialWorkspaceState(catalog);
    const edited = createStrategyDraft(catalog, presetId, "edited");
    edited.instanceNumber = presetId === "composite_dca" ? 7 : undefined;
    edited.params["accumulation.cashSafetyLimit"] = "999";
    const saved = { runId: "saved" };
    state = { ...state, runResponse: saved, draft: { ...state.draft, strategies: [edited] } };
    const restored = workspaceReducer(state, { type: "strategy.reset", id: edited.id }, catalog);
    const expected = createStrategyDraft(catalog, presetId, edited.id);
    assert.deepEqual(restored.draft.strategies[0].params, expected.params);
    assert.deepEqual(restored.draft.strategies[0].rules, expected.rules);
    assert.equal(restored.draft.strategies[0].id, edited.id);
    assert.equal(restored.draft.strategies[0].instanceNumber, edited.instanceNumber);
    assert.equal(restored.runResponse, saved);
    assert.equal(workspaceReducer(restored, { type: "strategy.reset", id: "missing" }, catalog), restored);
  }
});
