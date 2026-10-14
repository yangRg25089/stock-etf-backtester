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
      assert.ok(call.signal instanceof AbortSignal);
      assert.equal(call.signal.aborted, false);
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
    return new Response("event: progress\ndata: invalid-json\n\n", { headers: { "Content-Type": "text/event-stream" } });
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


test("interrupted progress recovers the complete partial result without losing successful rows", async () => {
  const saved = wireRun("partial-run", "completed_with_warning", ["success", "missing"]);
  saved.result.strategyRuns[1].status = "unavailable";
  saved.result.strategyRuns[1].metrics = null;
  saved.result.strategyRuns[1].diagnostics = [{ code: "required_data_unavailable", messageKey: "runs.execution_failed", severity: "error" }];
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    return url.endsWith("/events")
      ? new Response(": keep-alive\n\n", { headers: { "Content-Type": "text/event-stream" } })
      : new Response(JSON.stringify(saved));
  };
  try {
    assert.deepEqual(await observeRun(saved.runId, () => {}), saved);
    assert.deepEqual(calls, [`/api/v1/runs/${saved.runId}/events`, `/api/v1/runs/${saved.runId}`]);
  } finally { globalThis.fetch = originalFetch; }
});

test("a recovered active snapshot is displayed before re-observing its terminal result", async () => {
  const active = wireRun("recover-active", "running");
  const saved = wireRun(active.runId, "completed");
  const originalFetch = globalThis.fetch;
  const recovered = [];
  let streams = 0, reads = 0;
  globalThis.fetch = async url => {
    if (url.endsWith("/events")) return new Response(streams++ === 0 ? ": keep-alive\n\n" : `event: terminal\ndata: ${JSON.stringify(terminal(saved.runId))}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    return new Response(JSON.stringify(reads++ === 0 ? active : saved));
  };
  try {
    assert.deepEqual(await observeRun(saved.runId, () => {}, undefined, () => true, value => recovered.push(value)), saved);
    assert.deepEqual(recovered, [active]);
    assert.equal(streams, 2);
    assert.equal(reads, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("a restart's 404 remains visible and never invents a completed result", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    return url.endsWith("/events")
      ? new Response(": keep-alive\n\n", { headers: { "Content-Type": "text/event-stream" } })
      : new Response(JSON.stringify({ error: { code: "run_not_found", messageKey: "api.errors.run_not_found", diagnostics: [] } }), { status: 404 });
  };
  try {
    await assert.rejects(observeRun("lost-run", () => {}), error => error instanceof RunApiError && error.status === 404);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("aborting after an active recovery cancels its retry timer and never resubscribes", async () => {
  const active = wireRun("abort-recovery", "running");
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    return url.endsWith("/events")
      ? new Response(": keep-alive\n\n", { headers: { "Content-Type": "text/event-stream" } })
      : new Response(JSON.stringify(active));
  };
  try {
    await assert.rejects(observeRun(active.runId, () => {}, controller.signal, () => true, () => controller.abort()), error => error.name === "AbortError");
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("repeated connection loss has a bounded recovery budget and leaves active status truthful", async () => {
  const active = wireRun("bounded-recovery", "running");
  const originalFetch = globalThis.fetch;
  let streams = 0, reads = 0;
  globalThis.fetch = async url => {
    if (url.endsWith("/events")) {
      streams++;
      return new Response(": keep-alive\n\n", { headers: { "Content-Type": "text/event-stream" } });
    }
    reads++;
    return new Response(JSON.stringify(active));
  };
  try {
    await assert.rejects(observeRun(active.runId, () => {}), error => error instanceof RunApiError && error.status === null);
    assert.equal(streams, 4);
    assert.equal(reads, 3);
    assert.equal(active.status, "running");
  } finally { globalThis.fetch = originalFetch; }
});

test("an idle event reader times out and cancels instead of leaving the run stuck", async context => {
  const { subscribeToRunEvents } = require("../.test-output/api/runs.js");
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  context.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { "Content-Type": "text/event-stream" },
  });
  try {
    const pending = subscribeToRunEvents("idle", () => {});
    const rejected = assert.rejects(pending, error => error instanceof RunApiError && error.status === null);
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(45000);
    await rejected;
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("exhausted fast recovery keeps observation abortable until connectivity returns", async context => {
  const { observeRunUntilTerminal } = require("../.test-output/features/runs/observeRun.js");
  const active = wireRun("persistent", "running");
  const originalFetch = globalThis.fetch;
  const originalTimer = globalThis.setTimeout;
  const controller = new AbortController();
  let streams = 0, warnings = 0;
  // Accelerate only the retry delays, preserving the actual stream parser.
  globalThis.setTimeout = (callback, delay, ...args) => originalTimer(callback, delay === 500 || delay === 30000 ? 1 : delay, ...args);
  globalThis.fetch = async url => {
    if (url.endsWith("/events")) {
      streams++;
      return new Response(streams <= 4 ? ": keep-alive\n\n" : `event: terminal\ndata: ${JSON.stringify(terminal(active.runId))}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify(streams <= 4 ? active : wireRun(active.runId, "completed")));
  };
  try {
    const result = await observeRunUntilTerminal(active.runId, () => {}, controller.signal, () => true, () => {}, () => { warnings++; });
    assert.equal(result.status, "completed");
    assert.equal(streams, 5);
    assert.equal(warnings, 1);
  } finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimer; }
});

for (const phase of ['event headers', 'event error body', 'result headers', 'result body']) {
  test(`a stalled ${phase} request times out as a recoverable connection error`, async context => {
    const { subscribeToRunEvents, fetchRun } = require('../.test-output/api/runs.js');
    const originalFetch = globalThis.fetch;
    let requestSignal;
    context.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.fetch = async (_url, init) => {
      requestSignal = init.signal;
      if (phase === 'result body' || phase === 'event error body') return new Response(new ReadableStream(), { status: phase === 'event error body' ? 503 : 200 });
      return new Promise(() => {});
    };
    try {
      const pending = phase.startsWith('event') ? subscribeToRunEvents('stalled', () => {}) : fetchRun('stalled');
      const rejected = assert.rejects(pending, error => error instanceof RunApiError && error.status === null);
      await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.tick(60000);
      await rejected;
      assert.equal(requestSignal.aborted, true);
    } finally { globalThis.fetch = originalFetch; }
  });
}

for (const source of ['events', 'result']) {
  test(`recovery honors the ${source} response's Retry-After instead of retrying early`, async context => {
    const retrySeconds = source === 'events' ? 37 : 60;
    const controller = new AbortController();
    const active = wireRun(`retry-${source}`, 'running');
    const saved = wireRun(active.runId, 'completed');
    const originalFetch = globalThis.fetch;
    let streams = 0, reads = 0;
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const limited = () => new Response(JSON.stringify({ error: {
      code: 'rate_limited', messageKey: 'api.errors.rate_limited', diagnostics: [], retryAfterSeconds: retrySeconds,
    } }), { status: 429, headers: { 'Retry-After': String(retrySeconds) } });
    globalThis.fetch = async url => {
      if (url.endsWith('/events')) {
        streams++;
        if (streams === 1) return source === 'events' ? limited() : new Response(': keep-alive\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
        return new Response(`event: terminal\ndata: ${JSON.stringify(terminal(active.runId))}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      reads++;
      if (reads === 1) return source === 'result' ? limited() : new Response(JSON.stringify(active));
      return new Response(JSON.stringify(saved));
    };
    const pending = observeRun(active.runId, () => {}, controller.signal);
    try {
      await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.tick(5000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(streams, 1, 'must not reconnect before the provider retry interval');
      assert.equal(reads, source === 'events' ? 0 : 1, 'the shared API bucket also limits recovery reads');
      context.mock.timers.tick((retrySeconds - 5) * 1000);
      await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.tick(500);
      assert.deepEqual(await pending, saved);
      assert.equal(streams, 2);
    } finally {
      controller.abort();
      await pending.catch(() => {});
      globalThis.fetch = originalFetch;
    }
  });
}

test('slow observation recovery also honors the final rate-limit response', async context => {
  const { observeRunUntilTerminal } = require('../.test-output/features/runs/observeRun.js');
  const controller = new AbortController();
  const active = wireRun('slow-retry-limit', 'running');
  const saved = wireRun(active.runId, 'completed');
  const originalFetch = globalThis.fetch;
  let streams = 0, warnings = 0;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = async url => {
    if (!url.endsWith('/events')) return new Response(JSON.stringify(streams < 5 ? active : saved));
    streams++;
    if (streams === 4) return new Response(JSON.stringify({ error: {
      code: 'rate_limited', messageKey: 'api.errors.rate_limited', diagnostics: [], retryAfterSeconds: 60,
    } }), { status: 429 });
    return new Response(streams < 4 ? ': keep-alive\n\n' : `event: terminal\ndata: ${JSON.stringify(terminal(active.runId))}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const pending = observeRunUntilTerminal(active.runId, () => {}, controller.signal, () => true, () => {}, () => { warnings++; });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.tick(500);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warnings, 1);
    assert.equal(streams, 4);
    context.mock.timers.tick(30000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(streams, 4, 'slow retry must not precede Retry-After');
    context.mock.timers.tick(30000);
    assert.deepEqual(await pending, saved);
  } finally {
    controller.abort();
    await pending.catch(() => {});
    globalThis.fetch = originalFetch;
  }
});

test('a terminal result rate limit is respected before the recovery GET', async context => {
  const controller = new AbortController();
  const saved = wireRun('terminal-retry-limit', 'completed');
  const originalFetch = globalThis.fetch;
  let reads = 0;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = async url => {
    if (url.endsWith('/events')) return new Response(`event: terminal\ndata: ${JSON.stringify(terminal(saved.runId))}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    reads++;
    return reads === 1 ? new Response(JSON.stringify({ error: {
      code: 'rate_limited', messageKey: 'api.errors.rate_limited', diagnostics: [], retryAfterSeconds: 60,
    } }), { status: 429 }) : new Response(JSON.stringify(saved));
  };
  const pending = observeRun(saved.runId, () => {}, controller.signal);
  try {
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(5000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1, 'the recovery GET must respect the first GET rate limit');
    context.mock.timers.tick(55000);
    assert.deepEqual(await pending, saved);
    assert.equal(reads, 2);
  } finally {
    controller.abort();
    await pending.catch(() => {});
    globalThis.fetch = originalFetch;
  }
});
