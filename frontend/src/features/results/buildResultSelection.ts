import type { RunResponse, StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import type { StrategyChartSeries } from "./chart/chartTypes";
import { resultColor } from "./colors";
import { isCompletedResult, resultDisplayName, selectedVolatilitySeries } from "./model";
import { savedPeriodBenchmarks } from "./savedConfiguration";
import { savedTechnicalIndicators } from "./technicalIndicators";

interface ResultSelectionInput {
  run: RunResponse | null;
  focusedResult: StrategyRun | null | undefined;
  candidateResult: StrategyRun | null | undefined;
  selectedIds: string[];
  orderedResults: StrategyRun[];
  locale: Locale;
}

/** Project saved selections; fetching and interaction state remain in the viewer. */
export function buildResultSelection({ run, focusedResult, candidateResult, selectedIds, orderedResults, locale }: ResultSelectionInput) {
  const strategyRuns = run?.result?.strategyRuns ?? [];
  const chartResult = candidateResult ?? (focusedResult && isCompletedResult(focusedResult) ? focusedResult
    : strategyRuns.find(result => isCompletedResult(result) && selectedIds.includes(result.id))
      ?? strategyRuns.find(isCompletedResult));
  const periodBenchmarks = run && chartResult ? savedPeriodBenchmarks(run, chartResult, focusedResult) : [];
  const benchmarksByPreset = new Map<StrategyRun["presetId"], StrategyRun>();
  for (const benchmark of periodBenchmarks) {
    if (!benchmarksByPreset.has(benchmark.presetId)) benchmarksByPreset.set(benchmark.presetId, benchmark);
  }
  const selectedComparisons: StrategyChartSeries[] = strategyRuns
    .filter(result => selectedIds.includes(result.id) && result.id !== (candidateResult ? focusedResult?.id : chartResult?.id) && isCompletedResult(result))
    .flatMap(result => {
      const period = chartResult?.evaluationPeriod;
      const matchesPeriod = !period || (result.evaluationPeriod?.phase === period.phase
        && result.evaluationPeriod.startDate === period.startDate && result.evaluationPeriod.endDate === period.endDate);
      const displayed = period && run && result.role === "benchmark" ? benchmarksByPreset.get(result.presetId)
        : matchesPeriod ? result : undefined;
      if (!displayed?.dailyAssets?.length) return [];
      const index = strategyRuns.findIndex(item => item.id === displayed.id
        || displayed.role === "benchmark" && item.role === "benchmark" && item.presetId === displayed.presetId);
      return [{ id: displayed.id, label: resultDisplayName(locale, displayed, strategyRuns), color: resultColor(index),
        dailyAssets: displayed.dailyAssets, trades: displayed.trades ?? [] }];
    });
  const focusedIndex = chartResult ? strategyRuns.findIndex(result => result.id === (candidateResult ? focusedResult?.id : chartResult.id)) : -1;
  const technicalResults = strategyRuns.filter(result => selectedIds.includes(result.id) && isCompletedResult(result)
    && result.id !== (candidateResult ? focusedResult?.id : null));
  if (candidateResult && focusedResult && selectedIds.includes(focusedResult.id)) technicalResults.push(candidateResult);
  const strategyOrder = orderedResults.map(result => {
    if (candidateResult && result.id === focusedResult?.id) return candidateResult.id;
    if (chartResult?.evaluationPeriod && run && result.role === "benchmark") return benchmarksByPreset.get(result.presetId)?.id ?? result.id;
    return result.id;
  });
  const findTradeResult = (resultId: string) => candidateResult?.id === resultId ? candidateResult
    : strategyRuns.find(item => item.id === resultId) ?? periodBenchmarks.find(item => item.id === resultId);
  return {
    chartResult, selectedComparisons, strategyOrder, findTradeResult,
    technicalIndicators: savedTechnicalIndicators(technicalResults),
    volatility: run ? selectedVolatilitySeries(run, strategyRuns, selectedIds, candidateResult, focusedResult) : [],
    totalAssetColor: focusedIndex >= 0 ? resultColor(focusedIndex) : undefined,
    showFocusedAsset: Boolean(chartResult && selectedIds.includes(candidateResult ? focusedResult?.id ?? "" : chartResult.id)),
    totalAssetLabel: chartResult ? resultDisplayName(locale, candidateResult && focusedResult ? focusedResult : chartResult, strategyRuns)
      + (chartResult.evaluationPeriod ? ` · ${translate(locale, `search.phase.${chartResult.evaluationPeriod.phase}`)}` : "") : "",
  };
}
