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
  assert.match(html, /id="field-strategy-vix_dca-1-vix-symbol"/);
  assert.match(html, /VXN — Nasdaq 100 ボラティリティ指数/);
  assert.match(html, /VXD — Dow Jones ボラティリティ指数/);
  assert.match(html, /<h4 id="parameters-strategy-vix_dca-1-vix">VIX シグナル<\/h4>/);
  assert.match(html, /買付・売却シグナルで参照するボラティリティ指数を選びます。/);
  assert.match(html, /id="preset-to-add"/);
  assert.equal(createInitialWorkspaceState(catalog).runScope, "all_enabled");
});

test("strategy parameters follow catalog groups and select controls explain their choices", () => {
  const initial = createInitialWorkspaceState(catalog);
  const composite = workspaceReducer(initial, {
    type: "strategy.add",
    id: "strategy-composite-groups",
    presetId: "composite_dca",
  }, catalog);
  const ja = render(composite, "ja");
  const zh = render(composite, "zh");

  assert.ok((ja.match(/class="strategy-parameter-group"/g) ?? []).length >= 7);
  assert.match(ja, /ボリンジャーシグナル/);
  assert.match(ja, /売却条件/);
  assert.match(ja, /この戦略で有効になっている買付条件すべてに適用します。AND はすべて満たす、OR はいずれかを満たす条件です。/);
  assert.match(ja, /百分率の数値（例：5 = 5%）/);
  assert.match(zh, /布林带信号/);
  assert.match(zh, /卖出条件/);
  assert.match(zh, /指定如何解释数据提供方的数值/);
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
  assert.match(html, /<article class="strategy-card is-active">/);
  assert.match(html, /买入条件的组合方式/);
  assert.match(html, /此设置适用于此策略中所有已启用的买入条件/);

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

test("every strategy instance renders as its own card with independently editable settings", () => {
  const initial = createInitialWorkspaceState(catalog);
  const second = workspaceReducer(initial, {
    type: "strategy.add",
    id: "strategy-composite-1",
    presetId: "composite_dca",
  }, catalog);
  const html = render(second, "zh");
  assert.equal((html.match(/class="strategy-card(?: is-active)?"/g) ?? []).length, 2);
  assert.match(html, /class="strategy-card is-active"/);
  assert.match(html, /class="strategy-card"/);
});
