import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { catalog } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const { createInitialWorkspaceState, createStrategyDraft, workspaceReducer } = require("../.test-output/features/strategies/model.js");

test("custom duplication deep-copies the rules, allocates a new sequence and leaves results untouched", () => {
  let state = createInitialWorkspaceState(catalog);
  state = workspaceReducer(state, { type: "strategy.add", presetId: "composite_dca", id: "custom-1" }, catalog);
  const source = state.draft.strategies[1];
  source.params["accumulation.cashSafetyLimit"] = "987";
  const saved = { runId: "immutable-saved-result" };
  state = { ...state, runResponse: saved, selectedResultIds: ["old-result"] };
  const next = workspaceReducer(state, { type: "strategy.duplicate", sourceId: source.id, id: "custom-2" }, catalog);
  const copied = next.draft.strategies[2];
  assert.equal(copied.id, "custom-2");
  assert.equal(copied.instanceNumber, 2);
  assert.deepEqual(copied.params, source.params);
  assert.deepEqual(copied.rules, source.rules);
  assert.notEqual(copied.params, source.params);
  assert.notEqual(copied.rules, source.rules);
  copied.params["accumulation.cashSafetyLimit"] = "500";
  copied.rules.buy.children[0].params["vix.buyThreshold"] = "99";
  assert.equal(source.params["accumulation.cashSafetyLimit"], "987");
  assert.notEqual(source.rules.buy.children[0].params["vix.buyThreshold"], "99");
  assert.equal(next.runResponse, saved);
  assert.equal(next.selectedResultIds, state.selectedResultIds);
  assert.equal(next.activeStrategyId, copied.id);
  const removed = workspaceReducer(next, { type: "strategy.remove", id: copied.id }, catalog);
  const again = workspaceReducer(removed, { type: "strategy.duplicate", sourceId: source.id, id: "custom-3" }, catalog);
  assert.equal(again.draft.strategies[2].instanceNumber, 3);
});

test("duplication rejects fixed/unknown sources, ID collisions and the custom limit", () => {
  let state = createInitialWorkspaceState(catalog);
  assert.equal(workspaceReducer(state, { type: "strategy.duplicate", sourceId: state.activeStrategyId, id: "fixed-copy" }, catalog), state);
  assert.equal(workspaceReducer(state, { type: "strategy.duplicate", sourceId: "missing", id: "copy" }, catalog), state);
  for (let index = 1; index <= catalog.strategyLimits.maxCustomInstances; index++) {
    state = workspaceReducer(state, { type: "strategy.add", presetId: "composite_dca", id: `custom-${index}` }, catalog);
  }
  assert.equal(workspaceReducer(state, { type: "strategy.duplicate", sourceId: "custom-1", id: "beyond-limit" }, catalog), state);
  assert.equal(workspaceReducer(state, { type: "strategy.duplicate", sourceId: "custom-1", id: "custom-2" }, catalog), state);
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
