import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { catalog } from "./helpers/contracts.mjs";
const require = createRequire(import.meta.url);
const React = require("react");
const { ParameterField } = require("../.test-output/shared/ui/ParameterField.js");
const { ToggleSwitch } = require("../.test-output/shared/ui/ToggleSwitch.js");

test("parameter and condition toggles share one accessible switch primitive", () => {
  const source = readFileSync(new URL("../src/shared/ui/ParameterField.tsx", import.meta.url), "utf8");
  assert.match(source, /<ToggleSwitch\b/);
  assert.doesNotMatch(source, /className="switch-track"/);
});

test("parameter switches preserve field metadata, strict boolean values and callbacks", () => {
  const definition = catalog.parameters.find(item => item.type === "boolean");
  for (const value of [true, false, undefined, "true"]) {
    let next;
    const field = ParameterField({ definition, value, locale: "en", appearance: "switch",
      id: "toggle-fixture", disabled: true, helperText: "Help", respectDependencies: false,
      errors: [{ fieldPath: definition.key, code: "invalid_parameter", messageKey: "diagnostics.configuration.invalid_request" }],
      onChange: changed => { next = changed; } });
    const control = field.props.children[1];
    const button = typeof control.type === "function" ? control.type(control.props) : control;
    assert.equal(button.props.role, "switch");
    assert.equal(button.props.id, "toggle-fixture");
    assert.equal(button.props["data-parameter-key"], definition.key);
    assert.equal(button.props["aria-checked"], value === true);
    assert.equal(button.props["aria-invalid"], true);
    assert.equal(button.props["aria-describedby"], "toggle-fixture-hint toggle-fixture-error");
    assert.equal(button.props.disabled, true);
    assert.equal(button.props.className, "parameter-switch");
    assert.ok(React.Children.toArray(button.props.children).some(child => child.props.className === "switch-state"));
    button.props.onClick();
    assert.equal(next, value !== true);
  }
});

test("condition switches keep their compact class and label", () => {
  let next;
  const button = ToggleSwitch({ label: "Enable condition", checked: true, onChange: value => { next = value; } });
  assert.equal(button.props.className, "parameter-switch condition-enable-switch");
  assert.equal(button.props["aria-label"], "Enable condition");
  button.props.onClick();
  assert.equal(next, false);
});
