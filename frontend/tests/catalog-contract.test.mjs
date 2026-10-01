import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { fetchCatalog, isCatalog } = require("../.test-output/api/catalog.js");
const { translate } = require("../.test-output/i18n/messages.js");
const backendCatalog = JSON.parse(
  readFileSync(new URL("../.test-output/catalog.json", import.meta.url), "utf8"),
);

function parameter(key, type, value, extra = {}) {
  return {
    key,
    type,
    default: value,
    unit: null,
    minimum: null,
    maximum: null,
    step: null,
    allowedValues: [],
    applicablePresets: ["vix_dca"],
    searchable: false,
    dependencies: [],
    translationKey: `parameters.${key}`,
    groupId: "general",
    level: "shared",
    nullable: false,
    ...extra,
  };
}

const mockCatalog = {
  version: "catalog-test",
  parameterGroups: [{ id: "general", translationKey: "parameterGroups.general" }],
  parameters: [
    parameter("run.symbol", "symbol", "QQQ"),
    parameter("run.startDate", "date", "2020-01-01", { unit: "date" }),
    parameter("run.endDate", "date", null, { unit: "date", nullable: true }),
    parameter("run.endMode", "enum", "latest", {
      allowedValues: ["fixed", "latest"],
    }),
    parameter("contribution.amount", "decimal", "100", { unit: "currency" }),
    parameter("contribution.day", "integer", 1, { unit: "day_of_month" }),
  ],
  presets: [
    {
      id: "vix_dca",
      nameKey: "presets.vix_dca.name",
      descriptionKey: "presets.vix_dca.description",
      executionModule: "accumulation",
      parameterKeys: [
        "run.symbol",
        "run.startDate",
        "run.endDate",
        "run.endMode",
        "contribution.amount",
        "contribution.day",
      ],
      defaultParams: {},
      searchDimensions: [],
      supportsBenchmark: false,
    },
  ],
};

test("catalog mock satisfies the runtime OpenAPI contract", () => {
  assert.equal(isCatalog(mockCatalog), true);
});

test("catalog rejects duplicate field identities and dangling preset fields", () => {
  const duplicate = { ...mockCatalog, parameters: [...mockCatalog.parameters, mockCatalog.parameters[0]] };
  const dangling = {
    ...mockCatalog,
    presets: [{ ...mockCatalog.presets[0], parameterKeys: ["run.unknown"] }],
  };
  assert.equal(isCatalog(duplicate), false);
  assert.equal(isCatalog(dangling), false);
});

test("catalog rejects duplicate and unknown parameter groups", () => {
  const duplicateGroups = {
    ...mockCatalog,
    parameterGroups: [...mockCatalog.parameterGroups, mockCatalog.parameterGroups[0]],
  };
  const unknownGroup = {
    ...mockCatalog,
    parameters: mockCatalog.parameters.map((field, index) =>
      index === 0 ? { ...field, groupId: "missing" } : field,
    ),
  };
  assert.equal(isCatalog(duplicateGroups), false);
  assert.equal(isCatalog(unknownGroup), false);
});

test("the backend catalog response satisfies the frontend contract", () => {
  assert.equal(isCatalog(backendCatalog), true);
  for (const preset of backendCatalog.presets) {
    for (const parameterKey of preset.parameterKeys) {
      assert.ok(backendCatalog.parameters.some(({ key }) => key === parameterKey));
    }
  }
});

test("condition metadata rejects unknown keys, duplicate nodes and excessive depth", () => {
  const unknownKey = structuredClone(backendCatalog);
  unknownKey.conditions[0].buyParameterKeys.push("missing.key");
  assert.equal(isCatalog(unknownKey), false);
  const duplicate = structuredClone(backendCatalog);
  const preset = duplicate.presets.find(item => item.id === "vix_dca");
  preset.defaultRules.sell.id = preset.defaultRules.buy.id;
  assert.equal(isCatalog(duplicate), false);
  const deep = structuredClone(backendCatalog);
  const custom = deep.presets.find(item => item.id === "composite_dca");
  for (let depth = 0; depth <= deep.conditionLimits.maxDepth; depth++) {
    custom.defaultRules.buy = { type: "group", id: `group-${depth}`, enabled: true, operator: "AND", children: [custom.defaultRules.buy] };
  }
  assert.equal(isCatalog(deep), false);
});

test("catalog decimals are decoded as numbers before strategy defaults enter a draft", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(backendCatalog));
  try {
    const catalog = await fetchCatalog();
    const cashSafetyDefinition = catalog.parameters.find(
      ({ key }) => key === "accumulation.cashSafetyLimit",
    );
    const vixPreset = catalog.presets.find(({ id }) => id === "vix_dca");
    assert.equal(typeof cashSafetyDefinition.default, "number");
    assert.equal(typeof vixPreset.defaultParams["accumulation.cashSafetyLimit"], "number");
    assert.equal(vixPreset.defaultParams["accumulation.cashSafetyLimit"], 1200);
    assert.equal(vixPreset.defaultRules.buy.params["vix.buyThreshold"], 25);
    assert.equal(vixPreset.defaultRules.sell.params["exit.vix.ratio1"], 0.2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("all registered fields and preset labels are translated in both locales", () => {
  for (const locale of ["ja", "zh"]) {
    for (const definition of backendCatalog.parameters) {
      assert.notEqual(
        translate(locale, definition.translationKey),
        definition.translationKey,
        `${locale} is missing ${definition.translationKey}`,
      );
      if (["enum", "enum_list"].includes(definition.type)) {
        const helpKey = `parameterDescriptions.${definition.key}`;
        assert.notEqual(translate(locale, helpKey), helpKey, `${locale} is missing ${helpKey}`);
      }
    }
    for (const preset of backendCatalog.presets) {
      for (const key of [preset.nameKey, preset.descriptionKey]) {
        assert.notEqual(translate(locale, key), key, `${locale} is missing ${key}`);
      }
    }
    for (const group of backendCatalog.parameterGroups) {
      assert.notEqual(
        translate(locale, group.translationKey),
        group.translationKey,
        `${locale} is missing ${group.translationKey}`,
      );
    }
  }
});

test("the Japanese and Chinese dictionaries cover shared fields and preset names", () => {
  for (const locale of ["ja", "zh"]) {
    for (const definition of mockCatalog.parameters) {
      assert.notEqual(translate(locale, definition.translationKey), definition.translationKey);
    }
    assert.notEqual(translate(locale, "presets.vix_dca.name"), "presets.vix_dca.name");
  }
});

test("provider rate limit and timeout diagnostics are localized in both locales", () => {
  for (const locale of ["ja", "zh"]) {
    for (const key of [
      "market.provider_rate_limited",
      "market.provider_timeout",
      "runs.interrupted_by_restart",
    ]) {
      assert.notEqual(translate(locale, key), key, `${locale} is missing ${key}`);
    }
  }
});
