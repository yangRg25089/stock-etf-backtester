import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { catalog, wireRun } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createInitialWorkspaceState, serializeDraftForApi } = require("../.test-output/features/strategies/model.js");
const { SharedSettingsForm } = require("../.test-output/features/config/SharedSettingsForm.js");
const { TradingCostsPanel } = require("../.test-output/features/results/TradingCostsPanel.js");

test("shared execution inputs and their API serialization use the catalog", () => {
  const state = createInitialWorkspaceState(catalog);
  assert.deepEqual(state.draft.shared.execution, { commission: "0", slippagePct: "0", spreadPct: "0", fractionalShares: true, capitalGainsTaxEnabled: false });
  state.draft.shared.execution = { commission: "2.25", slippagePct: "0.1", spreadPct: "0.2", fractionalShares: false };
  assert.deepEqual(serializeDraftForApi(state.draft).shared.execution, state.draft.shared.execution);
  const markup = renderToStaticMarkup(React.createElement(SharedSettingsForm, { catalog, value: state.draft.shared, locale: "zh", currency: "JPY", onChange() {} }));
  for (const definition of catalog.parameters.filter(row => row.key.startsWith("execution."))) {
    assert.ok(markup.includes(definition.key.replaceAll(".", "-")));
  }
  assert.match(markup, /JPY/);
  assert.match(markup, /佣金|手续费/);
});

test("cost summaries display saved currency values and preserve absent historical data", () => {
  const result = wireRun().result.strategyRuns[0];
  result.metrics.tradingCosts = { commission: "2", slippageCost: "1", spreadCost: "1", totalTradingCost: "4" };
  const before = JSON.stringify(result);
  const markup = renderToStaticMarkup(React.createElement(TradingCostsPanel, { locale: "zh", currency: "USD", costs: result.metrics.tradingCosts }));
  assert.match(markup, /\$4/);
  assert.match(markup, /佣金|手续费/);
  assert.match(markup, /价差/);
  assert.equal(JSON.stringify(result), before);
  const legacy = renderToStaticMarkup(React.createElement(TradingCostsPanel, { locale: "zh", currency: "USD" }));
  assert.match(legacy, /未保存/);
  assert.doesNotMatch(legacy, /\$0/);
});
