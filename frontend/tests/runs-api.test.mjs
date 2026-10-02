import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  fetchLatestRun,
  fetchRun,
  RunApiError,
  submitRun,
  subscribeToRunEvents,
} = require("../.test-output/api/runs.js");
const { isPartialSuccess } = require("../.test-output/features/strategies/model.js");

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("run API sends all strategies without an editing identity and preserves idempotency and saved statuses", async () => {
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
    await submitRun(draft, "retry-key-17");
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

test("run API restores the latest saved response or an empty result", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const saved = {
    runId: "run-restored",
    status: "completed",
    selectedStrategyIds: ["strategy-vix_dca-1"],
    snapshot: { runId: "run-restored", config: { shared: {}, strategies: [] } },
    result: { runId: "run-restored", strategyRuns: [] },
  };
  const payloads = [saved, null];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return response(payloads.shift());
  };
  try {
    assert.deepEqual(await fetchLatestRun(), saved);
    assert.equal(await fetchLatestRun(), null);
    assert.deepEqual(calls.map(({ url }) => url), [
      "/api/v1/runs/latest",
      "/api/v1/runs/latest",
    ]);
    assert.deepEqual(calls.map(({ init }) => init.method), ["GET", "GET"]);
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
      submitRun({}, "stable-key"),
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

test("run event subscription parses split SSE frames and stops at terminal", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const events = [];
  const body = [
    'event: progress\ndata: {"runId":"run-stream","status":"running","progress":{"completedStrategies":1,"totalStrategies":3},"strategyStatuses":{"strategy-a":"completed","benchmark:monthly-dca":"running"}}\n\n',
    'event: terminal\ndata: {"runId":"run-stream","status":"completed_with_warning","progress":{"completedStrategies":3,"totalStrategies":3},"strategyStatuses":{"strategy-a":"completed_with_warning","benchmark:monthly-dca":"completed"}}\n\n',
  ].join("");
  const bytes = new TextEncoder().encode(body);
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 31));
        controller.enqueue(bytes.slice(31));
        controller.close();
      },
    }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  try {
    await subscribeToRunEvents("run-stream", (event) => events.push(event));

    assert.deepEqual(calls.map(({ url }) => url), ["/api/v1/runs/run-stream/events"]);
    assert.equal(calls[0].init.headers.Accept, "text/event-stream");
    assert.deepEqual(events.map(({ status }) => status), ["running", "completed_with_warning"]);
    assert.equal(events[1].strategyStatuses["strategy-a"], "completed_with_warning");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run event subscription is cancelled with its AbortSignal", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
    start(streamController) {
      init.signal.addEventListener("abort", () => {
        streamController.error(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    },
  }), {
    headers: { "Content-Type": "text/event-stream" },
  });

  try {
    const pending = subscribeToRunEvents("run-cancel", () => undefined, controller.signal);
    controller.abort();
    await assert.rejects(pending, (error) => error?.name === "AbortError");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid progress summaries are rejected before reaching result state", async () => {
  const original = globalThis.fetch;
  const delivered = [];
  try {
    for (const strategySummaries of [[], { one: null }, { one: { metrics: "invalid", diagnostics: [] } }, { one: { metrics: null, diagnostics: "invalid" } }]) {
      const event = { runId: "bad-summary", status: "completed", progress: { completedStrategies: 1, totalStrategies: 1 }, strategyStatuses: { one: "completed" }, strategySummaries };
      globalThis.fetch = async () => new Response(`event: terminal\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      await assert.rejects(subscribeToRunEvents(event.runId, item => delivered.push(item)), error => error instanceof RunApiError && error.code === "invalid_response");
    }
    assert.deepEqual(delivered, []);
  } finally { globalThis.fetch = original; }
});

test("instrument metadata, stop and candidate reads use their own saved API endpoints", async () => {
  const { fetchInstrument, stopRun, fetchCandidate } = require("../.test-output/api/runs.js");
  const original = globalThis.fetch;
  const calls = [];
  const metadata = { symbol: "7203.T", currency: "JPY", diagnostics: [] };
  const stopped = { runId: "one", status: "cancelled" };
  const candidate = { id: "candidate:2", status: "completed", dailyAssets: [{ date: "2024-01-02", totalAsset: "111" }] };
  const payloads = [metadata, stopped, candidate];
  globalThis.fetch = async (url, init) => { calls.push([url, init.method]); return response(payloads.shift()); };
  try {
    assert.deepEqual(await fetchInstrument("7203.T"), metadata);
    assert.deepEqual(await stopRun("one"), stopped);
    assert.deepEqual(await fetchCandidate("one", "candidate:2"), candidate);
    assert.deepEqual(calls, [["/api/v1/instruments/7203.T", "GET"], ["/api/v1/runs/one/stop", "POST"], ["/api/v1/runs/one/candidates/candidate%3A2", "GET"]]);
  } finally { globalThis.fetch = original; }
});

test("progress includes completed metrics while queued rows wait and cancellation is terminal", async () => {
  const original = globalThis.fetch;
  const summary = { metrics: { currency: "USD", endingEquity: "101" }, diagnostics: [] };
  const frames = [
    { runId: "progress", status: "running", progress: { completedStrategies: 1, totalStrategies: 3 }, strategyStatuses: { one: "completed", two: "running", three: "queued" }, strategySummaries: { one: summary } },
    { runId: "progress", status: "cancelled", progress: { completedStrategies: 3, totalStrategies: 3 }, strategyStatuses: { one: "completed", two: "cancelled", three: "cancelled" }, strategySummaries: { one: summary } },
  ];
  globalThis.fetch = async () => new Response(frames.map((frame, index) => `event: ${index ? "terminal" : "progress"}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  try {
    const received = [];
    await subscribeToRunEvents("progress", event => received.push(event));
    assert.deepEqual(received, frames);
    assert.equal(received[1].strategySummaries.one.metrics.endingEquity, "101");
    assert.equal(received[0].strategyStatuses.three, "queued");
  } finally { globalThis.fetch = original; }
});
