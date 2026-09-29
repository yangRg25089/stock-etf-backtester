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
    level: "shared",
    nullable: false,
    ...extra,
  };
}

const mockCatalog = {
  version: "catalog-test",
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

test("the backend catalog response satisfies the frontend contract", () => {
  assert.equal(isCatalog(backendCatalog), true);
  for (const preset of backendCatalog.presets) {
    for (const parameterKey of preset.parameterKeys) {
      assert.ok(backendCatalog.parameters.some(({ key }) => key === parameterKey));
    }
  }
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
    }
    for (const preset of backendCatalog.presets) {
      for (const key of [preset.nameKey, preset.descriptionKey]) {
        assert.notEqual(translate(locale, key), key, `${locale} is missing ${key}`);
      }
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
    for (const key of ["market.provider_rate_limited", "market.provider_timeout"]) {
      assert.notEqual(translate(locale, key), key, `${locale} is missing ${key}`);
    }
  }
});
