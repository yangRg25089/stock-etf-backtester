import type { MetricSummary, RunResponse, SignalEvaluation, StrategyRun } from "../../api/generated";
import { isSuccessfulRunStatus } from "../../api/runStatus";
import { translate, type Locale } from "../../i18n/messages";
import { strategyInstanceName } from "../../shared/lib/strategyInstanceName";
import { conditionLeaves, conditionParameters } from "../strategies/conditions";
import { savedResultConfiguration } from "./savedConfiguration";

export function investedPrincipalValue(metrics: MetricSummary | null | undefined): string | null {
  return metrics?.investmentBasis === "original_principal" ? metrics.actualInvested ?? null : null;
}

export interface SavedVolatilitySeries {
  symbol: string;
  signals: SignalEvaluation[];
  threshold?: string;
}

export function isVolatilityObservation(signal: SignalEvaluation, symbol?: string): boolean {
  if (!signal.conditionKind) return ["vix.buy", "vix.exit.low1", "vix.exit.low2", "bollinger.exit.vix"].includes(signal.signalId);
  return (signal.conditionKind === "vix" || signal.conditionKind === "bollinger")
    && signal.observedUnit === "index_points" && (!symbol || signal.sourceSymbol === symbol);
}

export function selectedVolatilitySeries(run: RunResponse, results: StrategyRun[], selectedIds: string[], candidate?: StrategyRun | null, parent?: StrategyRun | null): SavedVolatilitySeries[] {
  const groups = new Map<string, { signals: SignalEvaluation[]; thresholds: Set<string> }>();
  const selected = results.filter(result => selectedIds.includes(result.id) && result.id !== (candidate ? parent?.id : undefined));
  if (candidate && parent && selectedIds.includes(parent.id)) selected.push(candidate);
  for (const result of selected.filter(isCompletedResult)) {
    for (const signal of result.signals ?? []) {
      if (!isVolatilityObservation(signal)) continue;
      if (signal.observedValue === null || signal.observedValue === undefined || signal.observedValue === "" || !Number.isFinite(Number(signal.observedValue))) continue;
      const params = savedChartParameters(run, result, result === candidate ? parent : null, signal.date);
      const symbol = signal.sourceSymbol ?? String(params["vix.symbol"] ?? "^VIX");
      const group = groups.get(symbol) ?? { signals: [], thresholds: new Set<string>() };
      group.signals.push(signal);
      if (signal.signalId.startsWith("vix.buy") && params["vix.buyThreshold"] !== undefined) group.thresholds.add(String(params["vix.buyThreshold"]));
      groups.set(symbol, group);
    }
  }
  return [...groups].map(([symbol, group]) => ({ symbol, signals: group.signals,
    threshold: group.thresholds.size === 1 ? [...group.thresholds][0] : undefined }));
}

export function savedChartParameters(run: RunResponse, result: StrategyRun, parent?: StrategyRun | null, asOf?: string): Record<string, unknown> {
  const { strategy, parameters, overrides } = savedResultConfiguration(run, result, parent, asOf);
  if (strategy?.rules) {
    const volatility = conditionLeaves(strategy.rules.buy, true).find(node => node.kind === "vix")
      ?? conditionLeaves(strategy.rules.sell, true).find(node => node.kind === "vix" || node.kind === "bollinger");
    return { ...conditionParameters(volatility), ...overrides };
  }
  return parameters;
}

export function isCompletedResult(result: StrategyRun): boolean {
  return isSuccessfulRunStatus(result.status);
}

export function resultDisplayName(locale: Locale, result: StrategyRun, results: StrategyRun[]): string {
  const peers = results.filter((item) => item.presetId === result.presetId && item.role === result.role);
  const name = translate(locale, `presets.${result.presetId}.name`);
  const ordinal = result.instanceNumber ?? (peers.length > 1 ? peers.findIndex(item => item.id === result.id) + 1 : undefined);
  return strategyInstanceName(name, ordinal);
}

export function findFocusedResult(
  run: Pick<RunResponse, "result"> | null,
  focusedResultId: string | null,
): StrategyRun | null {
  if (!run || !focusedResultId) return null;
  return (run.result?.strategyRuns ?? []).find((result) => result.id === focusedResultId) ?? null;
}
