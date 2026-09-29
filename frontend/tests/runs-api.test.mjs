import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { fetchRun, RunApiError, submitRun } = require("../.test-output/api/runs.js");
const { isPartialSuccess } = require("../.test-output/features/strategies/model.js");

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("run API sends selected scope, active identity, and idempotency key then reads saved statuses", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const accepted = {
    runId: "run-local-1",
    status: "running",
    selectedStrategyIds: ["active-vix", "invalid-rsi"],
    snapshot: { runId: "run-local-1", config: { shared: {}, strategies: [] } },
    result: { runId: "run-local-1", strategyRuns: [] },
  };
  const finished = {
    ...accepted,
    status: "completed_with_warning",
    result: {
      runId: "run-local-1",
      strategyRuns: [
        { id: "active-vix", presetId: "vix_dca", role: "strategy", status: "completed", diagnostics: [] },
        { id: "invalid-rsi", presetId: "composite_dca", role: "strategy", status: "unavailable", diagnostics: [
          { code: "required_data_unavailable", severity: "error", messageKey: "diagnostics.data.required_unavailable" },
        ] },
      ],
    },
  };
  const queue = [accepted, finished];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return response(queue.shift());
  };
  try {
    const draft = { shared: {}, strategies: [] };
    await submitRun(draft, "all_enabled", null, "retry-key-17");
    const saved = await fetchRun("run-local-1");

    assert.equal(calls[0].url, "/api/v1/runs");
    assert.equal(calls[0].init.headers["Idempotency-Key"], "retry-key-17");
    assert.deepEqual(JSON.parse(calls[0].init.body), { draft, scope: "all_enabled" });
    assert.equal(calls[1].url, "/api/v1/runs/run-local-1");
    assert.equal(isPartialSuccess(saved), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run API preserves stable server diagnostics from an error envelope", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({
    error: {
      code: "configuration_invalid",
      messageKey: "api.errors.invalid_configuration",
      diagnostics: [{
        code: "invalid_parameter",
        severity: "error",
        messageKey: "diagnostics.configuration.out_of_range",
        fieldPath: "strategies[0].params.vix.buyThreshold",
      }],
    },
  }, 422);
  try {
    await assert.rejects(
      submitRun({}, "active", "vix-1", "stable-key"),
      (error) => {
        assert.ok(error instanceof RunApiError);
        assert.equal(error.code, "configuration_invalid");
        assert.equal(error.diagnostics[0].fieldPath, "strategies[0].params.vix.buyThreshold");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
