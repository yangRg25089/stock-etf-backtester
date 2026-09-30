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

test("strategy editor keeps one label per field and no repeated parameter summary", () => {
  const state = createInitialWorkspaceState(catalog);
  const html = renderEditor(state.draft.strategies[0]);
  assert.match(html, /VIX シグナル積立/);
  assert.doesNotMatch(html, /strategy-editor-summary|strategy-parameter-nav/);
  assert.match(html, /id="field-strategy-vix_dca-1-vix-symbol"/);
  assert.match(html, /VXN — Nasdaq 100 ボラティリティ指数/);
  assert.match(html, /VXD — Dow Jones ボラティリティ指数/);
  assert.match(html, /<h3 id="strategy-parameter-heading-strategy-vix_dca-1-vix">VIX シグナル<\/h3>/);
  assert.match(html, /シグナル判定に使う指数。/);
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
  assert.match(ja, /role="radiogroup" aria-label="買付条件の組み合わせ"/);
  assert.match(ja, /title="有効な買付条件すべてを満たす"/);
  assert.doesNotMatch(ja, /有効な買付条件すべて：AND = 全条件、OR = いずれか。/);
  assert.doesNotMatch(ja, /strategy-parameter-nav|strategy-editor-summary/);
  assert.match(ja, /百分率の数値（例：5 = 5%）/);
  assert.match(zh, /布林带信号/);
  assert.match(zh, /卖出条件/);
  assert.match(zh, /百分数、小数或基点；自动识别失败时手动指定/);
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
  assert.match(editor, /id="field-strategy-vix_dca-1-vix-buyEnabled"[^>]*role="switch"[^>]*aria-checked="false"/);
});

test("AND OR uses catalog choices and visually connects the enabled buy signal cards", () => {
  let state = createInitialWorkspaceState(catalog);
  state = workspaceReducer(state, { type: "strategy.add", id: "combined", presetId: "composite_dca" }, catalog);
  state = workspaceReducer(state, { type: "strategy.param", id: "combined", key: "rsi.buyEnabled", value: true });
  state = workspaceReducer(state, { type: "strategy.param", id: "combined", key: "accumulation.conditionLogic", value: "AND" });
  const html = renderEditor(state.draft.strategies.find(({ id }) => id === "combined"));
  assert.match(html, /class="strategy-condition-row"/);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /type="radio"(?=[^>]*value="AND")(?=[^>]*checked="")/);
  assert.match(html, /type="radio"[^>]*value="OR"/);
  assert.match(html, /class="condition-relationship"[^>]*data-logic="AND"/);
  assert.match(html, /condition-card[^>]*>VIX シグナル/);
  assert.match(html, /condition-card[^>]*>RSI シグナル/);
  assert.doesNotMatch(html, /<select[^>]*id="field-combined-accumulation-conditionLogic"/);
});

test("catalog selector offers five optional strategies and preserves required benchmarks", () => {
  const html = render(createInitialWorkspaceState(catalog), "zh");
  for (const preset of catalog.presets) {
    if (["monthly_dca", "lump_sum"].includes(preset.id)) assert.doesNotMatch(html, new RegExp(`value="${preset.id}"`));
    else assert.match(html, new RegExp(`value="${preset.id}"`));
  }
  assert.match(html, /role="switch"[^>]*aria-checked="true"/);
  assert.doesNotMatch(html, /strategy-run-target/);
  assert.match(html, /id="preset-to-add" aria-describedby="strategy-add-help"/);
  assert.match(html, /<p class="field-hint sr-only" id="strategy-add-help">/);
  assert.match(html, /aria-label="启用VIX 信号定投"/);
  assert.match(html, /aria-label="删除VIX 信号定投"/);
  assert.match(html, /<article class="strategy-card strategy-nav-card is-active">/);
  assert.doesNotMatch(html, /id="field-strategy-vix_dca-1-vix-symbol"/);

  const controls = renderToStaticMarkup(React.createElement(RunControls, {
    locale: "zh",
    runScope: "active",
    strategies: createInitialWorkspaceState(catalog).draft.strategies,
    activeStrategyId: "strategy-vix_dca-1",
    onTargetChange() {},
    canReset: false,
    onReset() {},
    availability: { disabled: false, reasonKey: null },
    busy: false,
    completedFeedback: false,
    onScopeChange() {},
    onRun() {},
  }));
  assert.doesNotMatch(controls, /run-scope-select|run-scope-help|<select/);
  assert.match(controls, /run-submit-button/);
  assert.match(controls, /run-reset-button/);
  assert.match(html, /<option value="vix_dca" disabled=""/);
});

test("strategy picker precedes summary cards and editing stays separate from the run target", () => {
  const html = render(createInitialWorkspaceState(catalog), "zh");
  const addIndex = html.indexOf('class="strategy-add"');
  const cardsIndex = html.indexOf('class="strategy-card-list"');
  assert.ok(addIndex >= 0 && cardsIndex > addIndex);
  assert.match(html, /class="strategy-card-open"[^>]*aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /strategy-run-target/);
  assert.doesNotMatch(html, /id="field-strategy-vix_dca-1-vix-symbol"/);
  assert.match(html, /role="switch"/);
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
