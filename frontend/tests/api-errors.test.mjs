import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { fetchRun, RunApiError, subscribeToRunEvents } = require("../.test-output/api/runs.js");
const { fetchCsvExport, ExportApiError } = require("../.test-output/api/exports.js");

test("JSON, SSE and CSV reject malformed error envelopes with their own HTTP errors", async () => {
  const original = globalThis.fetch;
  try {
    for (const payload of [{ error: {} }, { error: { code: 1, messageKey: [], diagnostics: "wrong" } }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 409 });
      for (const [action, ErrorClass] of [
        [() => fetchRun("bad"), RunApiError],
        [() => subscribeToRunEvents("bad", () => {}), RunApiError],
        [() => fetchCsvExport("bad", "row", "summary"), ExportApiError],
      ]) {
        await assert.rejects(action, error => {
          assert.ok(error instanceof ErrorClass);
          assert.equal(error.status, 409);
          assert.equal(error.code, "provider_request_failed");
          assert.equal(error.messageKey, "api.errors.invalid_request");
          return true;
        });
      }
    }
  } finally { globalThis.fetch = original; }
});
