import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readStyles } from "./helpers/readSources.mjs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("the app composition layer does not own the run protocol or workspace reducer", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /\b(?:createIdempotencyKey|fetchActiveRun|fetchRun|subscribeToRunEvents|serializeDraftForApi|workspaceReducer)\s*\(/);
  assert.match(app, /useRunController\(/);
  assert.match(app, /useWorkspace\(/);
});

test("the app delegates directory loading, responsive listeners and field-path parsing", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /\b(?:fetchCatalog|matchMedia|matchAll)\s*\(|strategies\\\[/);
  assert.match(app, /useCatalog\(/);
  assert.match(app, /useWorkbenchLayout\(/);
  assert.match(app, /diagnosticTarget\(/);
});

test("startup rejects a missing root with an explicit error before mounting React", () => {
  const { applicationRoot } = require("../.test-output/app/applicationRoot.js");
  assert.throws(() => applicationRoot({ getElementById: () => null }), /Application root #root is missing/);
  const root = {};
  assert.equal(applicationRoot({ getElementById: id => id === "root" ? root : null }), root);
});

test("shared focus, muted controls and errors use semantic color tokens", () => {
  const css = readStyles();
  for (const color of ["#253c6d", "#30497d", "#455b8a", "#f2842f", "#e8ecf3", "#9c4b0d", "#fffafa", "#dfb8b9", "#67282b"]) {
    assert.equal((css.match(new RegExp(`${color}\\b`, "g")) ?? []).length, 1, `${color} should be defined once`);
  }
});
