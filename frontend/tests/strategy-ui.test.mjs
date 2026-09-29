import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { StrategyWorkspace } = require("../.test-output/features/strategies/StrategyWorkspace.js");
const { RunControls } = require("../.test-output/features/runs/RunControls.js");
const { createInitialWorkspaceState, workspaceReducer } = require("../.test-output/features/strategies/model.js");
const catalog = JSON.parse(
  readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"),
);

function render(state, locale = "ja") {
  return renderToStaticMarkup(React.createElement(StrategyWorkspace, {
    catalog,
    locale,
    state,
    validation: {
      valid: true,
      diagnostics: [],
      strategies: state.draft.strategies.map((strategy) => ({
        strategyId: strategy.id,
        presetId: strategy.presetId,
        enabled: strategy.enabled,
        diagnostics: [],
      })),
    },
    dispatch() {},
    onAdd() {},
  }));
}

test("strategy editor keeps the catalog name and current VIX summary visible", () => {
  const html = render(createInitialWorkspaceState(catalog));
  assert.match(html, /VIX シグナル積立/);
  assert.match(html, /VIX: \^VIX ≥ 25、月間最大 1 回/);
  assert.match(html, /id="preset-to-add"/);
});

test("turning off VIX shows the required disabled copy and preserves the preset id", () => {
  const initial = createInitialWorkspaceState(catalog);
  const state = workspaceReducer(initial, {
    type: "strategy.param",
    id: initial.activeStrategyId,
    key: "vix.buyEnabled",
    value: false,
  });
  const html = render(state);
  assert.equal(state.draft.strategies[0].presetId, "vix_dca");
  assert.match(html, /VIX シグナル無効/);
  assert.doesNotMatch(html, /VIX: \^VIX ≥ 25、月間最大 1 回/);
});

test("catalog selector renders every available preset with accessible controls", () => {
  const html = render(createInitialWorkspaceState(catalog), "zh");
  for (const preset of catalog.presets) {
    assert.match(html, new RegExp(`value="${preset.id}"`));
  }
  assert.match(html, /aria-label="启用VIX 信号定投"/);
  assert.match(html, /aria-label="删除VIX 信号定投"/);
  assert.match(html, /<ul class="strategy-list">/);

  const controls = renderToStaticMarkup(React.createElement(RunControls, {
    locale: "zh",
    runScope: "active",
    availability: { disabled: false, reasonKey: null },
    busy: false,
    onScopeChange() {},
    onRun() {},
  }));
  assert.match(controls, /role="group" aria-label="运行范围"/);
  assert.match(controls, /aria-pressed="true">当前策略/);
});
