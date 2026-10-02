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
      enabled: true,
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
  assert.equal("enabled" in strategy, false);
  assert.equal(strategy.params["vix.buyEnabled"], true);
  assert.equal(strategy.params["vix.symbol"], "^VIX");
  assert.equal(String(strategy.params["vix.buyThreshold"]), "25");
  assert.equal(String(strategy.params["accumulation.maxSignalBuysPerMonth"]), "1");
  assert.equal(String(strategy.params["accumulation.cashSafetyLimit"]), "1200");
  assert.equal(strategy.params["exit.enabled"], false);
  assert.equal(state.draft.shared.run.symbol, "QQQ");
  assert.equal(state.draft.shared.run.startDate, "2020-01-01");
  assert.equal("endMode" in state.draft.shared.run, false);
  assert.equal(state.draft.shared.run.endDate, catalog.parameters.find(item => item.key === "run.endDate").default);
  assert.equal(state.draft.shared.contribution.amount, "100");
  assert.equal(state.draft.shared.contribution.day, 1);
  assert.equal("overlayMode" in state, false);
  assert.deepEqual(state.visibleSeriesIds, ["price", "totalAsset", "drawdown", "vix"]);
});

test("condition drafts clone catalog templates and submitting freezes nested values", () => {
  let state = createInitialWorkspaceState(catalog);
  const id = state.activeStrategyId;
  assert.notEqual(state.draft.strategies[0].rules, catalog.presets[0].defaultRules);
  const rules = structuredClone(state.draft.strategies[0].rules);
  rules.buy.params["vix.buyThreshold"] = 37;
  rules.sell.enabled = true;
  state = workspaceReducer({ ...state, runResponse: { runId: "saved" } }, { type: "strategy.rules", id, value: rules });
  assert.equal(state.draft.strategies[0].rules.buy.params["vix.buyThreshold"], 37);
  assert.equal(String(state.draft.strategies[0].rules.sell.params["exit.vix.low1"]), "12");
  assert.equal(state.runResponse.runId, "saved");
  const submitted = serializeDraftForApi(state.draft);
  assert.notEqual(submitted.strategies[0].rules, state.draft.strategies[0].rules);
  state.draft.strategies[0].rules.buy.params["vix.buyThreshold"] = 80;
  assert.equal(submitted.strategies[0].rules.buy.params["vix.buyThreshold"], 37);
  assert.equal(String(catalog.presets[0].defaultRules.buy.params["vix.buyThreshold"]), "25");
});

test("reset clears the displayed run and focus while preserving draft and display preferences", () => {
  const initial = createInitialWorkspaceState(catalog);
  const state = {
    ...initial,
    runResponse: { runId: "saved-result" },
    focusedResultId: initial.activeStrategyId,
  };
  const cleared = workspaceReducer(state, { type: "run.reset" });
  assert.equal(cleared.runResponse, null);
  assert.equal(cleared.focusedResultId, null);
  assert.equal(cleared.draft, state.draft);
  assert.equal(cleared.activeStrategyId, state.activeStrategyId);
  assert.equal(Object.hasOwn(cleared, "runScope"), false);
  assert.equal(cleared.visibleSeriesIds, state.visibleSeriesIds);
});

test("series visibility remains independent from saved results with no layout mode", () => {
  let state = createInitialWorkspaceState(catalog);
  state = workspaceReducer(state, { type: "chart.series", id: "vix", visible: false });

  assert.equal("overlayMode" in state, false);
  assert.equal(state.runResponse, null);
  assert.deepEqual(state.visibleSeriesIds, ["price", "totalAsset", "drawdown"]);
});

test("new run resets result preferences while same-run updates preserve them", () => {
  const initial = createInitialWorkspaceState(catalog);
  const firstId = initial.activeStrategyId;
  const makeRun = runId => ({ runId, selectedStrategyIds: [firstId], result: { strategyRuns: [{ id: firstId }, { id: "benchmark" }] } });
  const edited = { ...initial, runResponse: makeRun("old"), focusedResultId: "benchmark", selectedResultIds: [firstId, "benchmark"], visibleSeriesIds: ["price"], showChart: false };
  const fresh = workspaceReducer(edited, { type: "run.update", value: makeRun("new") });
  assert.equal(fresh.focusedResultId, firstId);
  assert.deepEqual(fresh.selectedResultIds, []);
  assert.deepEqual(fresh.visibleSeriesIds, initial.visibleSeriesIds);
  assert.equal(fresh.showChart, initial.showChart);
  const selected = { ...fresh, selectedResultIds: [], visibleSeriesIds: ["price"], showChart: false };
  const updated = workspaceReducer(selected, { type: "run.update", value: makeRun("new") });
  assert.deepEqual(updated.selectedResultIds, []);
  assert.deepEqual(updated.visibleSeriesIds, ["price"]);
  assert.equal(updated.showChart, false);
});

test("new running, progress and terminal responses never select a strategy implicitly", () => {
  let state = createInitialWorkspaceState(catalog);
  const id = state.activeStrategyId;
  const response = { runId: "new-unselected", status: "queued", selectedStrategyIds: [id], result: { strategyRuns: [{ id, status: "queued" }] } };
  state.selectedResultIds = [id];
  state = workspaceReducer(state, { type: "run.update", value: response });
  assert.deepEqual(state.selectedResultIds, []);
  state = workspaceReducer(state, { type: "run.progress", value: { runId: response.runId, status: "running", progress: {}, strategyStatuses: { [id]: "completed" } } });
  assert.deepEqual(state.selectedResultIds, []);
  state = workspaceReducer(state, { type: "run.update", value: { ...response, status: "completed" } });
  assert.deepEqual(state.selectedResultIds, []);
  state = workspaceReducer(state, { type: "result.toggleSelection", id });
  state = workspaceReducer(state, { type: "run.update", value: { ...response, status: "completed" } });
  assert.deepEqual(state.selectedResultIds, [id]);
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
  assert.equal("enabled" in state.draft.strategies[1], false);
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

test("every added strategy is submitted enabled with no instance toggle state", () => {
  const state = createInitialWorkspaceState(catalog);
  assert.equal("enabled" in state.draft.strategies[0], false);
  assert.equal(Object.hasOwn(serializeDraftForApi(state.draft).strategies[0], "enabled"), false);
  assert.deepEqual(getRunAvailability(state, validationFor(state)), { disabled: false, reasonKey: null });
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

test("all-strategy availability is independent of the edited strategy and preserves partial failures", () => {
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
  state = workspaceReducer(state, { type: "strategy.select", id: other.id });
  assert.deepEqual(getRunAvailability(state, validation), { disabled: false, reasonKey: null });
  assert.deepEqual(getRunAvailability({ ...state, activeStrategyId: null }, validation), { disabled: false, reasonKey: null });
  assert.equal(Object.hasOwn(state, "runScope"), false);

  const sharedError = validationFor(state, {
    diagnostics: [{ code: "invalid_parameter", messageKey: "diagnostics.configuration.required" }],
  });
  assert.deepEqual(getRunAvailability(state, sharedError), {
    disabled: true,
    reasonKey: "run.sharedInvalid",
  });
});

test("saved results and focus remain independent from draft edits; dates use the explicitly selected day", () => {
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
  state = workspaceReducer(state, {
    type: "strategy.param",
    id: state.activeStrategyId,
    key: "vix.buyThreshold",
    value: "30",
  });

  assert.equal(Object.hasOwn(state, "runScope"), false);
  assert.equal(state.focusedResultId, "benchmark-dca");
  assert.equal(state.runResponse, snapshot);
  assert.equal(state.runResponse.snapshot.config.strategies.length, 0);
  assert.equal(state.draft.strategies[0].params["vix.buyThreshold"], "30");
  assert.equal(serializeDraftForApi(state.draft).shared.run.endDate, state.draft.shared.run.endDate);
  assert.equal("endMode" in serializeDraftForApi(state.draft).shared.run, false);
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


test("fixed strategies cannot repeat; custom strategies allow ten and stable sequence numbers", () => {
  let state = createInitialWorkspaceState(catalog);
  assert.equal(workspaceReducer(state, { type: "strategy.add", id: "duplicate-vix", presetId: "vix_dca" }, catalog), state);
  for (let index = 1; index <= 10; index += 1) state = workspaceReducer(state, { type: "strategy.add", id: `custom-${index}`, presetId: "composite_dca" }, catalog);
  assert.deepEqual(state.draft.strategies.slice(1).map(item => item.instanceNumber), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(workspaceReducer(state, { type: "strategy.add", id: "eleven", presetId: "composite_dca" }, catalog), state);
  state = workspaceReducer(state, { type: "strategy.remove", id: "custom-2" });
  state = workspaceReducer(state, { type: "strategy.add", id: "replacement", presetId: "composite_dca" }, catalog);
  assert.equal(state.draft.strategies.at(-1).instanceNumber, 11);
  assert.equal(state.draft.strategies[2].instanceNumber, 3);
});
