import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { ExportApiError, fetchCsvExport } = require("../.test-output/api/exports.js");
const { performCsvExport } = require("../.test-output/features/results/exportModel.js");
const { SearchResults } = require("../.test-output/features/results/SearchResults.js");

function candidate(candidateId, sequence, status = "completed") {
  return {
    candidateId,
    sequence,
    status,
    calculationFingerprint: `fingerprint-${candidateId}`,
    parameterValues: { "vix.buyThreshold": sequence + 20 },
    reusedCalculation: false,
    metrics: status === "completed" ? {
      totalContributed: "100.00",
      endingEquity: String(120 + sequence),
      netProfit: "20.00",
      returnOnContributions: "0.20",
      capitalMultiple: "1.20",
      xirr: "0.1",
      maximumDrawdown: "-0.05",
      relativeToDca: "2.00",
      currency: "USD",
      diagnostics: [],
    } : null,
    diagnostics: status === "failed" ? [{
      code: "calculation_failed",
      severity: "error",
      messageKey: "diagnostics.calculation_failed",
      fieldPath: "strategies[0].params.vix.buyThreshold",
    }] : [],
  };
}

test("search results retain backend ranking, invalid candidates, and stable diagnostics", () => {
  const html = renderToStaticMarkup(React.createElement(SearchResults, {
    locale: "zh",
    searchResult: {
      strategyId: "grid-instance",
      dimensions: [],
      totalCandidateCount: 3,
      candidates: [candidate("candidate-1", 0), candidate("candidate-2", 1, "failed"), candidate("candidate-3", 2)],
      rankedCandidateIds: ["candidate-3", "candidate-1"],
    },
  }));

  assert.ok(html.indexOf("candidate-3") < html.indexOf("candidate-1"));
  assert.ok(html.indexOf("candidate-1") < html.indexOf("candidate-2"));
  assert.match(html, /计算过程中发生错误/);
  assert.match(html, /strategies\[0\]\.params\.vix\.buyThreshold/);
  assert.match(html, /搜索候选（共 3 个）/);
  assert.match(html, /<caption class="sr-only">搜索候选/);
  assert.match(html, /<th scope="col">候选<\/th>/);
});

test("large searches render an initial page and expose the remaining candidate count", () => {
  const candidates = Array.from({ length: 105 }, (_, sequence) => candidate(`candidate-${sequence}`, sequence));
  const html = renderToStaticMarkup(React.createElement(SearchResults, {
    locale: "ja",
    searchResult: {
      strategyId: "grid-instance",
      dimensions: [],
      totalCandidateCount: candidates.length,
      candidates,
      rankedCandidateIds: [],
    },
  }));

  assert.equal((html.match(/<tr>/g) ?? []).length, 101);
  assert.match(html, /残り 5 件を表示/);
});

test("CSV API binds kind, run, and focused result and parses the server filename", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("date,totalAsset\n2024-01-02,100.00\n", {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename*=UTF-8''run%20one-result%2Fprimary-daily-assets.csv",
      },
    });
  };
  try {
    const result = await fetchCsvExport("run one", "result/primary", "daily-assets");
    assert.equal(calls[0].url, "/api/v1/runs/run%20one/export/daily-assets?focusedResultId=result%2Fprimary");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.headers.Accept, "text/csv");
    assert.equal(result.filename, "run one-result/primary-daily-assets.csv");
    assert.match(await result.blob.text(), /2024-01-02,100\.00/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CSV API preserves structured export diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      code: "result_not_exportable",
      messageKey: "api.errors.result_not_exportable",
      diagnostics: [{
        code: "required_data_unavailable",
        severity: "error",
        messageKey: "diagnostics.data.required_unavailable",
        fieldPath: "strategies[0].signals.vix",
      }],
    },
  }), { status: 409, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(
      fetchCsvExport("run-1", "failed-result", "summary"),
      (error) => {
        assert.ok(error instanceof ExportApiError);
        assert.equal(error.code, "result_not_exportable");
        assert.equal(error.messageKey, "api.errors.result_not_exportable");
        assert.equal(error.status, 409);
        assert.equal(error.diagnostics[0].fieldPath, "strategies[0].signals.vix");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CSV action downloads the focused server response", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const calls = [];
  let clickedAnchor = null;
  const anchor = {
    href: "",
    download: "",
    hidden: false,
    click() { clickedAnchor = this; },
    remove() { calls.push("removed"); },
  };
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, "a");
      return anchor;
    },
    body: { append(element) { assert.equal(element, anchor); calls.push("appended"); } },
  };
  globalThis.window = { setTimeout(callback) { callback(); return 0; } };
  URL.createObjectURL = (blob) => {
    assert.ok(blob instanceof Blob);
    calls.push("created-url");
    return "blob:focused-export";
  };
  URL.revokeObjectURL = (url) => calls.push(`revoked:${url}`);
  globalThis.fetch = async (url) => {
    calls.push(`requested:${url}`);
    return new Response("date,totalAsset\n2024-01-02,100.00\n", {
      status: 200,
      headers: { "Content-Disposition": "attachment; filename*=UTF-8''run-4-benchmark-dca-trades.csv" },
    });
  };
  try {
    await performCsvExport("run-4", "benchmark-dca", "trades");
    assert.equal(clickedAnchor, anchor);
    assert.equal(anchor.href, "blob:focused-export");
    assert.equal(anchor.download, "run-4-benchmark-dca-trades.csv");
    assert.deepEqual(calls, [
      "requested:/api/v1/runs/run-4/export/trades?focusedResultId=benchmark-dca",
      "created-url",
      "appended",
      "removed",
      "revoked:blob:focused-export",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});
