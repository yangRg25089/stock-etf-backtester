import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { LocaleControl } = require("../.test-output/shared/ui/LocaleControl.js");
const { ParameterField } = require("../.test-output/shared/ui/ParameterField.js");

test("locale selector exposes the current language as the selected dropdown option", () => {
  const japanese = renderToStaticMarkup(
    React.createElement(LocaleControl, { locale: "ja", onChange() {} }),
  );
  const chinese = renderToStaticMarkup(
    React.createElement(LocaleControl, { locale: "zh", onChange() {} }),
  );
  assert.match(japanese, /<select class="locale-select" aria-label="表示言語">/);
  assert.match(japanese, /<option value="ja" selected="">日本語<\/option>/);
  assert.match(japanese, /<option value="zh">中文<\/option>/);
  assert.match(japanese, /<option value="en">English<\/option>/);
  assert.match(chinese, /<select class="locale-select" aria-label="显示语言">/);
  assert.match(chinese, /<option value="zh" selected="">中文<\/option>/);
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

const ratioDefinition = {
  key: "exit.vix.ratio1", type: "ratio", default: 0.2, unit: "ratio",
  minimum: 0, maximum: 1, step: 0.01, allowedValues: [],
  applicablePresets: ["vix_dca"], searchable: false, dependencies: [],
  translationKey: "parameters.exit.vix.ratio1", level: "strategy", nullable: false,
};

function numericInput(node) {
  if (!React.isValidElement(node)) return null;
  if (node.type === "input" && node.props.type === "number") return node;
  for (const child of React.Children.toArray(node.props.children)) {
    const input = numericInput(child);
    if (input) return input;
  }
  return null;
}

test("ratio fields show percentages while retaining catalog ratios in edits", () => {
  let changed;
  const element = ParameterField({ definition: ratioDefinition, value: 0.29, locale: "ja", onChange(value) { changed = value; } });
  const input = numericInput(element);
  assert.equal(input.props.value, "29");
  assert.equal(Number(input.props.min), 0);
  assert.equal(Number(input.props.max), 100);
  assert.equal(Number(input.props.step), 1);
  assert.match(renderToStaticMarkup(element), /class="unit-label"[^>]*>%<\/span>/);
  input.props.onChange({ target: { value: "29" } });
  assert.equal(changed, 0.29);
  input.props.onChange({ target: { value: "" } });
  assert.equal(changed, null);
});

test("percentage display preserves precision and scales every bound from metadata", () => {
  let changed;
  const definition = { ...ratioDefinition, minimum: 0.05, maximum: 0.8, step: 0.00001 };
  const element = ParameterField({ definition, value: 1e-7, locale: "zh", onChange(value) { changed = value; } });
  const input = numericInput(element);
  assert.equal(input.props.value, "0.00001");
  assert.equal(Number(input.props.min), 5);
  assert.equal(Number(input.props.max), 80);
  assert.equal(Number(input.props.step), 0.001);
  input.props.onChange({ target: { value: "29.005" } });
  assert.equal(changed, 0.29005);
  for (const [stored, displayed] of [[-0.1, "-10"], [1.01, "101"], [0.29005, "29.005"], [null, ""]]) {
    const field = ParameterField({ definition: ratioDefinition, value: stored, locale: "zh", onChange() {} });
    assert.equal(numericInput(field).props.value, displayed);
  }
});

test("percent point fields keep their existing numeric scale", () => {
  let changed;
  const definition = { ...ratioDefinition, key: "rate.thresholdPct", type: "percent_point", unit: "percent_point", minimum: 0, maximum: 20, step: 0.01 };
  const input = numericInput(ParameterField({ definition, value: 2.5, locale: "zh", onChange(value) { changed = value; } }));
  assert.equal(input.props.value, "2.5");
  assert.equal(input.props.min, 0);
  assert.equal(input.props.max, 20);
  assert.equal(input.props.step, 0.01);
  input.props.onChange({ target: { value: "3.25" } });
  assert.equal(changed, 3.25);
});
