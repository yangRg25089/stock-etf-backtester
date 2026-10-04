import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
const require = createRequire(import.meta.url);
const { isRunStatus, isActiveRunStatus, isSuccessfulRunStatus, isTerminalRunStatus } = require("../.test-output/api/runStatus.js");
const schema = JSON.parse(readFileSync(new URL("../src/api/generated.schema.json", import.meta.url), "utf8"));

test("every backend run status belongs to exactly one lifecycle phase", () => {
  const active = ["queued", "loading", "running"];
  const success = ["completed", "completed_with_warning"];
  const terminal = [...success, "unavailable", "failed", "cancelled"];
  assert.deepEqual(schema.StrategyStatus.enum, [...active, ...terminal]);
  for (const status of schema.StrategyStatus.enum) {
    assert.equal(isRunStatus(status), true);
    assert.equal(isActiveRunStatus(status), active.includes(status));
    assert.equal(isSuccessfulRunStatus(status), success.includes(status));
    assert.equal(isTerminalRunStatus(status), terminal.includes(status));
    assert.notEqual(isActiveRunStatus(status), isTerminalRunStatus(status));
  }
  for (const value of [undefined, null, "empty", "submitting", "ready", 1, {}]) {
    assert.equal(isRunStatus(value), false);
    assert.equal(isTerminalRunStatus(value), false);
    assert.equal(isSuccessfulRunStatus(value), false);
  }
});
