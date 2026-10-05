import type { StrategyRun } from "../../api/generated";
import { isStrategyRun, sameJson } from "../../api/contractReader";
import { searchOutcomes } from "../../api/searchResults";

/** A candidate must match its immutable parent's saved outcome and evaluation period. */
export function isCandidateForSearch(detail: unknown, parent: StrategyRun, id: string): detail is StrategyRun {
  const saved = parent.searchResult && searchOutcomes(parent.searchResult).find(row => row.id === id);
  return Boolean(saved && isStrategyRun(detail) && detail.id === id && detail.presetId === "grid_search" && detail.role === "strategy"
    && detail.status === saved.outcome.status && sameJson(detail.metrics ?? null, saved.outcome.metrics ?? null)
    && sameJson(detail.evaluationPeriod ?? null, saved.period ?? null));
}
