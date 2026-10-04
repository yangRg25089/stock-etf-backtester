import { readFileSync } from "node:fs";

export const catalog = JSON.parse(readFileSync(new URL("../../.test-output/catalog.json", import.meta.url), "utf8"));

export function wireRun(runId = "test-run", status = "completed", ids = ["strategy-vix_dca-1"]) {
  const data = Object.fromEntries(catalog.parameters.filter(item => item.key.startsWith("data.")).map(item => [item.key.slice(5), item.default]));
  const strategies = ids.map(id => ({ id, presetId: "vix_dca", enabled: true, params: {}, rules: null }));
  return {
    runId, status, selectedStrategyIds: ids,
    snapshot: { runId, config: { shared: { run: { symbol: "QQQ", startDate: "2024-01-01", endDate: "2024-03-01" }, contribution: { amount: "100", day: 1 }, data }, strategies },
      catalogVersion: catalog.version, engineVersion: "test-engine-v1", dataFingerprint: "test-data-v1", dataProvenance: { sources: ["fixture"], calendarAsOf: "2024-03-01", marketDataThrough: "2024-03-01" } },
    result: { runId, strategyRuns: strategies.map(item => ({ id: item.id, presetId: item.presetId, role: "strategy", status,
      diagnostics: ["failed", "unavailable"].includes(status) ? [{ code: status === "failed" ? "calculation_failed" : "required_data_unavailable", messageKey: "runs.execution_failed", severity: "error" }] : [],
      trades: [], signals: [], dailyAssets: [],
      metrics: ["completed", "completed_with_warning"].includes(status) ? { totalContributed: "200", actualInvested: "100", endingEquity: "220", netProfit: "20", returnOnContributions: "0.1", capitalMultiple: "1.1", currency: "USD", investmentBasis: "original_principal" } : null })) },
  };
}
