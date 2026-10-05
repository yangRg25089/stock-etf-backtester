import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { catalog } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { ParameterField } = require("../.test-output/shared/ui/ParameterField.js");
const definition = catalog.parameters.find(row => row.type === "number_list");

function controls(node, tag) {
  if (!React.isValidElement(node)) return [];
  if (typeof node.type === "function") return controls(node.type(node.props), tag);
  return [...(node.type === tag ? [node] : []), ...React.Children.toArray(node.props.children).flatMap(child => controls(child, tag))];
}

test("number-list callbacks retain blank entries, numeric values, item identities and inherited descriptions", () => {
  let changed;
  const value = ["", 25];
  const field = ParameterField({ definition, value, locale: "zh", id: "list-fixture", helperText: "list explanation",
    respectDependencies: false, onChange(next) { changed = next; } });
  const inputs = controls(field, "input");
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs.map(input => input.props.id), ["list-fixture-0", "list-fixture-1"]);
  assert.deepEqual(inputs.map(input => input.props.value), ["", "25"]);
  for (const input of inputs) {
    assert.equal(input.props.required, definition.nullable !== true);
    assert.equal(input.props.min, definition.minimum ?? undefined);
    assert.equal(input.props.max, definition.maximum ?? undefined);
    assert.equal(input.props.step, definition.step ?? undefined);
    assert.ok(input.props["aria-describedby"].includes("list-fixture-hint"));
  }
  inputs[0].props.onChange({ target: { value: "12.5" } });
  assert.deepEqual(changed, [12.5, 25]);
  inputs[1].props.onChange({ target: { value: "" } });
  assert.deepEqual(changed, ["", ""]);
  const buttons = controls(field, "button");
  buttons[0].props.onClick();
  assert.deepEqual(changed, [25]);
  buttons.at(-1).props.onClick();
  assert.deepEqual(changed, ["", 25, ""]);
  assert.deepEqual(value, ["", 25]);
  assert.match(renderToStaticMarkup(field), /for="list-fixture-0"/);
});

test("number-list minimum-item, disabled and nullable semantics remain separate from scalar inputs", () => {
  const field = ParameterField({ definition: { ...definition, nullable: true }, value: [null], locale: "ja", disabled: true,
    respectDependencies: false, onChange() {} });
  const input = controls(field, "input")[0];
  assert.equal(input.props.value, "");
  assert.equal(input.props.required, false);
  assert.equal(input.props.disabled, true);
  for (const button of controls(field, "button")) assert.equal(button.props.disabled, true);
  const one = ParameterField({ definition, value: [1], locale: "ja", respectDependencies: false, onChange() {} });
  assert.equal(controls(one, "button")[0].props.disabled, true);
  assert.equal(controls(one, "button").at(-1).props.disabled, false);
});
