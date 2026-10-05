import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { LOCALE_STORAGE_KEY, resolveLocale, readLocalePreference, saveLocalePreference } = require("../.test-output/i18n/localePreference.js");

test("a saved locale wins over browser language and persists under a stable key", () => {
  const saved = new Map([[LOCALE_STORAGE_KEY, "zh"]]);
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  assert.equal(readLocalePreference(storage, ["en-US", "ja-JP"]), "zh");
  assert.equal(saveLocalePreference(storage, "en"), true);
  assert.equal(readLocalePreference(storage, ["ja-JP"]), "en");
});

test("first-visit language follows ordered browser preferences and falls back to English", () => {
  assert.equal(resolveLocale(null, ["fr-FR", "ja-JP", "en-US"]), "ja");
  assert.equal(resolveLocale(null, ["zh-Hant-TW", "en-US"]), "zh");
  assert.equal(resolveLocale(null, ["en-GB"]), "en");
  assert.equal(resolveLocale(null, ["fr-FR", "de-DE"]), "en");
  assert.equal(resolveLocale("unsupported", ["ja-JP"]), "ja");
});

test("blocked browser storage does not prevent initial language choice or manual switching", () => {
  const storage = {
    getItem() { throw new Error("storage blocked"); },
    setItem() { throw new Error("storage blocked"); },
  };
  assert.equal(readLocalePreference(storage, ["zh-CN"]), "zh");
  assert.equal(saveLocalePreference(storage, "en"), false);
});
