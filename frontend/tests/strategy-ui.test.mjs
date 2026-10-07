import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { StrategyNavigator } = require("../.test-output/features/strategies/StrategyWorkspace.js");
const { StrategyEditorForm } = require("../.test-output/features/strategies/StrategyEditorDialog.js");
const { RunActions } = require("../.test-output/features/runs/RunActions.js");
const { createInitialWorkspaceState, workspaceReducer } = require("../.test-output/features/strategies/model.js");
const { createCondition } = require("../.test-output/features/strategies/conditions.js");
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
        enabled: true,
        diagnostics: [],
      })),
    },
    dispatch() {},
    onAdd() {},
  }));
}

test("every catalog editor always contains ordered buy-limit, buy and sell blocks", () => {
  for (const locale of ["ja", "zh", "en"]) {
    for (const preset of catalog.presets) {
      const strategy = { id: `structure-${preset.id}`, presetId: preset.id, params: structuredClone(preset.defaultParams), rules: structuredClone(preset.defaultRules) };
      const html = renderEditor(strategy, locale);
      const limit = html.indexOf(`strategy-parameter-heading-${strategy.id}-buy_limits`);
      const buy = html.indexOf('data-rule-side="buy"');
      const sell = html.indexOf('data-rule-side="sell"');
      assert.ok(limit >= 0 && buy > limit && sell > buy, `${locale} ${preset.id} has all three ordered sections`);
      assert.equal((html.match(/data-rule-side=/g) ?? []).length, 2);
      if (preset.id === "ma_buy_only") {
        assert.match(html, locale === "ja" ? /売却なし/ : locale === "zh" ? /不卖出/ : /No sell rule/);
        const sellBlock = html.slice(sell);
        assert.doesNotMatch(sellBlock, /role="switch"|data-parameter-key=/);
      }
      if (["ma_buy_only", "ma_trend"].includes(preset.id)) {
        assert.match(html, /data-parameter-key="accumulation.maxSignalBuysPerMonth"/);
        assert.doesNotMatch(html, /data-parameter-key="accumulation.cashSafetyLimit"/);
      }
      if (["monthly_dca", "lump_sum"].includes(preset.id)) {
        assert.match(html, /data-parameter-key="scheduled.fundingMode"/);
        assert.match(html, locale === "ja" ? /上限なし/ : locale === "zh" ? /不设买入上限/ : /No limit/);
      }
    }
  }
});

function renderEditor(strategy, locale = "ja") {
  const preset = catalog.presets.find((item) => item.id === strategy.presetId);
  return renderToStaticMarkup(React.createElement(StrategyEditorForm, {
    catalog,
    strategy,
    preset,
    locale,
    errors: [],
    onChange() {},
    onRulesChange() {},
  }));
}

test("execution keeps play and reset available and only shows stop while busy", () => {
  for (const options of [
    { busy: false, run: null, availability: { disabled: false, reasonKey: null } },
    { busy: true, run: null, availability: { disabled: false, reasonKey: null } },
    { busy: false, run: { status: "completed" }, availability: { disabled: false, reasonKey: null } },
    { busy: false, run: null, availability: { disabled: true, reasonKey: "run.noStrategies" } },
  ]) {
    const html = renderToStaticMarkup(React.createElement(RunActions, {
      locale: "zh", canReset: true, onRun() {}, onReset() {}, onStop() {}, stopping: false, ...options,
    }));
    assert.equal((html.match(/<button /g) ?? []).length, options.busy ? 3 : 2);
    assert.doesNotMatch(html, /run-controls|run-control-main|run-reason|run-complete-feedback|<p /);
  }
});

test("all active phases announce their actual state with a spinner and enabled stop", () => {
  for (const status of ["queued", "loading", "running"]) {
    const html = renderToStaticMarkup(React.createElement(RunActions, {
      locale: "zh", busy: true, canReset: true, stopping: false,
      availability: { disabled: false, reasonKey: null }, onRun() {}, onReset() {}, onStop() {},
      run: { status, progress: { completedStrategies: 0, totalStrategies: 3 } },
    }));
    assert.match(html, /run-button-spinner/);
    assert.match(html, /class="button icon-only-button run-stop-button"[^>]*aria-label="停止计算"/);
    assert.match(html, /aria-busy="true" disabled=""/);
    assert.doesNotMatch(html, /run-status-panel|run-controls|run-complete-feedback/);
  }
});

test("the final result read keeps edits locked without offering to stop a terminal job", () => {
  const html = renderToStaticMarkup(React.createElement(RunActions, {
    locale: "zh", busy: true, canStop: false, canReset: true, stopping: false,
    availability: { disabled: false, reasonKey: null }, onRun() {}, onReset() {}, onStop() {},
    run: { status: "completed", progress: { completedStrategies: 3, totalStrategies: 3 } },
  }));
  assert.match(html, /aria-busy="true" disabled=""/);
  assert.doesNotMatch(html, /run-stop-button/);
  assert.equal((html.match(/<button /g) ?? []).length, 2);
});

test("fixed strategy uses independent buy sell cards and header switches without composition", () => {
  const state = createInitialWorkspaceState(catalog);
  const html = renderEditor(state.draft.strategies[0]);
  assert.match(html, /class="strategy-rule-section[^\"]*" data-rule-side="buy"/);
  assert.match(html, /class="strategy-rule-section[^\"]*" data-rule-side="sell"/);
  assert.match(html, /class="condition-card[^\"]*" data-condition-kind="vix"/);
  assert.match(html, /class="condition-heading"[\s\S]*role="switch"/);
  assert.doesNotMatch(html, /condition-relationship|strategy-condition-row|condition-add|condition-logic-connector|field-switch/);
  const sharedField = readFileSync(new URL("../src/shared/ui/ParameterField.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(sharedField, /appearance === "segments"|hideLabel|optionHints/);
});

test("custom strategy shows an unlimited placeholder for a blank monthly buy limit", () => {
  const state = workspaceReducer(createInitialWorkspaceState(catalog), { type: "strategy.add", id: "custom", presetId: "composite_dca" }, catalog);
  const strategy = state.draft.strategies.find(item => item.id === "custom");
  assert.equal(strategy.params["accumulation.maxSignalBuysPerMonth"], null);
  assert.match(renderEditor(strategy, "ja"), /placeholder="制限なし"/);
  assert.match(renderEditor(strategy, "zh"), /placeholder="不限次数"/);
});

test("strategy menu and reducer consume the same catalog instance limits", () => {
  const restricted = { ...catalog, strategyLimits: { maxInstancesPerPreset: 2, maxTotalInstances: 3 } };
  let state = createInitialWorkspaceState(restricted);
  const renderCurrent = () => renderToStaticMarkup(React.createElement(StrategyNavigator, { catalog: restricted, locale: "ja", state, validation: null, dispatch() {}, onAdd() {} }));
  assert.doesNotMatch(renderCurrent(), /data-preset-id="vix_dca" disabled/);
  state = workspaceReducer(state, { type: "strategy.add", id: "second-vix", presetId: "vix_dca" }, restricted);
  assert.equal(state.draft.strategies.filter(item => item.presetId === "vix_dca").length, 2);
  state = workspaceReducer(state, { type: "strategy.add", id: "custom-1", presetId: "composite_dca" }, restricted);
  const html = renderCurrent();
  assert.match(html, /data-preset-id="vix_dca" disabled/);
  assert.match(html, /data-preset-id="composite_dca" disabled/);
  assert.equal(workspaceReducer(state, { type: "strategy.add", id: "another-rsi", presetId: "rsi_dca" }, restricted), state);
});

test("strategy cards expose a direct copy icon and no more-actions dialog", () => {
  const html = render(createInitialWorkspaceState(catalog));
  assert.match(html, /class="icon-button strategy-copy"/);
  assert.doesNotMatch(html, /strategy-more|strategy-tools-dialog/);
});

test("strategy editor keeps one label per field and no repeated parameter summary", () => {
  const state = createInitialWorkspaceState(catalog);
  const html = renderEditor(state.draft.strategies[0]);
  assert.match(html, /ボラティリティ積立/);
  assert.doesNotMatch(html, /strategy-editor-summary|strategy-parameter-nav/);
  assert.match(html, /id="field-strategy-vix_dca-1-vix-symbol"/);
  assert.match(html, /VXN — Nasdaq 100 ボラティリティ指数/);
  assert.match(html, /VXD — Dow Jones ボラティリティ指数/);
  assert.match(html, /<h3 id="strategy-parameter-heading-strategy-vix_dca-1-vix">買付<span class="condition-kind-name">ボラティリティ<\/span><\/h3>/);
  assert.match(html, /この条件で使う指数。/);
  assert.equal(Object.hasOwn(createInitialWorkspaceState(catalog), "runScope"), false);
});

test("strategy parameters follow catalog groups and select controls explain their choices", () => {
  const initial = createInitialWorkspaceState(catalog);
  const composite = workspaceReducer(initial, {
    type: "strategy.add",
    id: "strategy-composite-groups",
    presetId: "composite_dca",
  }, catalog);
  const strategy = composite.draft.strategies.find((item) => item.id === "strategy-composite-groups");
  strategy.rules.buy.children.push(...["rsi", "bollinger", "rate"].map(kind => createCondition(catalog, kind, "buy", `buy-${kind}`)));
  strategy.rules.sell.enabled = true;
  strategy.rules.sell.children = [createCondition(catalog, "bollinger", "sell", "sell-bollinger")];
  const ja = renderEditor(strategy, "ja");
  const zh = renderEditor(strategy, "zh");

  assert.ok((ja.match(/class="strategy-parameter-group"/g) ?? []).length >= 1);
  assert.match(ja, /ボリンジャー/);
  assert.match(ja, /data-rule-side="sell"/);
  assert.match(ja, /role="radiogroup" aria-label="隣接する条件カードの関係"/);
  assert.match(ja, /title="有効な条件すべて"/);
  assert.match(ja, /title="有効な条件のいずれか"/);
  assert.doesNotMatch(ja, /有効な買付条件すべて：AND = 全条件、OR = いずれか。/);
  assert.doesNotMatch(ja, /strategy-parameter-nav|strategy-editor-summary/);
  assert.match(ja, /百分率の数値（例：5 = 5%）/);
  assert.match(zh, /布林带/);
  assert.match(zh, /data-rule-side="sell"/);
  assert.match(zh, /title="满足本组所有启用条件"/);
  assert.match(zh, /title="满足本组任一启用条件"/);
  assert.match(zh, /默认 Yahoo 利率以 % 报价；其他序列按来源选择单位。/);
});

test("turning off VIX shows the required disabled copy and preserves the preset id", () => {
  const initial = createInitialWorkspaceState(catalog);
  const state = workspaceReducer(initial, {
    type: "strategy.rules",
    id: initial.activeStrategyId,
    value: { ...initial.draft.strategies[0].rules, buy: { ...initial.draft.strategies[0].rules.buy, enabled: false } },
  });
  const html = render(state);
  const editor = renderEditor(state.draft.strategies[0]);
  assert.equal(state.draft.strategies[0].presetId, "vix_dca");
  assert.match(html, /買付条件オフ/);
  assert.doesNotMatch(html, /VIX ≥ 25/);
  assert.match(editor, /role="switch"[^>]*aria-label="買付"[^>]*aria-checked="false"/);
});

test("AND OR uses catalog choices and visually connects the enabled buy signal cards", () => {
  let state = createInitialWorkspaceState(catalog);
  state = workspaceReducer(state, { type: "strategy.add", id: "combined", presetId: "composite_dca" }, catalog);
  const rules = structuredClone(state.draft.strategies[1].rules);
  rules.buy.children.push(createCondition(catalog, "rsi", "buy", "buy-rsi"));
  rules.buy.operator = "AND";
  state = workspaceReducer(state, { type: "strategy.rules", id: "combined", value: rules });
  const html = renderEditor(state.draft.strategies.find(({ id }) => id === "combined"));
  assert.match(html, /class="condition-logic-connector" data-group-id="buy-root"/);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /type="radio"(?=[^>]*value="AND")(?=[^>]*checked="")/);
  assert.match(html, /type="radio"[^>]*value="OR"/);
  assert.match(html, /class="condition-logic-line"/);
  assert.match(html, /data-condition-kind="vix"/);
  assert.match(html, /data-condition-kind="rsi"/);
  assert.doesNotMatch(html, /condition-relationship|strategy-condition-row/);
  assert.doesNotMatch(html, /<select[^>]*id="field-combined-accumulation-conditionLogic"/);
});

test("catalog selector offers five optional strategies and preserves required benchmarks", () => {
  const html = render(createInitialWorkspaceState(catalog), "zh");
  for (const preset of catalog.presets) {
    if (["monthly_dca", "lump_sum"].includes(preset.id)) assert.doesNotMatch(html, new RegExp(`data-preset-id="${preset.id}"`));
    else assert.match(html, new RegExp(`data-preset-id="${preset.id}"`));
  }
  assert.doesNotMatch(html, /role="switch"/);
  assert.doesNotMatch(html, /strategy-run-target/);
  assert.match(html, /class="strategy-add-option"[^>]*data-preset-id="composite_dca"/);
  assert.match(html, /id="strategy-add-menu"[^>]*role="menu"/);
  assert.doesNotMatch(html, /strategy-enabled-control|status-tag/);
  assert.match(html, /aria-label="删除波动率信号定投"/);
  assert.match(html, /<article class="strategy-card strategy-nav-card is-active">/);
  assert.doesNotMatch(html, /id="field-strategy-vix_dca-1-vix-symbol"/);

  const controls = renderToStaticMarkup(React.createElement(RunActions, {
    locale: "zh",
    canReset: false,
    onReset() {},
    availability: { disabled: false, reasonKey: null },
    busy: false,
    run: null,
    onRun() {},
  }));
  assert.doesNotMatch(controls, /run-scope-select|run-scope-help|<select/);
  assert.match(controls, /run-submit-button/);
  assert.match(controls, /run-reset-button/);
  assert.match(html, /class="icon-button strategy-copy"[^>]*aria-label="复制波动率信号定投"/);
});

test("strategy picker precedes summary cards and editing stays separate from the run target", () => {
  const html = render(createInitialWorkspaceState(catalog), "zh");
  const addIndex = html.indexOf('class="strategy-add"');
  const cardsIndex = html.indexOf('class="strategy-card-list"');
  assert.ok(addIndex >= 0 && cardsIndex > addIndex);
  assert.match(html, /class="strategy-card-open"[^>]*aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /strategy-run-target/);
  assert.doesNotMatch(html, /id="field-strategy-vix_dca-1-vix-symbol"/);
  assert.doesNotMatch(html, /role="switch"/);
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
  assert.match(html, /aria-label="编辑波动率信号定投"/);
  assert.match(html, /aria-label="编辑自定义策略"/);
  assert.doesNotMatch(html, /id="field-strategy-(?:vix_dca-1-vix-symbol|composite-1-accumulation-fixedDcaRatio)"/);
});
