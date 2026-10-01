import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createInitialWorkspaceState, workspaceReducer } = require("../.test-output/features/strategies/model.js");
const {
  findFocusedResult,
} = require("../.test-output/features/results/model.js");
const catalog = JSON.parse(
  readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"),
);

test("chart display and legend preferences remain independent without a trade visibility state", () => {
  let state = createInitialWorkspaceState(catalog);
  assert.equal(state.runScope, "all_enabled");
  assert.equal(state.showChart, true);
  assert.equal(Object.hasOwn(state, "showTrades"), false);
  assert.deepEqual(state.visibleSeriesIds, ["price", "totalAsset", "drawdown", "vix"]);

  state = workspaceReducer(state, { type: "display.chart", value: false });
  assert.equal(state.showChart, false);
  assert.equal(Object.hasOwn(state, "showTrades"), false);
  state = workspaceReducer(state, { type: "chart.series", id: "drawdown", visible: false });
  assert.deepEqual(state.visibleSeriesIds, ["price", "totalAsset", "vix"]);
});

test("result focus survives editor switching and draft edits", () => {
  let state = createInitialWorkspaceState(catalog);
  state = workspaceReducer(state, { type: "result.focus", id: "benchmark-dca" });
  state = workspaceReducer(state, { type: "strategy.select", id: "strategy-vix_dca-1" });
  state = workspaceReducer(state, {
    type: "strategy.param",
    id: "strategy-vix_dca-1",
    key: "vix.buyThreshold",
    value: "33",
  });

  assert.equal(state.focusedResultId, "benchmark-dca");
  assert.equal(state.activeStrategyId, "strategy-vix_dca-1");
  assert.equal(state.draft.strategies[0].params["vix.buyThreshold"], "33");
});

test("a new saved run initializes a missing result focus from its selected snapshot", () => {
  let state = createInitialWorkspaceState(catalog);
  const response = {
    runId: "new-run",
    status: "running",
    selectedStrategyIds: ["strategy-selected"],
    snapshot: { runId: "new-run", config: { shared: {}, strategies: [] } },
    result: { runId: "new-run", strategyRuns: [
      { id: "strategy-selected", status: "running" },
      { id: "benchmark-dca", status: "queued" },
    ] },
  };
  state = workspaceReducer(state, { type: "run.update", value: response });
  assert.equal(state.focusedResultId, "strategy-selected");
  assert.equal(state.activeStrategyId, "strategy-vix_dca-1");
});

test("run progress events update statuses without replacing saved result details", () => {
  let state = createInitialWorkspaceState(catalog);
  const queued = {
    runId: "streamed-run",
    status: "queued",
    selectedStrategyIds: ["strategy-selected"],
    progress: { completedStrategies: 0, totalStrategies: 2 },
    snapshot: { runId: "streamed-run", config: { shared: {}, strategies: [] } },
    result: { runId: "streamed-run", strategyRuns: [
      { id: "strategy-selected", status: "queued", metrics: null },
      { id: "benchmark:monthly-dca", status: "queued", metrics: null },
    ] },
  };
  state = workspaceReducer(state, { type: "run.update", value: queued });
  state = workspaceReducer(state, {
    type: "run.progress",
    value: {
      runId: "streamed-run",
      status: "running",
      progress: { completedStrategies: 1, totalStrategies: 2, currentStrategyId: "strategy-selected" },
      strategyStatuses: {
        "strategy-selected": "completed",
        "benchmark:monthly-dca": "running",
      },
    },
  });

  assert.equal(state.runResponse.status, "running");
  assert.equal(state.runResponse.progress.completedStrategies, 1);
  assert.deepEqual(
    state.runResponse.result.strategyRuns.map(({ status }) => status),
    ["completed", "running"],
  );
  assert.deepEqual(state.runResponse.snapshot, queued.snapshot);
});

test("focused result lookup is keyed by result id and independent of editor selection", () => {
  let state = createInitialWorkspaceState(catalog);
  const focused = { id: "benchmark-dca", role: "benchmark", status: "completed" };
  const run = { result: { strategyRuns: [focused] } };
  state = workspaceReducer(state, { type: "result.focus", id: focused.id });
  state = workspaceReducer(state, { type: "strategy.select", id: state.activeStrategyId });

  assert.equal(findFocusedResult(run, state.focusedResultId), focused);
  assert.equal(findFocusedResult(run, "missing"), null);
});

test("draft edits preserve a resolved latest snapshot and its result focus", () => {
  let state = createInitialWorkspaceState(catalog);
  const strategy = state.draft.strategies[0];
  const response = {
    runId: "frozen-latest", status: "completed", selectedStrategyIds: [strategy.id],
    snapshot: { config: {
      shared: structuredClone(state.draft.shared),
      strategies: structuredClone(state.draft.strategies),
    } },
    result: { strategyRuns: [{ id: strategy.id, status: "completed", metrics: { endingEquity: "120.50" } }] },
  };
  response.snapshot.config.shared.run.endMode = "fixed";
  response.snapshot.config.shared.run.endDate = "2024-06-28";
  const original = structuredClone(response);
  state = workspaceReducer(state, { type: "run.update", value: response, requestedEndMode: "latest" });
  state = workspaceReducer(state, { type: "strategy.param", id: strategy.id, key: "vix.buyThreshold", value: "31" });
  state = workspaceReducer(state, { type: "shared.change", value: { ...state.draft.shared, run: { ...state.draft.shared.run, symbol: "SMH" } } });
  assert.equal(state.runResponse, response);
  assert.deepEqual(response, original);
  assert.equal(state.focusedResultId, strategy.id);
  assert.equal(state.draft.shared.run.symbol, "SMH");
});

test("numeric draft values never rewrite the saved Decimal strings", () => {
  let state = createInitialWorkspaceState(catalog);
  const strategy = state.draft.strategies[0];
  const response = {
    runId: "saved-decimal-run", status: "completed", selectedStrategyIds: [strategy.id],
    snapshot: { config: { shared: structuredClone(state.draft.shared), strategies: [
      { ...structuredClone(strategy), params: { ...strategy.params, "vix.buyThreshold": "25", "accumulation.cashSafetyLimit": "1200" } },
    ] } },
  };
  const original = structuredClone(response);
  state = workspaceReducer(state, { type: "run.update", value: response });
  for (const [key, value] of [["vix.buyThreshold", 25], ["accumulation.cashSafetyLimit", 1200], ["vix.buyThreshold", 31]]) {
    state = workspaceReducer(state, { type: "strategy.param", id: strategy.id, key, value });
    assert.equal(state.runResponse, response);
    assert.deepEqual(response, original);
  }
  assert.equal(state.draft.strategies[0].params["vix.buyThreshold"], 31);
});

test("adding, disabling and removing draft strategies cannot change saved identities", () => {
  let state = createInitialWorkspaceState(catalog);
  const first = state.draft.strategies[0];
  const response = {
    runId: "saved-run", status: "completed", selectedStrategyIds: [first.id],
    snapshot: { config: { shared: structuredClone(state.draft.shared), strategies: structuredClone(state.draft.strategies) } },
    result: { strategyRuns: [{ id: first.id, status: "completed" }] },
  };
  const original = structuredClone(response);
  state = workspaceReducer(state, { type: "run.update", value: response });
  state = workspaceReducer(state, { type: "strategy.add", id: "strategy-ma-2", presetId: "ma_buy_only" }, catalog);
  state = workspaceReducer(state, { type: "strategy.enabled", id: first.id, value: false });
  state = workspaceReducer(state, { type: "strategy.remove", id: first.id });
  assert.equal(state.runResponse, response);
  assert.deepEqual(response, original);
  assert.equal(state.focusedResultId, first.id);
  assert.deepEqual(state.draft.strategies.map(({ id }) => id), ["strategy-ma-2"]);
});
