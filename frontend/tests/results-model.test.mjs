import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createInitialWorkspaceState, workspaceReducer } = require("../.test-output/features/strategies/model.js");
const {
  findFocusedResult,
  isRunSnapshotStale,
} = require("../.test-output/features/results/model.js");
const catalog = JSON.parse(
  readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"),
);

test("result display defaults come from the catalog and remain separate preferences", () => {
  let state = createInitialWorkspaceState(catalog);
  assert.equal(state.showChart, true);
  assert.equal(state.showTrades, true);
  assert.deepEqual(state.visibleSeriesIds, ["totalAsset", "drawdown"]);

  state = workspaceReducer(state, { type: "display.chart", value: false });
  assert.equal(state.showChart, false);
  assert.equal(state.showTrades, true);
  state = workspaceReducer(state, { type: "display.trades", value: false });
  assert.equal(state.showChart, false);
  assert.equal(state.showTrades, false);
  state = workspaceReducer(state, { type: "chart.series", id: "drawdown", visible: false });
  assert.deepEqual(state.visibleSeriesIds, ["totalAsset"]);
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

test("focused result lookup is keyed by result id and independent of editor selection", () => {
  let state = createInitialWorkspaceState(catalog);
  const focused = { id: "benchmark-dca", role: "benchmark", status: "completed" };
  const run = { result: { strategyRuns: [focused] } };
  state = workspaceReducer(state, { type: "result.focus", id: focused.id });
  state = workspaceReducer(state, { type: "strategy.select", id: state.activeStrategyId });

  assert.equal(findFocusedResult(run, state.focusedResultId), focused);
  assert.equal(findFocusedResult(run, "missing"), null);
});

test("snapshot freshness ignores a resolved latest date but detects selected draft changes", () => {
  const initial = createInitialWorkspaceState(catalog);
  const strategy = initial.draft.strategies[0];
  const run = {
    runId: "saved-run",
    status: "completed",
    selectedStrategyIds: [strategy.id],
    snapshot: {
      config: {
        shared: {
          run: {
            symbol: initial.draft.shared.run.symbol,
            startDate: initial.draft.shared.run.startDate,
            endDate: "2024-06-28",
            endMode: "fixed",
          },
          contribution: { ...initial.draft.shared.contribution },
          data: { ...initial.draft.shared.data },
        },
        strategies: [{ ...strategy, params: { ...strategy.params } }],
      },
    },
  };
  let state = {
    ...initial,
    runResponse: run,
    runRequestedEndMode: "latest",
    runRequestedScope: "active",
  };

  assert.equal(isRunSnapshotStale(state), false);
  state = {
    ...state,
    runResponse: {
      ...run,
      snapshot: {
        config: {
          ...run.snapshot.config,
          shared: {
            ...run.snapshot.config.shared,
            run: {
              ...run.snapshot.config.shared.run,
              endDate: initial.draft.shared.run.startDate,
              endMode: "latest",
            },
          },
        },
      },
    },
  };
  assert.equal(isRunSnapshotStale(state), false);
  state = workspaceReducer(state, { type: "strategy.param", id: strategy.id, key: "vix.buyThreshold", value: "31" });
  assert.equal(isRunSnapshotStale(state), true);
});

test("all-enabled snapshot freshness notices a newly enabled strategy", () => {
  let state = createInitialWorkspaceState(catalog);
  const first = state.draft.strategies[0];
  const run = {
    runId: "saved-run",
    status: "completed",
    selectedStrategyIds: [first.id],
    snapshot: {
      config: {
        shared: {
          run: {
            ...state.draft.shared.run,
            endDate: state.draft.shared.run.startDate,
            endMode: "fixed",
          },
          contribution: { ...state.draft.shared.contribution },
          data: { ...state.draft.shared.data },
        },
        strategies: [{ ...first, params: { ...first.params } }],
      },
    },
  };
  state = {
    ...state,
    runResponse: run,
    runRequestedEndMode: "latest",
    runRequestedScope: "all_enabled",
  };
  assert.equal(isRunSnapshotStale(state), false);
  state = workspaceReducer(state, {
    type: "strategy.add",
    id: "strategy-monthly_dca-2",
    presetId: "monthly_dca",
  }, catalog);
  assert.equal(isRunSnapshotStale(state), true);
});
