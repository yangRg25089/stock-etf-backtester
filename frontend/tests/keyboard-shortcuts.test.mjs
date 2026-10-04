import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { matchesWorkbenchShortcut } = require("../.test-output/shared/ui/useWorkbenchShortcut.js");

const event = { key: "Enter", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, repeat: false, defaultPrevented: false, isComposing: false };
test("workbench shortcuts accept Ctrl or Cmd with the precise key", () => {
  assert.equal(matchesWorkbenchShortcut(event, "Enter"), true);
  assert.equal(matchesWorkbenchShortcut({ ...event, ctrlKey: false, metaKey: true }, "Enter"), true);
  assert.equal(matchesWorkbenchShortcut({ ...event, key: "e" }, "E"), true);
  assert.equal(matchesWorkbenchShortcut({ ...event, key: "I" }, "i"), true);
  assert.equal(matchesWorkbenchShortcut({ ...event, key: "e" }, "i"), false);
});
test("bare, shifted, repeated, consumed and composing keys do not trigger app shortcuts", () => {
  for (const patch of [{ ctrlKey: false }, { shiftKey: true }, { altKey: true }, { repeat: true }, { defaultPrevented: true }, { isComposing: true }]) {
    assert.equal(matchesWorkbenchShortcut({ ...event, ...patch }, "Enter"), false);
  }
});
