import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const prototype = readFileSync(new URL("../../docs/design/backtest-ui.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

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
  const tablet = mediaBlock("@media (max-width: 900px)");
  assert.match(blockFor("body"), /min-width:\s*320px/);
  assert.match(blockFor(".main-content"), /width:\s*min\(100% - 48px, 1180px\)/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*?\.main-content\s*\{[^}]*width:\s*min\(100% - 30px, 1180px\)/s);
  assert.match(phone, /\.main-content\s*\{[^}]*width:\s*min\(100% - 24px, 1180px\)/s);
  assert.match(phone, /\.strategy-parameter-grid\s*\{[^}]*minmax\(0, 1fr\)/s);
  assert.match(blockFor(".shared-settings-grid"), /grid-template-columns:\s*minmax\(0, 1\.35fr\) minmax\(0, 1fr\)/);
  assert.match(blockFor(".shared-settings-fields-range"), /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(tablet, /\.shared-settings-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(css, /\.shared-settings-fields-range\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(blockFor(".shared-settings-fields-funding"), /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(phone, /\.shared-settings-fields-range\s*\{[^}]*minmax\(0, 1fr\)/s);
  assert.match(phone, /\.shared-settings-fields-funding\s*\{[^}]*minmax\(0, 1fr\)/s);
  assert.match(blockFor(".shared-settings-group"), /min-width:\s*0/);
  assert.match(blockFor(".strategy-card-name"), /overflow-wrap:\s*anywhere/);
  assert.match(blockFor(".strategy-card-summary,\n.strategy-description"), /overflow-wrap:\s*anywhere/);
  assert.match(blockFor(".page-heading > div"), /overflow-wrap:\s*anywhere/);
});

test("desktop workbench keeps top and selectors fixed with independent editor and results scrolling", () => {
  const main = blockFor(".main-content.workbench-main");
  const layout = blockFor(".workbench-layout");
  const configuration = blockFor(".workbench-config-fixed");
  const editor = blockFor(".workbench-editor-scroll,\n.workbench-results");
  const results = blockFor(".workbench-results");
  const divider = blockFor(".workbench-divider");
  assert.match(main, /width:\s*calc\(100% - 32px\)/);
  assert.match(main, /max-width:\s*1920px/);
  assert.match(layout, /grid-template-columns:\s*var\(--workbench-config-width,\s*350px\)\s+12px\s+minmax\(0,\s*1fr\)/);
  assert.match(configuration, /position:\s*relative/);
  assert.match(editor, /min-height:\s*0/);
  assert.match(editor, /overflow-y:\s*auto/);
  assert.match(results, /min-height:\s*0/);
  assert.match(results, /overflow-y:\s*auto/);
  assert.match(divider, /touch-action:\s*none/);
  const tablet = mediaBlock("@media (min-width: 768px) and (max-width: 1279px)");
  assert.match(tablet, /\.workbench-layout\s*\{[^}]*display:\s*grid/s);
  assert.match(tablet, /\.workbench-config\s*\{[^}]*position:\s*relative/s);
  assert.match(tablet, /\.workbench-results\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(blockFor(".workbench-context"), /position:\s*sticky/);
});

test("mobile workbench exposes separate configuration and results views under the fixed context", () => {
  const mobile = mediaBlock("@media (max-width: 767px)");
  const phone = mediaBlock("@media (max-width: 420px)");
  assert.match(blockFor(".workbench-mobile-views"), /display:\s*none/);
  assert.match(css, /\.workbench-mobile-views\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /\.workbench-config-toggle\s*\{\s*display:\s*none/s);
  assert.match(mobile, /\.workbench-context\s*\{[^}]*top:\s*60px/s);
  assert.match(phone, /\.workbench-context\s*\{\s*top:\s*104px/s);
  assert.match(prototype, /class="mobile-views"/);
});

test("the design prototype shows the fixed workbench and comparative lines fine", () => {
  assert.match(prototype, /<details class="shared-settings">/);
  assert.match(prototype, /class="config-fixed"/);
  assert.match(prototype, /class="editor-scroll"/);
  assert.match(prototype, /class="results-pane"/);
  assert.match(prototype, /role="tablist" aria-label="結果詳細"/);
  assert.match(prototype, /\.price-line[^}]*stroke-width:\s*1\.8/);
  assert.match(prototype, /\.asset-line[^}]*stroke-width:\s*1\.8/);
  assert.match(prototype, /#backtest-ui-preview \.divider:focus-visible/);
  assert.match(prototype, /#backtest-ui-preview \.shared-settings summary,[\s\S]*?#backtest-ui-preview \.details-entry \{ min-height: 44px; \}/);
  assert.match(prototype, /#backtest-ui-preview \.strategy-summary[^}]*font-size: 12px/);
  assert.match(prototype, /#backtest-ui-preview \.details-entry[^}]*font-size: 13px/);
  assert.match(prototype, /height:\s*calc\(100dvh - 60px\)/);
  assert.doesNotMatch(prototype, /height:\s*min\(900px,/);
  assert.match(prototype, /grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(prototype, /通常のスクロールは結果欄を移動し、Ctrl\/Command \+ スクロール/);
  assert.ok(prototype.indexOf('aria-labelledby="prototype-kpi-heading"') < prototype.indexOf('class="run-summary-card"'));
  assert.ok(prototype.indexOf('class="run-summary-card"') < prototype.indexOf('aria-labelledby="prototype-chart-heading"'));
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
  assert.match(touch, /\.shared-settings-disclosure > summary,[\s\S]*?\.workbench-results \.result-details-entry,[\s\S]*?\.workbench-results \.run-strategy-details > summary,[\s\S]*?\.add-strategy-button \{\s*min-height:\s*44px/s);
  assert.match(touch, /\.workbench-results \.legend-toggle,[\s\S]*?\.workbench-results \.chart-range-controls button,[\s\S]*?\.add-strategy-button \{\s*min-height:\s*44px/s);
  assert.match(touch, /\.workbench-results \.result-details-entry,[\s\S]*?\.workbench-results \.run-strategy-details > summary,[\s\S]*?\.add-strategy-button \{\s*min-height:\s*44px/s);
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
  assert.match(blockFor(".shared-settings-disclosure-summary"), /font-size:\s*12px/);
  assert.match(blockFor(".strategy-nav-card .strategy-card-summary"), /font-size:\s*12px/);
  assert.match(blockFor(".strategy-nav-card .strategy-card-summary"), /-webkit-line-clamp:\s*2/);
  assert.match(blockFor(".result-details-entry"), /font-size:\s*13px/);
});

test("the fixed strategy navigator does not stretch cards to fill unused height", () => {
  assert.match(blockFor(".strategy-navigator .strategy-card-list"), /align-content:\s*start/);
  assert.match(blockFor(".strategy-navigator .strategy-card-list"), /min-height:\s*56px/);
  assert.match(blockFor(".strategy-navigator"), /overflow-y:\s*auto/);
});

test("expanded shared settings stay in the left pane flow with a nearby collapse control", () => {
  assert.doesNotMatch(blockFor(".shared-settings-disclosure[open]"), /position:\s*absolute/);
  assert.match(css, /\.workbench-config-header,[\s\S]*?display:\s*flex/);
  assert.match(app, /className="workbench-config-header"[\s\S]*?className="button workbench-config-toggle"/);
  assert.match(app, /className="workbench-heading-actions"[\s\S]*?className="button workbench-config-toggle icon-only-button"/);
  assert.match(app, /aria-label=\{translate\(locale, "workbench\.showConfig"\)\}[\s\S]*aria-expanded="false"[\s\S]*setConfigCollapsed\(false\)/);
  assert.doesNotMatch(app, /className="results-heading-title"[\s\S]*?workbench-config-toggle/);
  const tablet = mediaBlock("@media (min-width: 768px) and (max-width: 1279px)");
  assert.match(tablet, /\.main-content\.workbench-main\s*\{[^}]*height:\s*calc\(100dvh - 60px\)/s);
  assert.match(tablet, /\.workbench-layout\s*\{[^}]*min-height:\s*0/s);
});

test("space-saving workbench controls retain an accessible text name", () => {
  assert.match(app, /className="button workbench-config-toggle icon-only-button"[^>]*aria-label=\{translate\(locale, "workbench\.showConfig"\)\}/);
  assert.match(app, /<span aria-hidden="true">›<\/span>/);
  assert.match(app, /<span aria-hidden="true">‹<\/span>/);
  assert.match(css, /\.display-toggle\s*\{[^}]*width:\s*38px/s);
  assert.match(css, /\.display-toggle svg\s*\{[^}]*stroke:\s*currentColor/s);
});

test("primary workbench actions use the accent fill and selected chart modes are easy to spot", () => {
  assert.match(blockFor(".workbench-config-toggle"), /background:\s*var\(--app-accent\)/);
  assert.match(blockFor(".add-strategy-button"), /background:\s*var\(--app-accent-soft\)/);
  assert.match(blockFor(".chart-layout-controls button\[aria-pressed=\"true\"\]"), /background:\s*var\(--app-accent\)/);
});
