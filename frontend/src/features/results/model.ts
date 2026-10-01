import type { RunResponse, StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { conditionLeaves, conditionParameters } from "../strategies/conditions";

export function savedChartParameters(run: RunResponse, result: StrategyRun, parent?: StrategyRun | null): Record<string, unknown> {
  const strategy = run.snapshot.config.strategies?.find(item => item.id === (parent?.id ?? result.id));
  const search = parent?.searchResult ?? result.searchResult;
  const selected = search?.candidates.find(item => item.candidateId === (parent ? result.id : search.rankedCandidateIds[0]));
  const values = selected?.parameterValues;
  const overrides = values && typeof values === "object" && !Array.isArray(values)
    ? values as Record<string, unknown> : {};
  if (strategy?.rules) {
    const volatility = conditionLeaves(strategy.rules.buy, true).find(node => node.kind === "vix")
      ?? conditionLeaves(strategy.rules.sell, true).find(node => node.kind === "vix" || node.kind === "bollinger");
    const searched = Object.fromEntries((search?.dimensions ?? [])
      .filter(dimension => Object.hasOwn(overrides, dimension.key)).map(dimension => [dimension.key, overrides[dimension.key]]));
    return { ...conditionParameters(volatility), ...searched };
  }
  const params = strategy?.params;
  return { ...(typeof params === "object" && params !== null && !Array.isArray(params) ? params as Record<string, unknown> : {}), ...overrides };
}

export function isCompletedResult(result: StrategyRun): boolean {
  return result.status === "completed" || result.status === "completed_with_warning";
}

export function resultDisplayName(locale: Locale, result: StrategyRun, results: StrategyRun[]): string {
  const peers = results.filter((item) => item.presetId === result.presetId && item.role === result.role);
  const name = translate(locale, `presets.${result.presetId}.name`);
  if (result.instanceNumber) return `${name} ${result.instanceNumber}`;
  return peers.length > 1 ? `${name} · ${peers.findIndex((item) => item.id === result.id) + 1}` : name;
}

export function findFocusedResult(
  run: Pick<RunResponse, "result"> | null,
  focusedResultId: string | null,
): StrategyRun | null {
  if (!run || !focusedResultId) return null;
  return (run.result?.strategyRuns ?? []).find((result) => result.id === focusedResultId) ?? null;
}
