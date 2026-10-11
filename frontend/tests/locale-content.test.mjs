import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { translate } = require("../.test-output/i18n/messages.js");
const { formatStrategySummary } = require("../.test-output/features/strategies/strategySummary.js");
const dictionaries = Object.fromEntries(["ja", "zh", "en"].map(locale => [
  locale, require(`../.test-output/i18n/${locale}/index.js`)[`${locale}Messages`],
]));
const placeholders = text => [...text.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();

test("all supported locales contain matching keys and interpolation placeholders", () => {
  const reference = dictionaries.en;
  for (const [locale, messages] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(reference).sort(), locale);
    for (const key of Object.keys(reference)) {
      assert.deepEqual(placeholders(messages[key]), placeholders(reference[key]), `${locale}: ${key}`);
    }
  }
});

test("Japanese UI avoids Chinese chart terminology and misleading tax terminology", () => {
  for (const message of Object.values(dictionaries.ja)) {
    assert.doesNotMatch(message, /回測|中軌|下軌|上軌|読数|注資|簡易課税/);
  }
});

test("chart help describes horizontal panning without vertical panning in all locales", () => {
  assert.match(translate("en", "chart.interactionHelp"), /left or right/);
  assert.match(translate("ja", "chart.interactionHelp"), /左右/);
  assert.match(translate("zh", "chart.interactionHelp"), /左右/);
  for (const locale of ["ja", "zh", "en"]) {
    assert.doesNotMatch(translate(locale, "chart.interactionHelp"), /上下|全方向|縦方向|縦に|纵向|up.?down|vertically|any direction/i);
  }
});

test("monthly signal-buy summaries state a limit and handle unlimited buys naturally", () => {
  const params = { "vix.symbol": "^VIX", "vix.buyThreshold": 25, "accumulation.maxSignalBuysPerMonth": 1 };
  assert.match(formatStrategySummary("en", "vix_dca", params), /signal buys: up to 1 per month/);
  assert.match(formatStrategySummary("ja", "vix_dca", params), /月1回まで/);
  assert.match(formatStrategySummary("zh", "vix_dca", params), /每月最多.*1 次/);
  assert.match(formatStrategySummary("en", "vix_dca", {
    ...params, "accumulation.maxSignalBuysPerMonth": null,
  }), /signal buys: no monthly limit/);
});


test("held-out periods are consistently labelled as test periods", () => {
  for (const [locale, term] of [["ja", "テスト"], ["zh", "测试"], ["en", "Test"]]) {
    for (const key of ["search.phase.test", "search.testXirr", "search.viewTest"]) {
      assert.ok(translate(locale, key).toLowerCase().includes(term.toLowerCase()), `${locale}: ${key}`);
    }
  }
});
