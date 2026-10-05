import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { RETURN_COLOR_STORAGE_KEY, defaultReturnColorPalette, resolveReturnColorPalette, readReturnColorPreference, saveReturnColorPreference } = require("../.test-output/shared/lib/returnColorPreference.js");

test("return color defaults follow product language conventions", () => {
  assert.equal(defaultReturnColorPalette("zh"), "red-up");
  assert.equal(defaultReturnColorPalette("ja"), "green-up");
  assert.equal(defaultReturnColorPalette("en"), "green-up");
});

test("a manual return palette persists independently from locale", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(resolveReturnColorPalette("ja", readReturnColorPreference(storage)), "green-up");
  assert.equal(saveReturnColorPreference(storage, "red-up"), true);
  assert.equal(values.get(RETURN_COLOR_STORAGE_KEY), "red-up");
  assert.equal(resolveReturnColorPalette("en", readReturnColorPreference(storage)), "red-up");
});

test("invalid or unavailable storage falls back to the locale default", () => {
  assert.equal(resolveReturnColorPalette("zh", "purple"), "red-up");
  assert.equal(readReturnColorPreference(null), null);
  assert.equal(readReturnColorPreference({ getItem() { throw new Error("blocked"); } }), null);
  assert.equal(saveReturnColorPreference({ setItem() { throw new Error("blocked"); } }, "green-up"), false);
});
