import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const prototype = readFileSync(new URL("../../docs/design/backtest-ui.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const settingsDialog = readFileSync(new URL("../src/features/config/SharedSettingsDialog.tsx", import.meta.url), "utf8");
const runControls = readFileSync(new URL("../src/features/runs/RunControls.tsx", import.meta.url), "utf8");

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
  assert.match(layout, /grid-template-columns:\s*var\(--workbench-config-width,\s*350px\)\s+12px\s+minmax\(0,\s*1fr\)/);
  assert.match(configuration, /position:\s*relative/);
  assert.match(strategyList, /min-height:\s*0/);
  assert.match(strategyList, /overflow-y:\s*auto/);
  assert.match(results, /min-height:\s*0/);
  assert.match(results, /overflow-y:\s*auto/);
  assert.match(divider, /touch-action:\s*none/);
  const tablet = mediaBlock("@media (min-width: 768px) and (max-width: 1279px)");
  assert.match(tablet, /\.workbench-layout\s*\{[^}]*display:\s*grid/s);
  assert.match(tablet, /\.workbench-config\s*\{[^}]*position:\s*relative/s);
  assert.match(tablet, /\.workbench-results\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(blockFor(".app-topbar"), /position:\s*sticky/);
  assert.match(app, /<header className="app-topbar">[\s\S]*?className="topbar-brand"[\s\S]*?<RunControls/);
  assert.doesNotMatch(app, /className="page-heading"/);
});

test("mobile workbench exposes separate configuration and results views under the fixed topbar", () => {
  const mobile = mediaBlock("@media (max-width: 767px)");
  const phone = mediaBlock("@media (max-width: 420px)");
  assert.match(blockFor(".workbench-mobile-views"), /display:\s*none/);
  assert.match(css, /\.workbench-mobile-views\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /\.workbench-config-toggle\s*\{\s*display:\s*none/s);
  assert.match(css, /\.app-topbar\s*\{[^}]*grid-template-areas:\s*"brand locale" "controls controls"/s);
  assert.match(blockFor(".app-topbar"), /position:\s*sticky/);
  assert.match(prototype, /class="mobile-views"/);
});

test("the design prototype shows the fixed workbench and comparative lines fine", () => {
  assert.match(prototype, /<dialog class="settings-dialog"/);
  assert.match(prototype, /class="shared-settings-summary"/);
  assert.match(prototype, /class="config-fixed"/);
  assert.match(prototype, /class="editor-scroll"/);
  assert.match(prototype, /class="results-pane"/);
  assert.match(prototype, /class="button workbench-toggle"[^>]*aria-expanded="true"/);
  assert.match(prototype, /role="tablist" aria-label="結果詳細"/);
  assert.match(prototype, /\.price-line[^}]*stroke-width:\s*1\.8/);
  assert.match(prototype, /\.asset-line[^}]*stroke-width:\s*1\.8/);
  assert.match(prototype, /#backtest-ui-preview \.divider:focus-visible/);
  assert.match(prototype, /#backtest-ui-preview \.shared-settings-open,[\s\S]*?#backtest-ui-preview \.details-entry \{ min-height: 44px; \}/);
  assert.match(prototype, /#backtest-ui-preview \.strategy-summary[^}]*font-size: 12px/);
  assert.match(prototype, /#backtest-ui-preview \.details-entry[^}]*font-size: 13px/);
  assert.match(prototype, /height:\s*calc\(100dvh - 60px\)/);
  assert.doesNotMatch(prototype, /height:\s*min\(900px,/);
  assert.match(prototype, /grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(prototype, /Ctrl\/Command \+ スクロールでも全図を同期して拡大・縮小/);
  assert.ok(prototype.indexOf('class="run-summary-card"') < prototype.indexOf('aria-labelledby="prototype-kpi-heading"'));
  assert.ok(prototype.indexOf('aria-labelledby="prototype-kpi-heading"') < prototype.indexOf('aria-labelledby="prototype-chart-heading"'));
  assert.match(prototype, /通常のスクロールは結果欄を移動します。拡大鏡ボタン/);
});

test("wide data tables scroll inside their panels instead of widening the page", () => {
  const scrollPanel = blockFor(".comparison-table-scroll,\n.data-table-scroll");
  assert.match(scrollPanel, /max-width:\s*100%/);
  assert.match(scrollPanel, /overflow-x:\s*auto/);
  assert.match(blockFor(".search-table"), /min-width:\s*720px/);
  assert.match(blockFor(".search-table td:last-child"), /white-space:\s*normal/);
});

test("coarse-pointer inputs and buttons have at least 44px targets", () => {
  const touch = mediaBlock("@media (pointer: coarse)");
  assert.match(touch, /button,[\s\S]*\.input,[\s\S]*min-height:\s*44px/);
  assert.match(touch, /\.checkbox-control,[\s\S]*\.latest-toggle,[\s\S]*\.strategy-enabled-control\s*\{\s*min-height:\s*44px/);
  assert.match(touch, /\.input\s*\{\s*font-size:\s*16px/);
  assert.match(touch, /\.icon-button\s*\{\s*min-width:\s*44px/);
  assert.match(touch, /\.strategy-nav-card \.strategy-enabled-control\s*\{\s*min-width:\s*44px/);
  assert.match(touch, /\.strategy-nav-card \.strategy-run-target\s*\{\s*min-width:\s*44px/);
  assert.match(touch, /\.workbench-results \.result-focus-select,[\s\S]*?\.add-strategy-button \{\s*min-height:\s*44px/s);
  assert.match(touch, /\.workbench-results \.legend-toggle,[\s\S]*?\.workbench-results \.chart-range-controls button,[\s\S]*?\.add-strategy-button \{\s*min-height:\s*44px/s);
});

test("catalog fields use aligned bold labels, 40px controls, and in-field units", () => {
  assert.match(blockFor(".field-label"), /font-size:\s*13px/);
  assert.match(blockFor(".field-label"), /font-weight:\s*650/);
  assert.match(blockFor(".input"), /min-height:\s*40px/);
  assert.match(css, /\.checkbox-control \{\s*min-height:\s*40px/);
  assert.match(blockFor(".unit-field.has-unit .input"), /padding-right:\s*54px/);
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
  const pairs = [
    ["#ffffff", "#147d68"],
    ["#192321", "#f4f6f5"],
    ["#5d6a65", "#f4f6f5"],
    ["#147d68", "#ffffff"],
    ["#43524d", "#e9eeeb"],
    ["#125c4e", "#e5f3ef"],
    ["#74460e", "#faedcf"],
    ["#842a2d", "#f6e0e1"],
    ["#825013", "#f7ecd8"],
    ["#3e6258", "#e5f3ef"],
  ];
  for (const [foreground, background] of pairs) {
    assert.ok(contrastRatio(foreground, background) >= 4.5, `${foreground} on ${background} is below 4.5:1`);
  }
  assert.ok(contrastRatio("#148b75", "#f4f6f5") >= 3, "focus outline should remain visible as a UI indicator");
});

test("coarse-pointer workbench divider keeps a 44px hit area", () => {
  const touch = mediaBlock("@media (pointer: coarse)");
  assert.match(touch, /\.workbench-layout\s*\{\s*grid-template-columns:\s*var\(--workbench-config-width,\s*350px\)\s+44px\s+minmax\(0,\s*1fr\)/);
  assert.match(touch, /\.workbench-divider\s*\{\s*min-width:\s*44px/);
  const tabletTouch = mediaBlock("@media (pointer: coarse) and (min-width: 768px) and (max-width: 1279px)");
  assert.match(tabletTouch, /grid-template-columns:\s*minmax\(265px, var\(--workbench-config-width, 350px\)\) minmax\(0, 1fr\)/);
  assert.match(tabletTouch, /\.workbench-divider\s*\{\s*display:\s*none/);
});

test("workbench explanatory text meets the readable type scale", () => {
  assert.match(blockFor(".shared-settings-summary-text"), /font-size:\s*12px/);
  assert.match(blockFor(".strategy-nav-card .strategy-card-summary"), /font-size:\s*12px/);
  assert.match(blockFor(".strategy-nav-card .strategy-card-summary"), /-webkit-line-clamp:\s*2/);
  assert.match(blockFor(".result-saved-range"), /font-size:\s*13px/);
  assert.match(blockFor(".result-focus-select"), /min-height:\s*36px/);
});

test("the fixed strategy navigator does not stretch cards to fill unused height", () => {
  const navigator = blockFor(".strategy-navigator");
  const cards = blockFor(".strategy-navigator .strategy-card-list");
  assert.match(navigator, /grid-template-rows:\s*auto auto minmax\(0, 1fr\)/);
  assert.match(navigator, /overflow:\s*hidden/);
  assert.match(cards, /align-content:\s*start/);
  assert.match(cards, /min-height:\s*0/);
  assert.match(cards, /overflow-y:\s*auto/);
});

test("shared settings use a modal and the sidebar toggle has one fixed location", () => {
  assert.match(app, /className="button shared-settings-summary shared-settings-open-button"[\s\S]*aria-haspopup="dialog"[\s\S]*aria-describedby="shared-settings-summary-detail"/);
  assert.match(app, /className="shared-settings-summary-text"\s+id="shared-settings-summary-detail"/);
  assert.doesNotMatch(app, /className="button icon-only-button shared-settings-open-button"/);
  assert.match(app, /<SharedSettingsDialog/);
  assert.match(settingsDialog, /aria-modal="true"/);
  assert.match(settingsDialog, /dialog\.showModal\(\)/);
  assert.match(settingsDialog, /onCancel=\{/);
  assert.match(app, /className="topbar-brand"[\s\S]*?className="button workbench-config-toggle icon-only-button"/);
  assert.doesNotMatch(app, /className="workbench-config-header"[\s\S]*?workbench-config-toggle/);
  assert.match(app, /aria-expanded=\{catalog && workspace \? !configCollapsed : undefined\}[\s\S]*disabled=\{!catalog \|\| !workspace\}[\s\S]*setConfigCollapsed\(\(current\) => !current\)/);
  assert.doesNotMatch(app, /<details className="shared-settings-disclosure"/);
  const tablet = mediaBlock("@media (min-width: 768px) and (max-width: 1279px)");
  assert.match(tablet, /--app-topbar-height:\s*105px/);
  assert.match(tablet, /\.main-content\.workbench-main\s*\{[^}]*height:\s*calc\(100dvh - var\(--app-topbar-height\)\)/s);
  assert.match(tablet, /\.workbench-layout\s*\{[^}]*min-height:\s*0/s);
});

test("space-saving workbench controls retain an accessible text name", () => {
  assert.match(app, /className="button workbench-config-toggle icon-only-button"[^>]*aria-label=\{translate\(locale, configCollapsed \? "workbench\.showConfig" : "workbench\.hideConfig"\)\}/);
  assert.match(app, /configCollapsed \? "›" : "‹"/);
  assert.match(app, /aria-label=\{translate\(locale, configCollapsed \? "workbench\.showConfig" : "workbench\.hideConfig"\)\}/);
  assert.match(runControls, /aria-label=\{translate\(locale, busy \? "run\.submitting" : completedFeedback \? "run\.complete" : "run\.submit"\)\}/);
  assert.match(runControls, /className="run-play-icon"/);
  assert.match(runControls, /className="run-scope-select"/);
  assert.doesNotMatch(runControls, /translate\(locale, "run\.submit"\)<\/button>/);
  assert.match(css, /\.display-toggle\s*\{[^}]*width:\s*44px/s);
  assert.match(css, /\.display-toggle svg\s*\{[^}]*stroke:\s*currentColor/s);
});

test("primary workbench actions use the accent fill and selected chart modes are easy to spot", () => {
  assert.match(blockFor(".workbench-config-toggle"), /background:\s*var\(--app-accent\)/);
  assert.match(blockFor(".add-strategy-button"), /background:\s*var\(--app-accent-soft\)/);
  assert.match(blockFor(".chart-layout-controls button\[aria-pressed=\"true\"\]"), /background:\s*var\(--app-accent\)/);
});

test("base button styles precede and preserve emphasized action colors", () => {
  const buttonRule = css.indexOf("\n.button {");
  for (const selector of [".workbench-config-toggle", ".shared-settings-open-button", ".add-strategy-button", ".button-primary"]) {
    assert.ok(css.indexOf(`\n${selector} {`) > buttonRule, `${selector} follows base button styles`);
  }
  assert.match(blockFor(".button-primary"), /background:\s*var\(--app-accent\)/);
  assert.match(blockFor(".workbench-config-toggle"), /background:\s*var\(--app-accent\)/);
  assert.match(blockFor(".add-strategy-button"), /background:\s*var\(--app-accent-soft\)/);
  assert.match(blockFor(".shared-settings-summary-icon"), /background:\s*var\(--app-accent-soft\)/);
});

test("wheel zoom mode and primary run icon have clear visual affordances", () => {
  assert.match(runControls, /className="run-play-icon"/);
  assert.match(css, /\.button-primary\s*\{[^}]*background:\s*var\(--app-accent\)/);
  assert.match(css, /\.run-submit-button\s*\{[^}]*width:\s*44px/s);
  assert.match(css, /\.chart-wheel-zoom-toggle\[aria-pressed="true"\]/);
  assert.match(css, /\.shared-settings-dialog/);
});
