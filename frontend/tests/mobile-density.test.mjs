import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readStyles } from "./helpers/readSources.mjs";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { TradeTable } = require("../.test-output/features/results/TradeTable.js");
const { TopbarMenu } = require("../.test-output/shared/ui/TopbarMenu.js");

test("functional disclosure has a localized name, stable controls relation and an available busy trigger", () => {
  for (const locale of ["ja", "zh", "en"]) {
    const html = renderToStaticMarkup(React.createElement(TopbarMenu, { locale, busy: true }, React.createElement("button", null, "Action")));
    assert.match(html, /class="topbar-menu-toggle"[^>]*aria-label="[^"]+"[^>]*aria-expanded="false"/);
    assert.doesNotMatch(html, /aria-label="app\.|disabled/);
    const controls = html.match(/aria-controls="([^"]+)"/)[1];
    assert.ok(html.includes(`id="${controls}" class="topbar-functions"`));
    assert.match(html, /topbar-menu-activity/);
  }
});

test("phone navigation groups existing controls inside one disclosure", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /<TopbarMenu[\s\S]*?<RunActions[\s\S]*?<PackageControls[\s\S]*?<ThemeControl[\s\S]*?<LocaleControl[\s\S]*?<\/TopbarMenu>/);
});

test("trade title and expand button share the same controls row in all languages", () => {
  for (const locale of ["ja", "zh", "en"]) {
    const html = renderToStaticMarkup(React.createElement(TradeTable, { locale, status: "completed", trades: [] }));
    assert.match(html, /class="table-height-controls"><h4 class="table-height-controls-title">[^<]+<\/h4><button/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /disabled=""/);
    const unavailable = renderToStaticMarkup(React.createElement(TradeTable, { locale, status: "unavailable", trades: [] }));
    assert.match(unavailable, /<h4/);
    assert.match(unavailable, /role="status"/);
  }
});

test("phone strategy lists use a bounded content height and release boundary scrolling", () => {
  const css = readStyles();
  assert.match(css, /\.workbench-config\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*0/s);
  assert.match(css, /\.strategy-navigator \.strategy-card-list\s*\{[^}]*max-height:\s*min\(55dvh, 440px\);[^}]*overscroll-behavior:\s*auto/s);
});
