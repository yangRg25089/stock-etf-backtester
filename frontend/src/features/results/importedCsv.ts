import fields from "../../api/generated.exports.json";
import type { ExportKind, RunResponse, SearchCandidate, SearchResult, StrategyRun } from "../../api/generated";
import { isExportAvailable } from "./exportModel";
import { runDataContext } from "../../api/contractReader";
import { expandDecimalDigits } from "../../shared/decimalText";

const DECIMAL_COLUMNS = new Set([...fields.decimal, ...fields["numeric-parameters"], ...fields["test-metrics"], ...fields["out-of-sample-metrics"]]);

function fixedDecimal(value: string): string {
  const parts = /^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(value);
  if (!parts) return value;
  const digits = parts[2] + (parts[3] ?? "");
  const point = parts[2].length + Number(parts[4]);
  const expanded = expandDecimalDigits(digits, point);
  return (parts[1] === "-" ? "-" : "") + expanded.replace(/^0+(?=\d)/, "");
}

function csvValue(value: unknown, column: string): string {
  let raw: string;
  if (value == null) raw = "";
  else if (typeof value === "string") raw = DECIMAL_COLUMNS.has(column) ? fixedDecimal(value) : value;
  else if (typeof value === "object") raw = sortedJson(value);
  else raw = String(value);
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => [key, sortJsonValue(child)]));
}

function sortedJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function flattenSavedMetrics(metrics: StrategyRun["metrics"] | undefined): Record<string, unknown> {
  return { ...metrics, ...metrics?.analysis, ...metrics?.tradingCosts };
}

function prefixedMetrics(metrics: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.metrics.map((key, index) => [columns[index], metrics[key]]));
}

function searchCandidateCsvRow(candidate: SearchCandidate, search: SearchResult,
  presetId: StrategyRun["presetId"], oosMetrics: Record<string, unknown>): Record<string, unknown> {
  const window = search.walkForwardWindows?.find(item => item.candidateIds.includes(candidate.candidateId));
  const train = window?.trainPeriod ?? search.trainPeriod;
  const test = window?.testPeriod ?? search.testPeriod;
  const oos = search.outOfSample;
  const testMetrics = flattenSavedMetrics(candidate.testResult?.metrics);
  return {
    ...candidate, ...candidate.parameterValues as Record<string, unknown>, ...flattenSavedMetrics(candidate.metrics),
    role: candidate.role ?? "strategy", presetId, diagnostics: sortedJson(candidate.diagnostics ?? []),
    reusedCalculation: candidate.reusedCalculation ?? false,
    optimizationMode: search.optimizationMode ?? "full_period", trainStartDate: train?.startDate,
    trainEndDate: train?.endDate, testStartDate: test?.startDate, testEndDate: test?.endDate,
    testResultId: candidate.testResult?.resultId, testStatus: candidate.testResult?.status,
    testDiagnostics: candidate.testResult ? sortedJson(candidate.testResult.diagnostics ?? []) : undefined,
    ...prefixedMetrics(testMetrics, fields["test-metrics"]),
    walkForwardWindow: window?.sequence, selectedForTesting: window ? candidate.candidateId === window.selectedCandidateId : undefined,
    outOfSampleResultId: oos?.resultId, outOfSampleStatus: oos?.status, outOfSampleStartDate: search.outOfSamplePeriod?.startDate,
    outOfSampleEndDate: search.outOfSamplePeriod?.endDate, outOfSampleDiagnostics: oos ? sortedJson(oos.diagnostics ?? []) : undefined,
    ...prefixedMetrics(oosMetrics, fields["out-of-sample-metrics"]),
  };
}

/** Render saved values only; column order comes from the backend CSV contract. */
export function importedCsv(run: RunResponse, result: StrategyRun, kind: ExportKind): string {
  if (!isExportAvailable(result, kind)) throw new Error("result_not_exportable");
  const data = runDataContext(run.snapshot);
  const context = { runId: run.runId, resultId: result.id,
    dataSources: JSON.stringify(data?.dataProvenance?.sources ?? []),
    calendarAsOf: data?.dataProvenance?.calendarAsOf,
    marketDataThrough: data?.dataProvenance?.marketDataThrough,
  };
  let columns: string[] = fields[kind];
  let rows: Record<string, unknown>[];
  if (kind === "summary") {
    const settings = data?.effectiveRun ?? run.snapshot.config.shared.run;
    rows = [{ ...context, ...flattenSavedMetrics(result.metrics), role: result.role, presetId: result.presetId, status: result.status,
      symbol: settings.symbol, startDate: result.evaluationPeriod?.startDate ?? settings.startDate,
      endDate: result.evaluationPeriod?.endDate ?? settings.endDate, diagnostics: sortedJson(result.diagnostics ?? []) }];
  } else if (kind === "daily-assets") {
    rows = (result.dailyAssets ?? []).map(asset => ({ ...context, ...asset, ...asset.tradingCosts, investmentBasis: result.metrics?.investmentBasis }));
  } else if (kind === "trades") {
    rows = (result.trades ?? []).map(trade => ({ ...context, ...trade, ...trade.tradingCosts }));
  } else {
    const search = result.searchResult!;
    const dimensions = search.dimensions.map(item => item.key);
    const others = [...new Set(search.candidates.flatMap(candidate => Object.keys(candidate.parameterValues as Record<string, unknown>)))].filter(key => !dimensions.includes(key)).sort();
    columns = [...fields["search-results"], ...dimensions, ...others, ...fields.metrics, "diagnostics", ...fields.provenance, ...fields["search-evaluation"]];
    const oosMetrics = flattenSavedMetrics(search.outOfSample?.metrics);
    rows = search.candidates.map(candidate => ({ ...context, ...searchCandidateCsvRow(candidate, search, result.presetId, oosMetrics) }));
  }
  return [columns.join(","), ...rows.map(row => columns.map(column => csvValue(row[column], column)).join(","))].join("\n") + "\n";
}
