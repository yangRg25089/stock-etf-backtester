import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

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
  while (start !== -1 && !/^\s*\{/.test(css.slice(start + selector.length))) {
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
  const narrow = mediaBlock("@media (max-width: 760px)");
  const tablet = mediaBlock("@media (max-width: 900px)");
  assert.match(blockFor("body"), /min-width:\s*320px/);
  assert.match(blockFor(".main-content"), /width:\s*min\(100% - 48px, 1180px\)/);
  assert.match(narrow, /\.main-content\s*\{[^}]*width:\s*min\(100% - 30px, 1180px\)/s);
  assert.match(phone, /\.main-content\s*\{[^}]*width:\s*min\(100% - 24px, 1180px\)/s);
  assert.match(phone, /\.shared-settings-grid\s*\{[^}]*minmax\(0, 1fr\)/s);
  assert.match(phone, /\.strategy-parameter-grid\s*\{[^}]*minmax\(0, 1fr\)/s);
  assert.match(narrow, /\.shared-settings-grid\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(tablet, /\.shared-settings-grid\s*\{[^}]*repeat\(3, minmax\(0, 1fr\)\)/s);
  assert.match(blockFor(".strategy-card-name"), /overflow-wrap:\s*anywhere/);
  assert.match(blockFor(".strategy-card-summary,\n.strategy-description"), /overflow-wrap:\s*anywhere/);
  assert.match(blockFor(".page-heading > div"), /overflow-wrap:\s*anywhere/);
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
  assert.match(css, /button:focus-visible,[\s\S]*a:focus-visible\s*\{\s*outline:\s*3px solid/);
  assert.match(css, /\.skip-link:focus\s*\{\s*transform:\s*translateY\(0\)/);
  const reducedMotion = mediaBlock("@media (prefers-reduced-motion: reduce)");
  assert.match(reducedMotion, /animation-duration:\s*0\.01ms/);
  assert.match(css, /\.sr-only\s*\{[\s\S]*clip:\s*rect\(0, 0, 0, 0\)/);
});

test("semantic text colors meet WCAG AA contrast against their surfaces", () => {
  const pairs = [
    ["#192321", "#f4f6f5"],
    ["#65736f", "#f4f6f5"],
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
