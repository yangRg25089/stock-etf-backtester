import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readStyles } from "./helpers/readSources.mjs";
const require = createRequire(import.meta.url);

test("the stylesheet entry is an ordered import manifest with one token definition", () => {
  const entry = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(entry, /^@import "\.\/styles\/tokens.css";/);
  assert.equal(entry.replace(/@import\s+"[^"]+";\s*/g, ""), "");
  const css = readStyles();
  assert.equal((css.match(/--app-foreground:/g) ?? []).length, 2);
  assert.match(css, /\.chart-linked-stack/);
  assert.match(css, /@media \(pointer: coarse\)/);
});

test("locale modules have disjoint matching keys and retain the translation API", () => {
  const { translate, interpolate, unitLabel } = require("../.test-output/i18n/messages.js");
  const keysByLocale = [];
  for (const locale of ["ja", "zh", "en"]) {
    const keys = new Set();
    for (const name of ["common", "strategies", "results", "diagnostics"]) {
      const module = require(`../.test-output/i18n/${locale}/${name}.js`);
      const dictionary = Object.values(module)[0];
      for (const [key, value] of Object.entries(dictionary)) {
        assert.equal(keys.has(key), false, `${locale} duplicates ${key}`);
        keys.add(key);
        assert.equal(translate(locale, key), value);
      }
    }
    keysByLocale.push([...keys].sort());
    assert.equal(translate(locale, "not.a.machine.key"), "not.a.machine.key");
    assert.equal(translate(locale, "run.adjustedMarketStart", { date: "2024-01-01" }).includes("{date}"), false);
    assert.equal(unitLabel(locale, "symbol"), null);
    assert.equal(unitLabel(locale, "date"), null);
    assert.equal(unitLabel(locale, "unregistered_unit"), "unregistered_unit");
  }
  assert.deepEqual(keysByLocale[0], keysByLocale[1]);
  assert.deepEqual(keysByLocale[0], keysByLocale[2]);
  const japanese = require("../.test-output/i18n/ja/index.js").jaMessages;
  const english = require("../.test-output/i18n/en/index.js").enMessages;
  const placeholders = (value) => [...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
  for (const key of keysByLocale[0]) {
    assert.ok(english[key] && english[key] !== key, `missing English translation for ${key}`);
    assert.deepEqual(placeholders(english[key]), placeholders(japanese[key]), `placeholder mismatch for ${key}`);
  }
  assert.equal(interpolate("{value} {value}", { value: "2" }), "2 2");
  const source = readFileSync(new URL("../src/i18n/messages.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /const (?:parameterMessages|commonMessages)\b/);
});
