import type { RunResponse, StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";

export function isCompletedResult(result: StrategyRun): boolean {
  return result.status === "completed" || result.status === "completed_with_warning";
}

export function resultDisplayName(locale: Locale, result: StrategyRun, results: StrategyRun[]): string {
  const peers = results.filter((item) => item.presetId === result.presetId && item.role === result.role);
  const name = translate(locale, `presets.${result.presetId}.name`);
  return peers.length > 1 ? `${name} · ${peers.findIndex((item) => item.id === result.id) + 1}` : name;
}

export function findFocusedResult(
  run: Pick<RunResponse, "result"> | null,
  focusedResultId: string | null,
): StrategyRun | null {
  if (!run || !focusedResultId) return null;
  return (run.result?.strategyRuns ?? []).find((result) => result.id === focusedResultId) ?? null;
}
