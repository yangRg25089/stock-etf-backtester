import type { SearchCandidate, SearchResult, SearchResultDimension } from "../../api/generated";
import { compareDecimals, decimalIdentity, isRecord, isNumericSearchValue } from "../../api/contractReader";
import { isSuccessfulRunStatus } from "../../api/runStatus";

export type SearchStage = "train" | "test";
export type SearchMetric = "xirr" | "sharpe" | "calmar" | "drawdown";
export type SearchValue = string | number;
export type SearchSlice = Pick<SearchResult, "dimensions" | "candidates" | "rankedCandidateIds" | "optimizationMode">;

export const searchValue = isNumericSearchValue;

export function sortedSearchValues(dimension: SearchResultDimension): SearchValue[] {
  if (!dimension.values.every(searchValue)) throw new Error("invalid_search_values");
  return [...dimension.values].sort(compareDecimals);
}

export function searchParameters(candidate: SearchCandidate): Record<string, unknown> {
  return isRecord(candidate.parameterValues) ? candidate.parameterValues : {};
}

function fixedCandidates(result: SearchSlice, axes: string[], fixed: Record<string, unknown>) {
  const dimensions = new Map(result.dimensions.map(item => [item.key, item]));
  if (new Set(axes).size !== axes.length || axes.some(key => !dimensions.has(key))) throw new Error("invalid_search_axes");
  const remaining = result.dimensions.filter(item => !axes.includes(item.key));
  if (Object.keys(fixed).length !== remaining.length || remaining.some(item => !searchValue(fixed[item.key])
    || !sortedSearchValues(item).some(value => compareDecimals(value, fixed[item.key] as SearchValue) === 0))) throw new Error("unfixed_search_dimensions");
  return result.candidates.filter(candidate => remaining.every(item => {
    const value = searchParameters(candidate)[item.key];
    return searchValue(value) && compareDecimals(value, fixed[item.key] as SearchValue) === 0;
  }));
}

export function buildSearchHeatmap(result: SearchSlice, xKey: string, yKey: string, fixed: Record<string, unknown>) {
  const candidates = fixedCandidates(result, [xKey, yKey], fixed);
  const xValues = sortedSearchValues(result.dimensions.find(item => item.key === xKey)!);
  const yValues = sortedSearchValues(result.dimensions.find(item => item.key === yKey)!);
  const cellKey = (x: unknown, y: unknown) => searchValue(x) && searchValue(y) ? `${decimalIdentity(x)}:${decimalIdentity(y)}` : "";
  const cellsByValue = new Map(candidates.map(candidate => {
    const values = searchParameters(candidate);
    return [cellKey(values[xKey], values[yKey]), candidate];
  }));
  return { xValues, yValues, cells: yValues.map(y => xValues.map(x => cellsByValue.get(cellKey(x, y)) ?? null)) };
}

export function buildSearchNeighborhood(result: SearchSlice, dimension: string, fixed: Record<string, unknown>) {
  const candidates = fixedCandidates(result, [dimension], fixed);
  const values = sortedSearchValues(result.dimensions.find(item => item.key === dimension)!);
  const candidatesByValue = new Map(candidates.flatMap(candidate => {
    const value = searchParameters(candidate)[dimension];
    return searchValue(value) ? [[decimalIdentity(value), candidate] as const] : [];
  }));
  return { values, candidates: values.map(value => candidatesByValue.get(decimalIdentity(value)) ?? null) };
}

export function searchMetricValue(candidate: SearchCandidate | null, stage: SearchStage, metric: SearchMetric): string | null {
  const outcome = stage === "test" ? candidate?.testResult : candidate;
  if (!outcome || !isSuccessfulRunStatus(outcome.status) || !outcome.metrics) return null;
  const { metrics } = outcome;
  const value = metric === "xirr" ? metrics.xirr : metric === "drawdown" ? metrics.maximumDrawdown
    : metric === "sharpe" ? metrics.analysis?.sharpeRatio : metrics.analysis?.calmarRatio;
  return value != null && searchValue(value) ? String(value) : null;
}

export function searchOutcomeId(candidate: SearchCandidate | null, stage: SearchStage): string | null {
  const outcome = stage === "test" ? candidate?.testResult : candidate;
  return outcome && isSuccessfulRunStatus(outcome.status) && outcome.metrics
    ? stage === "test" ? candidate!.testResult!.resultId : candidate!.candidateId : null;
}
