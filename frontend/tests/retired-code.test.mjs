import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { readStyles } from "./helpers/readSources.mjs";
const require = createRequire(import.meta.url);
const { translate } = require("../.test-output/i18n/messages.js");
const retired = ["app.localOnly", "page.subtitle", "workbench.resizeConfig", "section.sharedSettingsHelp",
  "strategy.setRunTarget", "strategy.currentRunTarget", "strategy.parameterGroupNavigation", "results.role.strategy", "results.role.benchmark",
  "results.compareToggle", "export.csv"];

test("retired control text and orphan style selectors are completely absent", () => {
  for (const locale of ["ja", "zh"]) {
    for (const key of retired) assert.equal(translate(locale, key), key);
    assert.notEqual(translate(locale, "export.csvLabel"), "export.csvLabel");
    assert.notEqual(translate(locale, "market.latest_quote_delayed"), "market.latest_quote_delayed");
  }
  const css = readStyles();
  assert.doesNotMatch(css, /--workbench-config-width|\.section-subhead|\.shared-settings-heading/);
  assert.equal((css.match(/\n\.strategy-card-actions \{/g) ?? []).length, 1);
});
