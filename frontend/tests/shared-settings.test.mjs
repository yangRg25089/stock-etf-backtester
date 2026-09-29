import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { SharedSettingsForm } = require("../.test-output/features/config/SharedSettingsForm.js");
const { createDefaultSharedDraft } = require("../.test-output/features/config/defaults.js");
const { ParameterField } = require("../.test-output/shared/ui/ParameterField.js");

function parameter(key, type, defaultValue, extra = {}) {
  return {
    key,
    type,
    default: defaultValue,
    unit: null,
    minimum: null,
    maximum: null,
    step: null,
    allowedValues: [],
    applicablePresets: ["vix_dca"],
    searchable: false,
    dependencies: [],
    translationKey: `parameters.${key}`,
    level: "shared",
    nullable: false,
    ...extra,
  };
}

const fields = [
  parameter("run.symbol", "symbol", "QQQ", { unit: "symbol" }),
  parameter("run.startDate", "date", "2020-01-01", { unit: "date" }),
  parameter("run.endDate", "date", null, { unit: "date", nullable: true }),
  parameter("run.endMode", "enum", "latest", { allowedValues: ["fixed", "latest"] }),
  parameter("contribution.amount", "decimal", "100", {
    unit: "currency",
    minimum: "0",
    step: "0.01",
  }),
  parameter("contribution.day", "integer", 1, {
    unit: "day_of_month",
    minimum: "1",
    maximum: "31",
    step: "1",
  }),
];

const catalog = {
  version: "catalog-test",
  parameters: fields,
  presets: [],
};

test("shared settings render catalog defaults once and lock a resolved latest date", () => {
  const html = renderToStaticMarkup(
    React.createElement(SharedSettingsForm, {
      catalog,
      value: createDefaultSharedDraft(catalog),
      locale: "ja",
      onChange() {},
      resolvedLatestEndDate: "2024-06-28",
    }),
  );

  assert.equal((html.match(/id="field-run-symbol"/g) ?? []).length, 1);
  const resolvedInput = html.match(/<input[^>]*id="field-run-endDate"[^>]*>/)?.[0] ?? "";
  assert.match(resolvedInput, /type="date"/);
  assert.match(resolvedInput, /value="2024-06-28"/);
  assert.match(resolvedInput, /disabled/);
  assert.match(html, /この実行で確定した終了日：2024-06-28/);
  assert.match(html, /id="field-contribution-amount"[^>]*min="0"[^>]*step="0.01"/);
  assert.match(html, /id="field-contribution-day"[^>]*min="1"[^>]*max="31"/);
  assert.equal((html.match(/for="field-run-endDate"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /代码|日付|銘柄の通貨|标的报价币种/);
  assert.match(html, /金額は銘柄の取引通貨/);
  assert.match(html, /aria-describedby="field-contribution-day-unit"/);
  assert.match(html, /<span class="unit-label" id="field-contribution-day-unit">日<\/span>/);
});

test("latest mode with no run snapshot does not invent a date", () => {
  const html = renderToStaticMarkup(
    React.createElement(SharedSettingsForm, {
      catalog,
      value: createDefaultSharedDraft(catalog),
      locale: "zh",
      onChange() {},
    }),
  );
  assert.match(html, /结束日期将在运行时解析为最近完整行情日/);
  const unresolvedInput = html.match(/<input[^>]*id="field-run-endDate"[^>]*>/)?.[0] ?? "";
  assert.match(unresolvedInput, /value=""/);
  assert.match(unresolvedInput, /disabled/);
  assert.doesNotMatch(html, /value="2026-/);
});

test("parameter fields use catalog units, bounds, dependency state, and diagnostics", () => {
  const definition = parameter("vix.buyThreshold", "decimal", "25", {
    unit: "index_point",
    minimum: "0",
    maximum: "100",
    step: "0.1",
    dependencies: ["vix.buyEnabled"],
    translationKey: "parameters.vix.buyThreshold",
    level: "strategy",
  });
  const html = renderToStaticMarkup(
    React.createElement(ParameterField, {
      definition,
      value: "25",
      locale: "ja",
      onChange() {},
      dependencyValues: { "vix.buyEnabled": true },
      errors: [
        {
          code: "invalid_parameter",
          severity: "error",
          messageKey: "diagnostics.configuration.out_of_range",
          fieldPath: "strategies[0].params.vix.buyThreshold",
        },
      ],
    }),
  );

  assert.match(html, /買付しきい値/);
  assert.match(html, /min="0"/);
  assert.match(html, /max="100"/);
  assert.match(html, /step="0.1"/);
  assert.match(html, /ポイント/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /値が許容範囲外です。/);

  const disabledHtml = renderToStaticMarkup(
    React.createElement(ParameterField, {
      definition,
      value: "25",
      locale: "ja",
      onChange() {},
      dependencyValues: { "vix.buyEnabled": false },
    }),
  );
  assert.match(disabledHtml, /disabled/);
  assert.match(disabledHtml, /必要な値を設定すると編集できます/);
});
