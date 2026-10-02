import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { RunApiError } = require("../.test-output/api/runs.js");
const { DiagnosticList } = require("../.test-output/features/runs/DiagnosticList.js");
const { ResultDetails } = require("../.test-output/features/results/ResultDetails.js");

const diagnostic = {
  code: "calculation_failed",
  severity: "error",
  messageKey: "diagnostics.calculation_failed",
  details: { stage: "strategy", strategyId: "strategy-vix-1", runId: "run-safe-1" },
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
  assert.match(html, /用户策略/);
  assert.match(html, /策略 ID：strategy-vix-1/);
  assert.match(html, /运行 ID：run-safe-1/);
  assertNoInternalDetails(html);
});

test("collapsed field errors can show the readable field label without exposing paths", () => {
  const html = renderToStaticMarkup(React.createElement(DiagnosticList, {
    locale: "zh",
    diagnostics: [{ code: "invalid_parameter", severity: "error", messageKey: "diagnostics.configuration.out_of_range", fieldPath: "strategies[0].rules.buy.params.rsi.period" }],
    fieldLabel() { return "RSI期间"; },
  }));
  assert.match(html, /<strong class="diagnostic-field-name">RSI期间<\/strong>/);
  assert.doesNotMatch(html, /strategies\[0\]|rules\.buy|rsi\.period/);
});

test("backend diagnostic messages have readable Japanese and Chinese text", () => {
  function diagnosticKeys(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return diagnosticKeys(path);
      if (!entry.name.endsWith(".py")) return [];
      const source = readFileSync(path, "utf8");
      return [...source.matchAll(/messageKey=["']([^"']+)["']/g), ...source.matchAll(/["'](api\.errors\.[^"']+)["']/g)].map(match => match[1]);
    });
  }
  const keys = [...new Set(diagnosticKeys(new URL("../../backend/app", import.meta.url).pathname))];
  assert.ok(keys.length > 30);
  for (const locale of ["ja", "zh"]) {
    for (const messageKey of keys) {
      const html = renderToStaticMarkup(React.createElement(DiagnosticList, { locale, diagnostics: [{ code: "stale_data", severity: "warning", messageKey }] }));
      assert.ok(!html.includes(messageKey), `${locale}: missing diagnostic translation ${messageKey}`);
    }
  }
});

test("run API errors show the localized message without an internal error code", () => {
  const error = new RunApiError(
    "calculation_failed",
    "diagnostics.calculation_failed",
    [diagnostic],
    500,
  );
  const html = renderToStaticMarkup(
    React.createElement(ResultDetails, { locale: "zh", run: null, error, focusedResult: null, state: { focusedResultId: null }, dispatch() {} }),
  );
  assert.match(html, /计算过程中发生错误。/);
  assert.match(html, /用户策略/);
  assert.match(html, /策略 ID：strategy-vix-1/);
  assert.match(html, /运行 ID：run-safe-1/);
  assertNoInternalDetails(html);
});

test("field diagnostics expose a localized action only when navigation is available", () => {
  const actionable = renderToStaticMarkup(
    React.createElement(DiagnosticList, {
      locale: "zh",
      diagnostics: [{ ...diagnostic, fieldPath: "strategies[0].params.vix.buyThreshold" }],
      fieldAction() {
        return {
          label: "VIX 买入阈值",
          activate() {},
        };
      },
    }),
  );
  assert.match(actionable, /aria-label="打开「VIX 买入阈值」设置"/);
  assert.match(actionable, /title="打开「VIX 买入阈值」设置"/);
  assert.match(actionable, /class="diagnostic-field-link"/);

  const passive = renderToStaticMarkup(
    React.createElement(DiagnosticList, {
      locale: "zh",
      diagnostics: [{ ...diagnostic, fieldPath: "metrics.xirr" }],
    }),
  );
  assert.doesNotMatch(passive, /diagnostic-field-link/);
});
