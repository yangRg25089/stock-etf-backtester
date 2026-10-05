import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { wireRun } from "./helpers/contracts.mjs";

const require = createRequire(import.meta.url);
const { RunApiError } = require("../.test-output/api/runs.js");
const { observeRun } = require("../.test-output/features/runs/observeRun.js");

function terminal(runId) {
  return { runId, status: "completed", progress: null, strategyStatuses: {} };
}

test("run observation delivers the terminal event then reads its frozen result exactly once", async () => {
  const saved = wireRun("observed-run", "completed");
  const calls = [];
  const events = [];
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, signal: init.signal, method: init.method ?? "GET" });
    if (url.endsWith("/events")) return new Response(`event: terminal\ndata: ${JSON.stringify(terminal(saved.runId))}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
    assert.equal(events.length, 1);
    return new Response(JSON.stringify(saved));
  };
  try {
    assert.deepEqual(await observeRun(saved.runId, event => events.push(event), controller.signal), saved);
    assert.deepEqual(calls.map(call => call.url), [`/api/v1/runs/${saved.runId}/events`, `/api/v1/runs/${saved.runId}`]);
    for (const call of calls) {
      assert.equal(call.signal, controller.signal);
      assert.equal(call.method, "GET");
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("a superseded restored run is checked after its terminal event and never reads a late result", async () => {
  const calls = [];
  let submitted = false;
  let checks = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    calls.push(url);
    return new Response(`event: terminal\ndata: ${JSON.stringify(terminal("superseded-run"))}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  try {
    const result = await observeRun("superseded-run", () => { submitted = true; }, undefined,
      () => { checks++; return !submitted; });
    assert.equal(result, null);
    assert.equal(checks, 1);
    assert.deepEqual(calls, ["/api/v1/runs/superseded-run/events"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("an invalid stream propagates its diagnostic and does not fetch a terminal result", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    calls.push(url);
    return new Response(": keep-alive\n\n", { headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    await assert.rejects(observeRun("incomplete-run", () => {}), error => error instanceof RunApiError);
    assert.deepEqual(calls, ["/api/v1/runs/incomplete-run/events"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("aborting run observation preserves AbortError and never fetches its result", async () => {
  const controller = new AbortController();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  };
  try {
    const observing = observeRun("aborted-run", () => {}, controller.signal);
    controller.abort();
    await assert.rejects(observing, error => error.name === "AbortError");
    assert.deepEqual(calls, ["/api/v1/runs/aborted-run/events"]);
  } finally { globalThis.fetch = originalFetch; }
});
