import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createInitialWorkspaceState, workspaceReducer } = require("../.test-output/features/strategies/model.js");
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
