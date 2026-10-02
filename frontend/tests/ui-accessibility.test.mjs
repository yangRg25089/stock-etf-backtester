import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { LocaleControl } = require("../.test-output/shared/ui/LocaleControl.js");
const { ParameterField } = require("../.test-output/shared/ui/ParameterField.js");

test("locale selector exposes the current language as a pressed state", () => {
  const japanese = renderToStaticMarkup(
    React.createElement(LocaleControl, { locale: "ja", onChange() {} }),
  );
  const chinese = renderToStaticMarkup(
    React.createElement(LocaleControl, { locale: "zh", onChange() {} }),
  );
  assert.match(japanese, /role="group" aria-label="表示言語"/);
  assert.match(japanese, /日本語<\/button>/);
  assert.match(japanese, /aria-pressed="true">日本語/);
  assert.match(chinese, /aria-pressed="true">中文/);
});

test("boolean parameters keep the catalog label attached to the checkbox", () => {
  const html = renderToStaticMarkup(
    React.createElement(ParameterField, {
      definition: {
        key: "vix.buyEnabled",
        type: "boolean",
        default: true,
        unit: null,
        minimum: null,
        maximum: null,
        step: null,
        allowedValues: [],
        applicablePresets: ["vix_dca"],
        searchable: false,
        dependencies: [],
        translationKey: "parameters.vix.buyEnabled",
        level: "strategy",
        nullable: false,
      },
      value: true,
      locale: "ja",
      onChange() {},
    }),
  );
  assert.match(html, /<label class="field-label" for="field-vix-buyEnabled">/);
  assert.match(html, /<div class="checkbox-control">/);
  assert.match(html, /type="checkbox" checked/);
  assert.match(html, /指数買付シグナル/);
  assert.match(html, /有効/);
});
