import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ACTIVE_RUN_SESSION_KEY,
  clearActiveRunId,
  readActiveRunId,
  saveActiveRunId,
} = require("../.test-output/features/runs/activeRunSession.js");

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

test("accepted run ID is scoped to this tab's session storage key", () => {
  const storage = new MemoryStorage();

  saveActiveRunId("run-tab-a", storage);

  assert.equal(ACTIVE_RUN_SESSION_KEY, "stock-etf-backtester.active-run-id.v1");
  assert.equal(readActiveRunId(storage), "run-tab-a");
  assert.deepEqual([...storage.values.entries()], [[ACTIVE_RUN_SESSION_KEY, "run-tab-a"]]);
});

test("a stale run cannot clear a newer tab run ID", () => {
  const storage = new MemoryStorage();
  saveActiveRunId("run-new", storage);

  clearActiveRunId("run-old", storage);

  assert.equal(readActiveRunId(storage), "run-new");
  clearActiveRunId("run-new", storage);
  assert.equal(readActiveRunId(storage), null);
});

test("storage errors do not prevent the in-memory run flow", () => {
  const storage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };

  assert.equal(readActiveRunId(storage), null);
  assert.doesNotThrow(() => saveActiveRunId("run-memory-only", storage));
  assert.doesNotThrow(() => clearActiveRunId(undefined, storage));
});
