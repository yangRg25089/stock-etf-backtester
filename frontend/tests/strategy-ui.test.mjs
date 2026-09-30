import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { StrategyNavigator } = require("../.test-output/features/strategies/StrategyWorkspace.js");
const { StrategyEditorForm } = require("../.test-output/features/strategies/StrategyEditorDialog.js");
const { RunControls } = require("../.test-output/features/runs/RunControls.js");
const { createInitialWorkspaceState, workspaceReducer } = require("../.test-output/features/strategies/model.js");
const catalog = JSON.parse(
  readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"),
);

function render(state, locale = "ja") {
  return renderToStaticMarkup(React.createElement(StrategyNavigator, {
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

function renderEditor(strategy, locale = "ja") {
  const preset = catalog.presets.find((item) => item.id === strategy.presetId);
  return renderToStaticMarkup(React.createElement(StrategyEditorForm, {
    catalog,
    strategy,
    preset,
    locale,
    errors: [],
    onChange() {},
  }));
}

test("strategy editor keeps the catalog name and current VIX summary visible", () => {
  const state = createInitialWorkspaceState(catalog);
  const html = renderEditor(state.draft.strategies[0]);
  assert.match(html, /VIX シグナル積立/);
  assert.match(html, /VIX: \^VIX ≥ 25、月間最大 1 回/);
  assert.match(html, /id="field-strategy-vix_dca-1-vix-symbol"/);
  assert.match(html, /VXN — Nasdaq 100 ボラティリティ指数/);
  assert.match(html, /VXD — Dow Jones ボラティリティ指数/);
  assert.match(html, /<h3 id="strategy-parameter-heading-strategy-vix_dca-1-vix">VIX シグナル<\/h3>/);
  assert.match(html, /買付・売却シグナルで参照するボラティリティ指数を選びます。/);
  assert.equal(createInitialWorkspaceState(catalog).runScope, "all_enabled");
});

test("strategy parameters follow catalog groups and select controls explain their choices", () => {
  const initial = createInitialWorkspaceState(catalog);
  const composite = workspaceReducer(initial, {
    type: "strategy.add",
    id: "strategy-composite-groups",
    presetId: "composite_dca",
  }, catalog);
  const strategy = composite.draft.strategies.find((item) => item.id === "strategy-composite-groups");
  const ja = renderEditor(strategy, "ja");
  const zh = renderEditor(strategy, "zh");

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
  const editor = renderEditor(state.draft.strategies[0]);
  assert.equal(state.draft.strategies[0].presetId, "vix_dca");
  assert.match(html, /VIX シグナル無効/);
  assert.doesNotMatch(html, /VIX: \^VIX ≥ 25、月間最大 1 回/);
  assert.match(editor, /VIX シグナル無効/);
});

test("catalog selector renders every available preset with accessible controls", () => {
  const html = render(createInitialWorkspaceState(catalog), "zh");
  for (const preset of catalog.presets) {
    assert.match(html, new RegExp(`value="${preset.id}"`));
  }
  assert.match(html, /id="preset-to-add" aria-describedby="strategy-add-help"/);
  assert.match(html, /<p class="field-hint sr-only" id="strategy-add-help">/);
  assert.match(html, /aria-label="启用VIX 信号定投"/);
  assert.match(html, /aria-label="删除VIX 信号定投"/);
  assert.match(html, /<article class="strategy-card strategy-nav-card is-active">/);
  assert.doesNotMatch(html, /id="field-strategy-vix_dca-1-vix-symbol"/);

  const controls = renderToStaticMarkup(React.createElement(RunControls, {
    locale: "zh",
    runScope: "active",
    availability: { disabled: false, reasonKey: null },
    busy: false,
    completedFeedback: false,
    onScopeChange() {},
    onRun() {},
  }));
  assert.match(controls, /<select id="run-scope-select" class="run-scope-select"[^>]*aria-describedby="run-scope-help"/);
  assert.match(controls, /<option value="active" selected="">当前运行对象<\/option>/);
  assert.match(controls, /id="run-scope-help" class="sr-only">/);
  assert.doesNotMatch(controls, /aria-pressed=/);
});

test("strategy picker precedes summary cards and editing stays separate from the run target", () => {
  const html = render(createInitialWorkspaceState(catalog), "zh");
  const addIndex = html.indexOf('class="strategy-add"');
  const cardsIndex = html.indexOf('class="strategy-card-list"');
  assert.ok(addIndex >= 0 && cardsIndex > addIndex);
  assert.match(html, /class="strategy-card-open"[^>]*aria-haspopup="dialog"/);
  assert.match(html, /class="icon-button strategy-run-target is-selected"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(html, /id="field-strategy-vix_dca-1-vix-symbol"/);
  assert.match(html, /aria-label="VIX 信号定投是当前运行对象"/);
});

test("strategy navigation lists every instance while the editor only expands the selected one", () => {
  const initial = createInitialWorkspaceState(catalog);
  const second = workspaceReducer(initial, {
    type: "strategy.add",
    id: "strategy-composite-1",
    presetId: "composite_dca",
  }, catalog);
  const html = render(second, "zh");
  assert.equal((html.match(/class="strategy-card strategy-nav-card(?: is-active)?"/g) ?? []).length, 2);
  assert.match(html, /class="strategy-card strategy-nav-card is-active"/);
  assert.match(html, /aria-label="编辑VIX 信号定投"/);
  assert.match(html, /aria-label="编辑复合信号定投"/);
  assert.doesNotMatch(html, /id="field-strategy-(?:vix_dca-1-vix-symbol|composite-1-accumulation-fixedDcaRatio)"/);
});
