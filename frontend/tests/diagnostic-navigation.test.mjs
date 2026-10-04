import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const catalog = JSON.parse(readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"));
const { createInitialWorkspaceState, workspaceReducer } = require("../.test-output/features/strategies/model.js");
const initial = createInitialWorkspaceState(catalog);
const diagnostic = fieldPath => ({ fieldPath, code: "invalid_parameter", messageKey: "diagnostics.configuration.out_of_range", severity: "error" });
const resolve = value => require("../.test-output/features/runs/diagnosticNavigation.js").diagnosticTarget(value, catalog, initial.draft);

test("shared diagnostics resolve catalog labels and reject unknown targets", () => {
  const target = resolve(diagnostic("run.symbol"));
  assert.deepEqual(target, { kind: "shared", parameterKey: "run.symbol", labelKey: catalog.parameters.find(item => item.key === "run.symbol").translationKey });
  for (const path of [undefined, "unrelated", "strategies[100].params.vix.buyThreshold", "strategies[0].params.not_registered"]) assert.equal(resolve(diagnostic(path)), null);
});

test("strategy and nested condition diagnostics preserve exact field identities", () => {
  const { diagnosticTarget } = require("../.test-output/features/runs/diagnosticNavigation.js");
  const target = resolve(diagnostic("strategies[0].params.vix.buyThreshold"));
  assert.deepEqual(target.navigation, { strategyId: initial.draft.strategies[0].id, parameterKey: "vix.buyThreshold", fieldIndex: undefined, conditionId: undefined });
  const custom = workspaceReducer(initial, { type: "strategy.add", id: "nested-custom", presetId: "composite_dca" }, catalog);
  custom.draft.strategies[1].rules = { buy: { id: "outer", operator: "AND", children: [{ id: "inner", operator: "OR", children: [{ id: "vix-leaf", kind: "vix", enabled: true, params: { "vix.buyThreshold": 25 } }] }] } };
  const nested = diagnosticTarget(diagnostic("strategies[1].rules.buy.children[0].children[0].params.vix.buyThreshold"), catalog, custom.draft);
  assert.deepEqual(nested.navigation, { strategyId: "nested-custom", parameterKey: "vix.buyThreshold", fieldIndex: undefined, conditionId: "vix-leaf" });
  const search = workspaceReducer(initial, { type: "strategy.add", id: "search", presetId: "grid_search" }, catalog);
  const key = catalog.presets.find(item => item.id === "grid_search").parameterKeys.find(item => catalog.parameters.find(parameter => parameter.key === item).type === "number_list");
  assert.ok(key);
  const list = diagnosticTarget(diagnostic(`strategies[1].params.${key}[2]`), catalog, search.draft);
  assert.equal(list.navigation.fieldIndex, 2);
  assert.equal(list.navigation.parameterKey, key);
});

test("listing recovery retains its guarded date suggestion independently of UI", () => {
  const target = resolve({ ...diagnostic("run.startDate"), messageKey: "market.period_before_listing", details: {
    symbol: "SOXQ", availableFrom: "2021-06-11", requestedStartDate: "2020-01-01", requestedEndDate: "2020-12-31", suggestedStartDate: "2021-06-11", suggestedEndDate: "2022-06-11",
  } });
  assert.equal(target.kind, "period");
  assert.equal(target.labelKey, "market.adjust_period");
  assert.deepEqual(target.recovery.range, { startDate: "2021-06-11", endDate: "2022-06-11" });
});
