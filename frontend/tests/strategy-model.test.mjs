import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  createInitialWorkspaceState,
  getRunAvailability,
  isPartialSuccess,
  serializeDraftForApi,
  workspaceReducer,
} = require("../.test-output/features/strategies/model.js");
const catalog = JSON.parse(
  readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"),
);

function validationFor(state, overrides = {}) {
  return {
    valid: true,
    diagnostics: [],
    strategies: state.draft.strategies.map((strategy) => ({
      strategyId: strategy.id,
      presetId: strategy.presetId,
      enabled: strategy.enabled,
      diagnostics: [],
    })),
    ...overrides,
  };
}

test("initial workspace comes from the VIX preset and shared catalog defaults", () => {
  const state = createInitialWorkspaceState(catalog);
  const [strategy] = state.draft.strategies;

  assert.equal(state.activeStrategyId, strategy.id);
  assert.equal(strategy.presetId, "vix_dca");
  assert.equal(strategy.enabled, true);
  assert.equal(strategy.params["vix.buyEnabled"], true);
  assert.equal(strategy.params["vix.symbol"], "^VIX");
  assert.equal(String(strategy.params["vix.buyThreshold"]), "25");
  assert.equal(String(strategy.params["accumulation.maxSignalBuysPerMonth"]), "1");
  assert.equal(String(strategy.params["accumulation.cashSafetyLimit"]), "1200");
  assert.equal(strategy.params["exit.enabled"], false);
  assert.equal(state.draft.shared.run.symbol, "QQQ");
  assert.equal(state.draft.shared.run.startDate, "2020-01-01");
  assert.equal(state.draft.shared.run.endMode, "latest");
  assert.equal(state.draft.shared.run.endDate, null);
  assert.equal(state.draft.shared.contribution.amount, "100");
  assert.equal(state.draft.shared.contribution.day, 1);
});

test("editor selection does not toggle, run, or replace another instance's parameters", () => {
  let state = createInitialWorkspaceState(catalog);
  state = workspaceReducer(state, {
    type: "strategy.add",
    id: "strategy-composite-2",
    presetId: "composite_dca",
  }, catalog);
  const added = state.draft.strategies[1];
  state = workspaceReducer(state, { type: "strategy.param", id: added.id, key: "vix.buyThreshold", value: "31" });
  const changedDraft = state.draft;

  state = workspaceReducer(state, { type: "strategy.select", id: "strategy-vix_dca-1" });

  assert.equal(state.activeStrategyId, "strategy-vix_dca-1");
  assert.equal(state.draft.strategies[1].enabled, true);
  assert.equal(state.draft.strategies[1].params["vix.buyThreshold"], "31");
  assert.equal(state.runResponse, null);
  assert.equal(state.draft.strategies[0].params["vix.buyThreshold"], "25");
  assert.equal(changedDraft.strategies[1].params["vix.buyThreshold"], "31");
});

test("disabling the VIX signal retains the preset identity and its other values", () => {
  let state = createInitialWorkspaceState(catalog);
  const original = state.draft.strategies[0];

  state = workspaceReducer(state, {
    type: "strategy.param",
    id: original.id,
    key: "vix.buyEnabled",
    value: false,
  });

  assert.equal(state.draft.strategies[0].presetId, "vix_dca");
  assert.equal(state.draft.strategies[0].params["vix.buyEnabled"], false);
  assert.equal(state.draft.strategies[0].params["vix.buyThreshold"], original.params["vix.buyThreshold"]);
});

test("strategy enable switches preserve parameters and expose accurate run reasons", () => {
  let state = createInitialWorkspaceState(catalog);
  const id = state.activeStrategyId;
  const params = state.draft.strategies[0].params;
  state = workspaceReducer(state, { type: "strategy.enabled", id, value: false });
  const validation = validationFor(state);

  assert.equal(state.draft.strategies[0].params["vix.buyThreshold"], params["vix.buyThreshold"]);
  assert.deepEqual(getRunAvailability(state, validation), {
    disabled: true,
    reasonKey: "run.activeDisabled",
  });
  state = workspaceReducer(state, { type: "run.scope", value: "all_enabled" });
  assert.deepEqual(getRunAvailability(state, validation), {
    disabled: true,
    reasonKey: "run.noEnabledStrategies",
  });
  state = workspaceReducer(state, { type: "strategy.enabled", id, value: true });
  assert.deepEqual(getRunAvailability(state, validation), { disabled: false, reasonKey: null });
});

test("delete and re-add uses the selected catalog preset with a fresh instance identity", () => {
  let state = createInitialWorkspaceState(catalog);
  const deletedId = state.draft.strategies[0].id;
  state = workspaceReducer(state, { type: "strategy.remove", id: deletedId });
  state = workspaceReducer(state, {
    type: "strategy.add",
    id: "strategy-vix_dca-2",
    presetId: "vix_dca",
  }, catalog);

  assert.equal(state.activeStrategyId, "strategy-vix_dca-2");
  assert.equal(state.draft.strategies[0].id, "strategy-vix_dca-2");
  assert.notEqual(state.draft.strategies[0].id, deletedId);
  assert.equal(String(state.draft.strategies[0].params["vix.buyThreshold"]), "25");
});

test("run availability distinguishes active and all-enabled validation rules", () => {
  let state = createInitialWorkspaceState(catalog);
  const enabled = state.draft.strategies[0];
  const other = {
    ...enabled,
    id: "strategy-invalid-2",
    params: { ...enabled.params, "vix.buyThreshold": "999" },
  };
  state = { ...state, draft: { ...state.draft, strategies: [enabled, other] } };
  const validation = validationFor(state, {
    strategies: [
      { strategyId: enabled.id, presetId: enabled.presetId, enabled: true, diagnostics: [] },
      {
        strategyId: other.id,
        presetId: other.presetId,
        enabled: true,
        diagnostics: [{ code: "invalid_parameter", messageKey: "diagnostics.configuration.out_of_range" }],
      },
    ],
  });

  assert.deepEqual(getRunAvailability(state, validation), { disabled: false, reasonKey: null });
  state = workspaceReducer(state, { type: "run.scope", value: "all_enabled" });
  assert.deepEqual(getRunAvailability(state, validation), { disabled: false, reasonKey: null });
  state = workspaceReducer(state, { type: "run.scope", value: "active" });
  state = workspaceReducer(state, { type: "strategy.select", id: other.id });
  assert.deepEqual(getRunAvailability(state, validation), {
    disabled: true,
    reasonKey: "run.activeInvalid",
  });

  const sharedError = validationFor(state, {
    diagnostics: [{ code: "invalid_parameter", messageKey: "diagnostics.configuration.required" }],
  });
  state = workspaceReducer(state, { type: "run.scope", value: "all_enabled" });
  assert.deepEqual(getRunAvailability(state, sharedError), {
    disabled: true,
    reasonKey: "run.sharedInvalid",
  });
});

test("scope and result focus remain independent from draft edits; latest date uses a request placeholder", () => {
  let state = createInitialWorkspaceState(catalog);
  const snapshot = {
    runId: "run-1",
    status: "completed",
    selectedStrategyIds: [state.activeStrategyId],
    snapshot: { config: { strategies: [], shared: {} } },
    result: { runId: "run-1", strategyRuns: [] },
  };
  state = workspaceReducer(state, { type: "run.update", value: snapshot });
  state = workspaceReducer(state, { type: "result.focus", id: "benchmark-dca" });
  state = workspaceReducer(state, { type: "run.scope", value: "all_enabled" });
  state = workspaceReducer(state, {
    type: "strategy.param",
    id: state.activeStrategyId,
    key: "vix.buyThreshold",
    value: "30",
  });

  assert.equal(state.runScope, "all_enabled");
  assert.equal(state.focusedResultId, "benchmark-dca");
  assert.equal(state.runResponse, snapshot);
  assert.equal(state.runResponse.snapshot.config.strategies.length, 0);
  assert.equal(state.draft.strategies[0].params["vix.buyThreshold"], "30");
  assert.equal(serializeDraftForApi(state.draft).shared.run.endDate, "2020-01-01");
  assert.equal(serializeDraftForApi(state.draft).shared.run.endMode, "latest");
});

test("partial success is derived from backend strategy statuses", () => {
  assert.equal(isPartialSuccess({ result: { strategyRuns: [
    { id: "ok", status: "completed" },
    { id: "bad", status: "unavailable" },
  ] } }), true);
  assert.equal(isPartialSuccess({ result: { strategyRuns: [
    { id: "ok", status: "completed" },
    { id: "also-ok", status: "completed_with_warning" },
  ] } }), false);
  assert.equal(isPartialSuccess({ result: { strategyRuns: [
    { id: "pending", status: "running" },
    { id: "bad", status: "failed" },
  ] } }), false);
});
