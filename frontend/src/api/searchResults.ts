import type { SearchCandidate, SearchPeriod, SearchResult, SearchTestResult } from "./generated";

/** Saved evaluation bounds; never infer a training curve from current inputs. */
export function searchCandidatePeriod(search: SearchResult, id: string): SearchPeriod | null {
  if (search.outOfSample?.resultId === id) return search.outOfSamplePeriod ?? null;
  const window = search.walkForwardWindows?.find(item => item.candidateIds.includes(id));
  if (window) return window.trainPeriod;
  return search.candidates.some(item => item.testResult?.resultId === id) ? search.testPeriod ?? null : search.trainPeriod ?? null;
}

export function searchOutcomes(search: SearchResult) {
  const rows: Array<{ id: string; outcome: SearchCandidate | SearchTestResult; period: SearchPeriod | null }> = [];
  for (const candidate of search.candidates) {
    rows.push({ id: candidate.candidateId, outcome: candidate, period: searchCandidatePeriod(search, candidate.candidateId) });
    if (candidate.testResult) rows.push({ id: candidate.testResult.resultId, outcome: candidate.testResult, period: searchCandidatePeriod(search, candidate.testResult.resultId) });
  }
  if (search.outOfSample) rows.push({ id: search.outOfSample.resultId, outcome: search.outOfSample, period: search.outOfSamplePeriod ?? null });
  return rows;
}
