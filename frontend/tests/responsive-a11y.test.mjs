import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { readStyles, readTranslationSources } from "./helpers/readSources.mjs";

function chartSources() {
  const folder = new URL("../src/features/results/chart/", import.meta.url);
  return [readFileSync(new URL("../src/features/results/ResultsCharts.tsx", import.meta.url), "utf8"),
    ...readdirSync(folder).filter(name => /\.tsx?$/.test(name)).sort().map(name => readFileSync(new URL(name, folder), "utf8"))].join("\n");
}
import test from "node:test";

const css = readStyles();
const prototype = readFileSync(new URL("../e2e/fixtures/workbench-reference.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const settingsDialog = readFileSync(new URL("../src/features/config/SharedSettingsDialog.tsx", import.meta.url), "utf8");
const dividerSource = readFileSync(new URL("../src/shared/ui/WorkbenchDivider.tsx", import.meta.url), "utf8");
const runActions = readFileSync(new URL("../src/features/runs/RunActions.tsx", import.meta.url), "utf8");

function luminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map((channel) => parseInt(channel, 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function blockFor(selector) {
  let start = css.indexOf(selector);
  while (start !== -1 && (
    css.slice(css.lastIndexOf("\n", start - 1) + 1, start).trim() !== "" ||
    !/^\s*\{/.test(css.slice(start + selector.length))
  )) {
    start = css.indexOf(selector, start + 1);
  }
  assert.notEqual(start, -1, `missing CSS block for ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`unclosed CSS block for ${selector}`);
}

function mediaBlock(query) {
  const start = css.indexOf(`${query} {`);
  assert.notEqual(start, -1, `missing media query ${query}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`unclosed media query ${query}`);
}

test("320px, 768px, and 1024px widths follow the responsive layout rules", () => {
  const phone = mediaBlock("@media (max-width: 420px)");
  assert.match(blockFor("body"), /min-width:\s*320px/);
  assert.match(blockFor(".main-content"), /width:\s*min\(100% - 48px, 1180px\)/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*?\.main-content\s*\{[^}]*width:\s*min\(100% - 30px, 1180px\)/s);
  assert.match(phone, /\.main-content\s*\{[^}]*width:\s*min\(100% - 24px, 1180px\)/s);
  assert.match(phone, /\.strategy-parameter-grid\s*\{[^}]*minmax\(0, 1fr\)/s);
  assert.match(blockFor(".shared-settings-grid"), /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(blockFor(".shared-settings-fields-asset"), /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(blockFor(".shared-settings-fields-range"), /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.shared-settings-fields-range\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(blockFor(".shared-settings-fields-funding"), /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*?\.shared-settings-dialog \.shared-settings-fields-range,[\s\S]*?\.shared-settings-dialog \.shared-settings-fields-funding\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(blockFor(".shared-settings-group"), /min-width:\s*0/);
  assert.match(blockFor(".strategy-card-name"), /overflow-wrap:\s*anywhere/);
  assert.match(blockFor(".strategy-card-summary"), /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(app, /className="page-heading"/);
});

test("desktop workbench keeps top controls fixed with independent strategy list and results scrolling", () => {
  const main = blockFor(".main-content.workbench-main");
  const layout = blockFor(".workbench-layout");
  const configuration = blockFor(".workbench-config-fixed");
  const strategyList = blockFor(".strategy-navigator .strategy-card-list");
  const results = blockFor(".workbench-results");
  const divider = blockFor(".workbench-divider");
  assert.match(main, /width:\s*calc\(100% - 32px\)/);
  assert.match(main, /max-width:\s*1920px/);
  assert.match(layout, /grid-template-columns:\s*320px 24px minmax\(0,\s*1fr\)/);
  assert.match(configuration, /position:\s*relative/);
  assert.match(strategyList, /min-height:\s*0/);
  assert.match(strategyList, /overflow-y:\s*auto/);
  assert.match(results, /min-height:\s*0/);
  assert.match(results, /overflow-y:\s*auto/);
  assert.match(divider, /align-content:\s*start/);
  assert.doesNotMatch(dividerSource, /role="separator"|setPointerCapture/);
  const tablet = mediaBlock("@media (min-width: 768px) and (max-width: 1279px)");
  assert.match(tablet, /\.workbench-layout\s*\{[^}]*display:\s*grid/s);
  assert.match(tablet, /\.workbench-config\s*\{[^}]*position:\s*relative/s);
  assert.match(tablet, /\.workbench-results\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(blockFor(".app-topbar"), /position:\s*sticky/);
  assert.match(app, /<header[^>]*className="app-topbar">[\s\S]*?className="topbar-brand"[\s\S]*?<RunActions/);
  assert.doesNotMatch(app, /className="page-heading"/);
});

test("the workbench separator is a centered one-pixel rule rather than a responsive gradient", () => {
  const divider = blockFor(".workbench-divider");
  const rule = blockFor(".workbench-divider::before");
  assert.doesNotMatch(divider, /linear-gradient/);
  assert.match(divider, /background:\s*none/);
  assert.match(rule, /position:\s*absolute/);
  assert.match(rule, /left:\s*50%/);
  assert.match(rule, /transform:\s*translateX\(-50%\)/);
  assert.match(rule, /top:\s*0/);
  assert.match(rule, /bottom:\s*0/);
  assert.match(rule, /width:\s*1px/);
});

test("performance explanations have a visible hover and keyboard-focus presentation", () => {
  const card = blockFor(".performance-stat");
  const tooltip = blockFor(".performance-help-tooltip");
  assert.match(card, /position:\s*relative/);
  assert.match(tooltip, /visibility:\s*hidden/);
  assert.match(tooltip, /position:\s*absolute/);
  assert.match(css, /\.performance-stat:hover\s*>\s*\.performance-help-tooltip[\s\S]*?\.performance-stat:focus-visible\s*>\s*\.performance-help-tooltip/);
  assert.match(css, /\.performance-basis:hover\s*>\s*\.performance-help-tooltip[\s\S]*?\.performance-basis:focus-visible\s*>\s*\.performance-help-tooltip/);
  assert.match(tooltip, /max-width:\s*min\(320px, calc\(100vw - 32px\)\)/);
});

test("returns share the global red/green direction and monthly heatmaps use fixed four-level colors", () => {
  assert.match(css, /--return-red:\s*#b71c1c/);
  assert.match(css, /--return-green:\s*#087443/);
  assert.match(blockFor('.app-frame[data-return-palette="red-up"]'), /--return-positive:\s*var\(--return-red\)/);
  assert.match(css, /--heatmap-red-1:\s*#ef4a4a/);
  assert.match(css, /--heatmap-red-2:\s*#f72d2d/);
  assert.match(css, /--heatmap-red-3:\s*#bf2222/);
  assert.match(css, /--heatmap-red-4:\s*#9a1a1a/);
  assert.match(css, /--heatmap-green-1:\s*#18d57f/);
  assert.match(css, /--heatmap-green-2:\s*#1dc87a/);
  assert.match(css, /--heatmap-green-3:\s*#0c9a5a/);
  assert.match(css, /--heatmap-green-4:\s*#087443/);
  assert.match(css, /\.heatmap-cell\.is-positive,\s*\.heatmap-cell\.is-negative\s*\{[^}]*color:\s*#fff/s);
  assert.match(css, /\.heatmap-cell\.is-positive\.is-level-1\s*\{[^}]*background:\s*var\(--heatmap-positive-1\)/s);
  assert.match(css, /\.heatmap-cell\.is-negative\.is-level-4\s*\{[^}]*background:\s*var\(--heatmap-negative-4\)/s);
  assert.match(blockFor(".return-value.is-positive"), /color:\s*var\(--return-positive\)/);
  assert.match(blockFor(".return-value.is-negative"), /color:\s*var\(--return-negative\)/);
  assert.ok(contrastRatio("#ffffff", "#b71c1c") >= 4.5);
  assert.ok(contrastRatio("#ffffff", "#087443") >= 4.5);
  for (const [tone, color] of [["positive", "#087443"], ["negative", "#b71c1c"]]) {
    assert.match(blockFor(`.search-heat-cell.is-${tone}`), /var\(--heat-strength\) \* 40%/);
    const strongestTint = `#${color.slice(1).match(/../g).map(channel =>
      Math.round(parseInt(channel, 16) * .12 + 255 * .88).toString(16).padStart(2, "0")).join("")}`;
    assert.ok(contrastRatio(color, strongestTint) >= 4.5);
  }
});

test("table sort controls share keyboard-visible styles", () => {
  assert.match(css, /\.table-sort\.is-sorted\s*\{[^}]*color:\s*var\(--app-accent\)/s);
  assert.match(css, /\.table-sort:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--app-accent\)/s);
});

test("phone workbench stacks configuration and results under the fixed topbar", () => {
  assert.doesNotMatch(app, /workbench-mobile-views|data-mobile-panel|mobilePanel/);
  assert.doesNotMatch(css, /workbench-mobile-views/);
  assert.match(app, /hidden=\{configCollapsed && !isPhone\}/);
  assert.match(css, /\.workbench-config-toggle\s*\{\s*display:\s*none/s);
  assert.match(blockFor(".app-topbar"), /position:\s*sticky/);
  assert.doesNotMatch(prototype, /class="mobile-views"/);
});

test("the design prototype mirrors the flattened workbench and result hierarchy", () => {
  assert.match(prototype, /<dialog class="shared-dialog"/);
  assert.match(prototype, /<dialog class="strategy-dialog"/);
  assert.match(prototype, /class="shared-settings"[^>]*aria-haspopup="dialog"/);
  assert.match(prototype, /class="strategy-card-list"/);
  assert.doesNotMatch(prototype, /class="editor-scroll"|class="page-heading"|class="run-summary-card"|class="details-entry"/);
  assert.match(prototype, /class="icon-button config-toggle"[^>]*aria-expanded="true"/);
  assert.doesNotMatch(prototype, /role="tablist" aria-label="実行結果の詳細"/);
  assert.ok(prototype.indexOf('id="prototype-result-details"') < prototype.indexOf('id="prototype-chart-panel"'));
  assert.match(prototype, /position:\s*sticky; z-index: 4; top: 0/);
  assert.match(prototype, /\.price-line[^}]*stroke-width:\s*1\.2/);
  assert.match(prototype, /\.asset-line[^}]*stroke-width:\s*1\.2/);
  assert.match(prototype, /#backtest-ui-preview \.shared-settings-copy span[^}]*font-size: 12px/);
  assert.match(prototype, /#backtest-ui-preview \.strategy-card-summary[^}]*font-size: 12px/);
  assert.match(prototype, /height:\s*100dvh/);
  assert.match(prototype, /class="comparison-primary"/);
  assert.doesNotMatch(prototype, /data-panel="comparison"|data-tab="comparison"|prototype-result-focus|data-tab="overview"|data-tab="metrics"/);
  assert.ok(prototype.indexOf('class="comparison-primary"') < prototype.indexOf('id="prototype-details-panel"'));
  assert.match(prototype, /class="detail-content" id="prototype-details-panel"/);
  assert.match(prototype, /Ctrl\/Command＋スクロールは全図を同期して拡大・縮小/);
  assert.doesNotMatch(prototype, /result-run-id|strategy-vix_dca-1|candidate-[0-9]/);
});

test("wide data tables scroll inside their panels instead of widening the page", () => {
  const scrollPanel = blockFor(".comparison-table-scroll,\n.data-table-scroll");
  assert.match(scrollPanel, /max-width:\s*100%/);
  assert.match(scrollPanel, /overflow-x:\s*auto/);
  assert.match(blockFor(".search-table"), /min-width:\s*720px/);
  assert.match(blockFor(".search-table td:last-child"), /white-space:\s*normal/);
});

test("comparison and trade tables permit vertical scroll chaining without losing horizontal containment", () => {
  const panel = blockFor(".comparison-table-scroll,\n.trade-table-scroll");
  assert.match(panel, /overscroll-behavior:\s*contain auto/);
});

test("expanded table titles share the results-scroll sticky behavior and stay within the owning table", () => {
  const controls = blockFor(".table-height-region.is-height-expanded .table-height-controls");
  const performanceHeading = blockFor(".performance-group.is-height-expanded > .performance-group-heading");
  assert.match(controls, /position:\s*sticky/);
  assert.match(controls, /top:\s*var\(--table-expanded-sticky-top/);
  assert.match(performanceHeading, /position:\s*sticky/);
  assert.match(performanceHeading, /top:\s*var\(--table-expanded-sticky-top/);
  assert.match(css, /\.collapsible-panel:has\(\.is-height-expanded\)\s*\{\s*overflow:\s*clip;/);
  assert.match(css, /\.comparison-table-region\.is-height-expanded \.comparison-table thead[\s\S]*?position:\s*static/s);
  assert.match(css, /\.trade-table-region\.is-height-expanded \.trade-table-scroll thead th[\s\S]*?position:\s*static/s);
  assert.match(css, /--table-expanded-sticky-top:\s*var\(--app-topbar-height\)/);
});

test("coarse-pointer inputs and buttons have at least 44px targets", () => {
  const touch = mediaBlock("@media (pointer: coarse)");
  assert.match(touch, /button,[\s\S]*\.input,[\s\S]*min-height:\s*44px/);
  assert.match(touch, /\.checkbox-control\s*\{\s*min-height:\s*44px/);
  assert.match(touch, /\.input\s*\{\s*font-size:\s*16px/);
  assert.match(touch, /\.icon-button\s*\{\s*min-width:\s*44px/);
  assert.doesNotMatch(css, /strategy-enabled-control/);
  assert.match(dividerSource, /aria-expanded=\{!collapsed\}/);
  assert.match(touch, /\.execution-actions \.button,[\s\S]*?\.add-strategy-button \{\s*min-height:\s*44px/s);
  assert.match(touch, /\.workbench-results \.legend-toggle,[\s\S]*?\.workbench-results \.chart-range-controls button,[\s\S]*?\.add-strategy-button \{\s*min-height:\s*44px/s);
});

test("catalog fields use aligned bold labels, 40px controls, and in-field units", () => {
  assert.match(blockFor(".field-label"), /font-size:\s*13px/);
  assert.match(blockFor(".field-label"), /font-weight:\s*650/);
  assert.match(blockFor(".input"), /min-height:\s*40px/);
  assert.match(css, /\.checkbox-control \{\s*min-height:\s*40px/);
  assert.match(blockFor(".unit-field.has-unit .input"), /padding-right:\s*76px/);
  assert.match(css, /\.unit-label \{[^}]*position:\s*absolute/s);
  assert.match(css, /\.field-hint \{[^}]*font-size:\s*12px/s);
});

test("keyboard focus, skip navigation, and reduced motion remain visible and supported", () => {
  assert.match(css, /button:focus-visible,[\s\S]*summary:focus-visible,[\s\S]*#result-details:focus-visible,[\s\S]*\.workbench-divider:focus-visible\s*\{\s*outline:\s*3px solid/);
  assert.match(css, /\.skip-link:focus\s*\{\s*transform:\s*translateY\(0\)/);
  const reducedMotion = mediaBlock("@media (prefers-reduced-motion: reduce)");
  assert.match(reducedMotion, /animation-duration:\s*0\.01ms/);
  assert.match(css, /\.sr-only\s*\{[\s\S]*clip:\s*rect\(0, 0, 0, 0\)/);
});

test("semantic text colors meet WCAG AA contrast against their surfaces", () => {
  const token = name => {
    const value = css.match(new RegExp(`--app-${name}:\\s*([^;]+)`, "i"))[1].trim();
    const reference = value.match(/^var\(--app-([\w-]+)\)$/);
    if (reference) return token(reference[1]);
    return value.length === 4 ? `#${[...value.slice(1)].map(channel => channel.repeat(2)).join("")}` : value;
  };
  const pairs = [
    [token("surface"), token("accent")],
    [token("foreground"), token("bg")],
    [token("muted"), token("bg")],
    [token("accent"), token("surface")],
    [token("foreground"), token("control-muted-bg")],
    [token("accent-text"), token("accent-soft")],
    [token("action-text"), token("action")],
    [token("foreground"), token("selection-bg")],
    ["#74460e", "#faedcf"],
    ["#842a2d", "#f6e0e1"],
    ["#825013", "#f7ecd8"],
  ];
  for (const [foreground, background] of pairs) {
    assert.ok(contrastRatio(foreground, background) >= 4.5, `${foreground} on ${background} is below 4.5:1`);
  }
  assert.ok(contrastRatio(token("focus"), token("bg")) >= 3, "focus outline should remain visible as a UI indicator");
});

test("Light and Dark share accessible semantic tokens", () => {
  const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8").toLowerCase();
  assert.doesNotMatch(tokens, /data-theme="(?:blue|mint)"|#def5e5/);
  const base = blockFor(":root");
  const overrides = ["", ...["dark"].map(id => blockFor(`:root[data-theme="${id}"]`))];
  for (const override of overrides) {
    const values = Object.fromEntries([...`${base} ${override}`.matchAll(/--app-([\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
    const color = name => values[name].startsWith("var(") ? color(values[name].slice(10, -1)) : values[name] === "#fff" ? "#ffffff" : values[name];
    for (const [fg, bg] of [["foreground","bg"], ["muted","surface"], ["accent","surface"], ["action-text","action"], ["foreground","selection-bg"]]) assert.ok(contrastRatio(color(fg),color(bg)) >= 4.5, `${fg} on ${bg}: ${override}`);
  }
});

test("coarse-pointer workbench divider keeps a 44px hit area", () => {
  const touch = mediaBlock("@media (pointer: coarse)");
  assert.match(touch, /\.workbench-layout\s*\{\s*grid-template-columns:\s*320px 44px minmax\(0,\s*1fr\)/);
  assert.match(touch, /\.workbench-divider\s*\{\s*min-width:\s*44px/);
  const tabletTouch = mediaBlock("@media (pointer: coarse) and (min-width: 768px) and (max-width: 1279px)");
  assert.match(tabletTouch, /grid-template-columns:\s*280px 44px minmax\(0, 1fr\)/);
  assert.match(tabletTouch, /\.workbench-divider\s*\{\s*display:\s*grid/);
  assert.match(prototype, /\.config-toggle\s*\{\s*width:\s*44px;\s*min-width:\s*44px;\s*min-height:\s*44px/);
});

test("workbench explanatory text meets the readable type scale", () => {
  assert.match(blockFor(".shared-settings-summary-text"), /font-size:\s*12px/);
  assert.match(blockFor(".strategy-nav-card .strategy-card-summary"), /font-size:\s*12px/);
  assert.match(blockFor(".strategy-nav-card .strategy-card-summary"), /-webkit-line-clamp:\s*2/);
  assert.match(blockFor(".result-detail-name"), /font-size:\s*13px/);
  assert.doesNotMatch(app, /result-focus-select/);
});

test("all result table scrollers share one vertical max-height", () => {
  assert.match(css, /--result-table-max-height:\s*min\(360px,\s*45dvh\)/);
  const sharedScrollerRule = css.match(/\.comparison-table-scroll,\s*\.trade-table-scroll,\s*\.search-table-scroll,\s*\.performance-table-scroll,\s*\.search-lab-scroll\s*\{([^}]*)\}/s);
  assert.ok(sharedScrollerRule, "every results table scroller belongs to the shared rule");
  assert.match(sharedScrollerRule[1], /max-height:\s*var\(--result-table-max-height\)/);
  assert.match(sharedScrollerRule[1], /overflow-y:\s*auto/);
});

test("only selected comparison rows use an identity tint without translating sticky cells", () => {
  assert.doesNotMatch(css, /\.comparison-table[^{}]*\.is-focused/);
  assert.doesNotMatch(blockFor(".comparison-table tbody tr.is-selected"), /translate:/);
  assert.match(css, /\.comparison-table tbody tr\.is-selected\s*\{[^}]*--table-row-background:\s*color-mix/s);
});

test("the fixed strategy navigator does not stretch cards to fill unused height", () => {
  const navigator = blockFor(".strategy-navigator");
  const cards = blockFor(".strategy-navigator .strategy-card-list");
  assert.match(navigator, /grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  assert.match(navigator, /overflow:\s*visible/);
  assert.match(cards, /align-content:\s*start/);
  assert.match(cards, /min-height:\s*0/);
  assert.match(cards, /overflow-y:\s*auto/);
});

test("shared settings use a modal and the sidebar toggle has one fixed location", () => {
  assert.match(app, /className="button shared-settings-summary shared-settings-open-button"[\s\S]*aria-haspopup="dialog"[\s\S]*aria-describedby="shared-settings-summary-detail"/);
  assert.match(app, /className="shared-settings-summary-text"\s+id="shared-settings-summary-detail"/);
  assert.doesNotMatch(app, /className="button icon-only-button shared-settings-open-button"/);
  assert.match(app, /<SharedSettingsDialog/);
  assert.match(settingsDialog, /<ModalShell[\s\S]*onRequestClose=\{closeDialog\}/);
  const shell = readFileSync(new URL("../src/shared/ui/ModalShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /aria-modal="true"/);
  assert.match(shell, /dialog\.showModal\(\)/);
  assert.match(shell, /onCancel=\{/);
  assert.match(app, /<aside[\s\S]*?<WorkbenchDivider[\s\S]*?id="workbench-results-panel"/);
  assert.match(dividerSource, /className="button workbench-config-toggle icon-only-button"/);
  assert.doesNotMatch(app, /className="workbench-config-header"[\s\S]*?workbench-config-toggle/);
  assert.match(dividerSource, /aria-expanded=\{!collapsed\}[\s\S]*onClick=\{onToggle\}/);
  assert.match(app, /onToggle=\{\(\) => setConfigCollapsed\(\(current\) => !current\)\}/);
  assert.doesNotMatch(app, /className="workbench-config-header"/);
  assert.doesNotMatch(app, /className="results-heading"/);
  assert.doesNotMatch(app, /<details className="shared-settings-disclosure"/);
  const tablet = mediaBlock("@media (min-width: 768px) and (max-width: 1279px)");
  assert.doesNotMatch(tablet, /--app-topbar-height\s*:|grid-template-areas/);
  assert.match(blockFor(":root"), /--app-topbar-height:\s*55px/);
  assert.match(tablet, /\.main-content\.workbench-main\s*\{[^}]*height:\s*calc\(100dvh - var\(--app-topbar-height\) - 26px\)/s);
  assert.match(tablet, /\.workbench-layout\s*\{[^}]*min-height:\s*0/s);
});

test("space-saving workbench controls retain an accessible text name", () => {
  assert.match(dividerSource, /aria-label=\{label\}/);
  assert.match(dividerSource, /collapsed \? "m7 5 5 5-5 5"/);
  assert.match(app, /label=\{translate\(locale, configCollapsed \? "workbench\.showConfig" : "workbench\.hideConfig"\)\}/);
  assert.match(runActions, /aria-label=\{label\}/);
  assert.match(runActions, /aria-describedby=\{reason \? "run-disabled-reason" : undefined\}/);
  assert.match(runActions, /className="run-play-icon"/);
  assert.doesNotMatch(runActions, /run-scope-select/);
  assert.doesNotMatch(runActions, /translate\(locale, "run\.submit"\)<\/button>/);
  assert.doesNotMatch(css, /\.display-toggle|\.result-display-heading|\.result-display-toggles/);
});

test("primary workbench actions use the accent fill and selected chart modes are easy to spot", () => {
  assert.match(blockFor(".workbench-config-toggle"), /background:\s*var\(--app-bg\)/);
  assert.doesNotMatch(blockFor(".workbench-config-toggle:hover svg,\n.workbench-config-toggle:focus-visible svg"), /background:|color:/);
  assert.match(css, /\.workbench-config-toggle:hover svg[\s\S]*?stroke-width:\s*2\.8/s);
  assert.match(blockFor(".add-strategy-button"), /background:\s*var\(--app-action\)/);
  assert.match(blockFor(".chart-wheel-zoom-toggle[aria-pressed=\"true\"]"), /background:\s*var\(--app-accent\)/);
});

test("base button styles precede and preserve emphasized action colors", () => {
  const buttonRule = css.indexOf("\n.button {");
  for (const selector of [".workbench-config-toggle", ".shared-settings-open-button", ".add-strategy-button", ".button-primary"]) {
    assert.ok(css.indexOf(`\n${selector} {`) > buttonRule, `${selector} follows base button styles`);
  }
  assert.match(blockFor(".button-primary"), /background:\s*var\(--app-action\)/);
  assert.match(blockFor(".workbench-config-toggle"), /background:\s*var\(--app-bg\)/);
  assert.match(blockFor(".add-strategy-button"), /background:\s*var\(--app-action\)/);
  assert.doesNotMatch(app, /shared-settings-summary-icon|local-tag/);
});

test("wheel zoom mode and primary run icon have clear visual affordances", () => {
  assert.match(runActions, /className="run-play-icon"/);
  assert.match(css, /\.button-primary\s*\{[^}]*background:\s*var\(--app-action\)/);
  assert.match(css, /\.run-submit-button\s*\{[^}]*width:\s*48px/s);
  assert.match(css, /\.chart-wheel-zoom-toggle\[aria-pressed="true"\]/);
  assert.match(css, /\.shared-settings-dialog/);
});


test("sidebar actions float only on hover or keyboard focus, with a touch fallback", () => {
  const actions = blockFor(".strategy-nav-card .strategy-card-actions");
  assert.match(actions, /position:\s*absolute/);
  assert.match(actions, /opacity:\s*0/);
  assert.match(css, /\.strategy-nav-card:hover \.strategy-card-actions,[\s\S]*?\.strategy-nav-card:has\(:focus-visible\) \.strategy-card-actions/);
  assert.match(mediaBlock("@media (pointer: coarse)"), /\.strategy-nav-card \.strategy-card-actions\s*\{[^}]*opacity:\s*1/s);
  assert.match(blockFor(".workbench-config-toggle"), /border:\s*0/);
});


test("SVG chart labels cannot be selected by drag gestures", () => {
  assert.match(blockFor(".result-chart"), /user-select:\s*none/);
  assert.match(css, /\.chart-linked-stack \.chart-panel\.is-compact \.result-chart\s*\{[^}]*aspect-ratio:\s*auto/s);
});

test("linked figures have no separator and keep one shared readout under the core heading", () => {
  const compact = blockFor(".workbench-results .chart-linked-stack .chart-panel.is-compact");
  assert.doesNotMatch(compact, /border-top|padding-top:\s*[1-9]/);
  const charts = chartSources();
  assert.match(blockFor(".chart-core-readout-row"), /height:\s*auto/);
  assert.match(blockFor(".chart-core-readout-row"), /overflow:\s*visible/);
  assert.doesNotMatch(charts, /chart-readout-lines|chart-core-readout-row[^>]*tabIndex/);
  assert.match(css, /\.chart-crosshair-readout\s*\{[^}]*position:\s*static/s);
  assert.doesNotMatch(charts, /chart-indicator-readout-row/);
  assert.equal((charts.match(/<ChartReadout\b/g) ?? []).length, 1);
  assert.doesNotMatch(prototype, /\.compact-indicator\s*\{[^}]*border-top/s);
});

test("removed result controls have no reducer, rendering, translation or style implementation", () => {
  const model = readFileSync(new URL("../src/features/strategies/model.ts", import.meta.url), "utf8");
  const details = readFileSync(new URL("../src/features/results/ResultDetails.tsx", import.meta.url), "utf8");
  const messages = readTranslationSources();
  assert.doesNotMatch(model, /showTrades|display\.trades/);
  assert.doesNotMatch(details, /showTrades|display-toggle|result-display-heading|trade-display-icon|trade\.(hide|toggle|hidden)/);
  assert.doesNotMatch(messages, /display\.showTrades|trade\.(hide|toggle|hidden)/);
  assert.doesNotMatch(messages, /results\.(snapshotStale|metricsTitle|additionalMetricsTitle|metricUnavailable)"/);
  assert.doesNotMatch(css, /display-toggle|result-display-heading|result-display-toggles|result-section-heading/);
  assert.doesNotMatch(prototype, /\.aux-chart\b|\.shared-settings svg/);
});


test("removed execution areas have no source, styles, prototype, or completion timers left", () => {
  const removed = /run-controls|run-control-main|run-status-panel|run-status-heading|run-strategy-details|run-strategy-statuses|run-complete-feedback|run-complete-icon|run-reason|progress-copy/;
  for (const source of [css, app, prototype, runActions]) assert.doesNotMatch(source, removed);
  assert.doesNotMatch(css, /\.metric-card|\.metric-grid|\.result-overview-panel|\.preset-catalog/);
  assert.doesNotMatch(app, /completedFeedback|completionFeedbackTimer|setCompletedFeedback/);
});


test("split chart layout leaves no rendering branch, state, styles, or prototype control", () => {
  const charts = chartSources();
  const model = readFileSync(new URL("../src/features/strategies/model.ts", import.meta.url), "utf8");
  for (const source of [charts, model, css, prototype]) {
    assert.doesNotMatch(source, /overlayMode|onOverlayModeChange|chart\.overlay\b|chart-layout-controls|charts-split|data-layout=|chart-aux-panel/);
  }
});

test("removed single-price trade legend has no orphan styles or translations", () => {
  const messages = readTranslationSources();
  assert.doesNotMatch(css, /\.price-marker-legend\b|\n\.trade-marker-(?:buy|sell)\b/);
  assert.doesNotMatch(messages, /"chart\.tradeMarkers"/);
});
