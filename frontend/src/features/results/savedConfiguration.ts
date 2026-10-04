import type { RunResponse, SearchResult, StrategyRun } from "../../api/generated";
import { isRecord } from "../../api/contractReader";

export function savedCandidate(search: Pick<SearchResult, "candidates"> | null | undefined, id: string) {
  return search?.candidates.find(item => item.candidateId === id || item.testResult?.resultId === id);
}

export function savedEvaluationPhase(result: StrategyRun, parent?: StrategyRun | null) {
  const search = (parent ?? result).searchResult;
  return search?.optimizationMode === "walk_forward" && (!parent || result.id === search.outOfSample?.resultId)
    ? "outOfSample" : result.evaluationPeriod?.phase;
}

/** A partial evaluation must use a baseline from the same saved window. */
export function savedPeriodBenchmarks(run: RunResponse, result: StrategyRun, parent?: StrategyRun | null) {
  const search = (parent ?? result).searchResult;
  return result.evaluationPeriod ? (search?.periodBenchmarks ?? []).filter(item => item.evaluationPeriod?.phase === result.evaluationPeriod?.phase
    && item.evaluationPeriod?.startDate === result.evaluationPeriod?.startDate && item.evaluationPeriod?.endDate === result.evaluationPeriod?.endDate)
    : (run.result?.strategyRuns ?? []).filter(item => item.role === "benchmark");
}

/** Read the frozen strategy and the selected saved candidate's search dimensions. */
export function savedResultConfiguration(run: RunResponse, result: StrategyRun, parent?: StrategyRun | null, asOf?: string) {
  const owner = parent ?? result;
  const strategy = run.snapshot.config.strategies?.find(item => item.id === owner.id);
  const search = owner.searchResult;
  const outOfSample = search?.optimizationMode === "walk_forward" && (!parent || result.id === search.outOfSample?.resultId);
  const date = asOf ?? result.dailyAssets?.at(-1)?.date;
  const window = outOfSample ? search.walkForwardWindows?.find(item => date && item.testPeriod.startDate <= date && date <= item.testPeriod.endDate) : undefined;
  const candidate = search ? savedCandidate(search, outOfSample ? window?.selectedCandidateId ?? ""
    : parent ? result.id : search.rankedCandidateIds[0]) : undefined;
  const candidateValues = isRecord(candidate?.parameterValues) ? candidate.parameterValues : {};
  const overrides = Object.fromEntries((search?.dimensions ?? [])
    .filter(item => Object.hasOwn(candidateValues, item.key)).map(item => [item.key, candidateValues[item.key]]));
  const parameters = { ...(isRecord(strategy?.params) ? strategy.params : {}), ...candidateValues };
  return { strategy, candidate, parameters, overrides };
}
