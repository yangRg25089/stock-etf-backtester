import type { RunResponse, StrategyRun } from "../../api/generated";
import type { RunApiError } from "../../api/runs";
import { translate, type Locale } from "../../i18n/messages";
import { CollapsiblePanel } from "../../shared/ui/CollapsiblePanel";
import type { WorkspaceAction, WorkspaceState } from "../strategies/model";
import { conditionLeaves, conditionParameters } from "../strategies/conditions";
import { findFocusedResult, isCompletedResult, resultDisplayName } from "./model";
import { ResultsCharts } from "./ResultsCharts";
import { ResultDetails } from "./ResultDetails";
import { resultColor } from "./colors";

interface ResultViewerProps {
  locale: Locale;
  state: WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  error: RunApiError | null;
}

function savedParameters(run: RunResponse, result: StrategyRun): Record<string, unknown> {
  const strategy = run.snapshot.config.strategies?.find((item) => item.id === result.id);
  if (strategy?.rules) {
    const volatility = conditionLeaves(strategy.rules.buy, true).find(node => node.kind === "vix")
      ?? conditionLeaves(strategy.rules.sell, true).find(node => node.kind === "vix" || node.kind === "bollinger");
    return conditionParameters(volatility);
  }
  const params = strategy?.params;
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
}

function savedParameterText(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

export function ResultViewer({ locale, state, dispatch, error }: ResultViewerProps) {
  const run: RunResponse | null = state.runResponse;
  const focusedResult = findFocusedResult(run, state.focusedResultId);
  const strategyRuns = run?.result?.strategyRuns ?? [];
  const selectedIds = state.selectedResultIds;
  const chartResult = focusedResult && isCompletedResult(focusedResult) ? focusedResult
    : strategyRuns.find((result) => isCompletedResult(result) && selectedIds.includes(result.id))
      ?? strategyRuns.find(isCompletedResult);
  const params = run && chartResult ? savedParameters(run, chartResult) : {};
  const selectedComparisons = strategyRuns
    .filter((result) => selectedIds.includes(result.id) && result.id !== chartResult?.id && isCompletedResult(result))
    .flatMap((result) => {
      if (!result.dailyAssets || result.dailyAssets.length === 0) return [];
      const index = strategyRuns.findIndex((item) => item.id === result.id);
      return [{
        id: result.id,
        label: resultDisplayName(locale, result, strategyRuns),
        color: resultColor(index),
        dailyAssets: result.dailyAssets,
      }];
    });
  const focusedIndex = chartResult ? strategyRuns.findIndex((result) => result.id === chartResult.id) : -1;

  return (
    <div className="result-content">
      <ResultDetails
        key={run?.runId ?? "no-run"}
        locale={locale}
        run={run}
        focusedResult={focusedResult}
        state={state}
        dispatch={dispatch}
        error={error}
      />

      {run && focusedResult && (
        <CollapsiblePanel
          id="result-chart-panel"
          className="result-chart-panel"
          title={translate(locale, "chart.panelTitle")}
          expanded={state.showChart}
          onExpandedChange={(value) => dispatch({ type: "display.chart", value })}
        >
          {chartResult ? (
            <ResultsCharts
              key={run.runId}
              locale={locale}
              dailyAssets={chartResult.dailyAssets ?? []}
              trades={chartResult.trades ?? []}
              signals={chartResult.signals ?? []}
              showFocusedAsset={selectedIds.includes(chartResult.id)}
              comparisonSeries={selectedComparisons}
              totalAssetColor={focusedIndex >= 0 ? resultColor(focusedIndex) : undefined}
              vixSymbol={savedParameterText(params, "vix.symbol")}
              vixThreshold={savedParameterText(params, "vix.buyThreshold")}
              visibleSeriesIds={state.visibleSeriesIds}
              onSeriesChange={(id, visible) => dispatch({ type: "chart.series", id, visible })}
            />
          ) : (
            <p className="metric-empty">{translate(locale, "results.metricsUnavailable")}</p>
          )}
        </CollapsiblePanel>
      )}
    </div>
  );
}
