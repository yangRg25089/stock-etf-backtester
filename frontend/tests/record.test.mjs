import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { isRecord } = require("../.test-output/shared/lib/record.js");

test("shared record guard retains object-only boundary semantics", () => {
  for (const value of [null, undefined, [], "", 0, true, () => {}]) assert.equal(isRecord(value), false);
  for (const value of [{}, { value: null }, Object.create(null), new Date()]) assert.equal(isRecord(value), true);
});
