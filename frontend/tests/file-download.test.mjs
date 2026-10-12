import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
const require = createRequire(import.meta.url);
const { triggerFileDownload } = require("../.test-output/features/results/exportModel.js");

test("strategy files and reports use a shared browser download primitive", () => {
  for (const path of ["features/files/PackageControls.tsx", "features/results/ReportDownloadButton.tsx"]) {
    const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
    assert.match(source, /import \{ triggerFileDownload \} from "\.\.\/\.\.\/shared\/lib\/fileDownload"/);
  }
});

test("downloads click an attached hidden anchor and revoke only after the download starts", () => {
  const original = { document: globalThis.document, window: globalThis.window,
    create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const calls = [];
  let release;
  const anchor = { click() { calls.push("click"); }, remove() { calls.push("remove"); } };
  const blob = new Blob(["saved result"]);
  URL.createObjectURL = value => { assert.equal(value, blob); calls.push("url"); return "blob:fixture"; };
  URL.revokeObjectURL = url => { assert.equal(url, "blob:fixture"); calls.push("revoke"); };
  globalThis.document = { createElement(tag) { assert.equal(tag, "a"); return anchor; }, body: { append(node) { assert.equal(node, anchor); calls.push("append"); } } };
  globalThis.window = { setTimeout(callback, delay) { assert.equal(delay, 1000); release = callback; } };
  try {
    triggerFileDownload(blob, "report.csv");
    assert.equal(anchor.hidden, true);
    assert.equal(anchor.href, "blob:fixture");
    assert.equal(anchor.download, "report.csv");
    assert.deepEqual(calls, ["url", "append", "click", "remove"]);
    release();
    assert.deepEqual(calls, ["url", "append", "click", "remove", "revoke"]);
  } finally {
    globalThis.document = original.document; globalThis.window = original.window;
    URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke;
  }
});
