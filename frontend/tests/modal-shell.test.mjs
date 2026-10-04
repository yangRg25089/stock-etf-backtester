import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { ModalShell } = require("../.test-output/shared/ui/ModalShell.js");

test("native shell preserves modal labels and caller-owned content", () => {
  const html = renderToStaticMarkup(React.createElement(ModalShell, {
    dialogRef: React.createRef(), className: "strategy-dialog", id: "editor",
    labelledBy: "title", describedBy: "description", onRequestClose() {},
  }, React.createElement("fieldset", { disabled: true }, "draft")));
  assert.match(html, /<dialog[^>]*class="strategy-dialog"[^>]*id="editor"[^>]*aria-modal="true"[^>]*aria-labelledby="title"[^>]*aria-describedby="description"/);
  assert.match(html, /<fieldset disabled="">draft<\/fieldset>/);
});

test("editable and read-only dialogs reuse the same native boundary", () => {
  for (const path of ["features/config/SharedSettingsDialog.tsx", "features/strategies/StrategyEditorDialog.tsx", "shared/ui/ResultDialog.tsx"]) {
    const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
    assert.match(source, /<ModalShell/);
    assert.doesNotMatch(source, /dialog\.showModal\(\)/);
  }
});

test("strategy navigation delegates menu and card presentation", () => {
  const source = readFileSync(new URL("../src/features/strategies/StrategyWorkspace.tsx", import.meta.url), "utf8");
  assert.match(source, /<StrategyAddMenu/);
  assert.match(source, /<StrategyCard/);
  assert.doesNotMatch(source, /dismissOutside|strategy-card-actions/);
});
