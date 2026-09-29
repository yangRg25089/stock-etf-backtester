import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { RunApiError } = require("../.test-output/api/runs.js");
const { DiagnosticList, StatusView } = require("../.test-output/features/runs/StatusView.js");

const diagnostic = {
  code: "calculation_failed",
  severity: "error",
  messageKey: "diagnostics.calculation_failed",
  fieldPath: "runs.execution",
};

function assertNoInternalDetails(html) {
  assert.doesNotMatch(html, /runs\.execution/);
  assert.doesNotMatch(html, /\{code\}/);
  assert.doesNotMatch(html, /calculation_failed/);
}

test("localized diagnostics hide internal field paths and stable codes", () => {
  const html = renderToStaticMarkup(
    React.createElement(DiagnosticList, { locale: "zh", diagnostics: [diagnostic] }),
  );
  assert.match(html, /计算过程中发生错误。/);
  assertNoInternalDetails(html);
});

test("run API errors show the localized message without an internal error code", () => {
  const error = new RunApiError(
    "calculation_failed",
    "diagnostics.calculation_failed",
    [diagnostic],
    500,
  );
  const html = renderToStaticMarkup(
    React.createElement(StatusView, { locale: "zh", run: null, error }),
  );
  assert.match(html, /计算过程中发生错误。/);
  assertNoInternalDetails(html);
});
