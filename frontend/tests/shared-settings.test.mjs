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

test("numeric edits submit numbers while dates and symbols retain text and empty fields retain null", () => {
  for (const [key, raw, expected] of [
    ["contribution.day", "15", 15],
    ["contribution.amount", "123.45", 123.45],
    ["run.startDate", "2024-02-01", "2024-02-01"],
    ["run.symbol", "SPY", "SPY"],
    ["contribution.amount", "", null],
  ]) {
    const values = [];
    const element = ParameterField({
      definition: fields.find(field => field.key === key),
      value: null,
      locale: "ja",
      onChange(value) { values.push(value); },
    });
    const input = element.props.children[1].props.children[0];
    input.props.onChange({ target: { value: raw } });
    assert.deepEqual(values, [expected]);
  }
});

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
  assert.equal((html.match(/<fieldset class="shared-settings-group/g) ?? []).length, 3);
  assert.match(html, /<legend>対象<\/legend>/);
  assert.match(html, /<legend>期間<\/legend>/);
  assert.match(html, /<legend>入金計画<\/legend>/);
  const assetGroup = html.match(/<fieldset class="shared-settings-group shared-settings-asset-group">([\s\S]*?)<\/fieldset>/)?.[1] ?? "";
  const rangeGroup = html.match(/<fieldset class="shared-settings-group shared-settings-range-group">([\s\S]*?)<\/fieldset>/)?.[1] ?? "";
  const fundingGroup = html.match(/<fieldset class="shared-settings-group shared-settings-funding-group">([\s\S]*?)<\/fieldset>/)?.[1] ?? "";
  assert.match(assetGroup, /field-run-symbol/);
  assert.doesNotMatch(assetGroup, /field-run-startDate|field-run-endDate/);
  assert.match(rangeGroup, /field-run-startDate[\s\S]*field-run-endDate/);
  assert.match(fundingGroup, /field-contribution-amount[\s\S]*field-contribution-day/);
  const resolvedInput = html.match(/<input[^>]*id="field-run-endDate"[^>]*>/)?.[0] ?? "";
  assert.match(resolvedInput, /type="date"/);
  assert.match(resolvedInput, /value="2024-06-28"/);
  assert.match(resolvedInput, /disabled/);
  assert.match(html, /前回の終了日：2024-06-28/);
  assert.match(html, /id="field-contribution-amount"[^>]*min="0"[^>]*step="0.01"/);
  assert.match(html, /id="field-contribution-day"[^>]*min="1"[^>]*max="31"/);
  assert.equal((html.match(/for="field-run-endDate"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /代码|日付|銘柄の通貨|标的报价币种/);
  assert.match(html, /銘柄と同じ通貨/);
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
  assert.match(html, /运行至最近完整行情日/);
  assert.match(html, /<legend>标的<\/legend>/);
  assert.match(html, /<legend>区间<\/legend>/);
  assert.match(html, /<legend>投入计划<\/legend>/);
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

 test("money inputs display confirmed currency or an explicit unresolved trading-currency unit", () => {
  for (const [currency, expected] of [["USD", "USD"], ["JPY", "JPY"], [undefined, "交易货币"]]) {
    const html = renderToStaticMarkup(React.createElement(SharedSettingsForm, {
      catalog, value: createDefaultSharedDraft(catalog), locale: "zh", currency, onChange() {},
    }));
    assert.match(html, new RegExp(`id="field-contribution-amount-unit">${expected}<`));
    assert.match(html, /aria-describedby="field-contribution-amount-hint field-contribution-amount-unit"/);
  }
});


test("the shared summary uses confirmed saved dates for the same ticker and never fabricates a date", () => {
  const { sharedSummaryEndDate } = require("../.test-output/features/config/summary.js");
  const shared = createDefaultSharedDraft(catalog);
  const saved = { snapshot: { config: { shared: { run: { symbol: "QQQ", endMode: "fixed", endDate: "2024-02-02" } } }, dataProvenance: { marketDataThrough: "2024-02-01" } } };
  assert.equal(sharedSummaryEndDate(shared, saved), "2024-02-01");
  assert.equal(sharedSummaryEndDate({ ...shared, run: { ...shared.run, symbol: "SMH" } }, saved), null);
  assert.equal(sharedSummaryEndDate(shared, null), null);
  assert.equal(sharedSummaryEndDate({ ...shared, run: { ...shared.run, endMode: "fixed", endDate: "2023-12-29" } }, saved), "2023-12-29");
});
