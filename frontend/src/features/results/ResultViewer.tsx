import { useEffect, useRef, useState } from "react";
import { fetchCandidate, RunApiError } from "../../api/runs";
import type { RunResponse, StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { CollapsiblePanel } from "../../shared/ui/CollapsiblePanel";
import type { WorkspaceAction, WorkspaceState } from "../strategies/model";
import { findFocusedResult, isCompletedResult, resultDisplayName, selectedVolatilitySeries } from "./model";
import { ResultsCharts } from "./ResultsCharts";
import { ResultDetails } from "./ResultDetails";
import { resultColor } from "./colors";
import { savedTechnicalIndicators } from "./technicalIndicators";

interface ResultViewerProps {
  busy?: boolean;
  locale: Locale;
  state: WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  error: RunApiError | null;
}

export function ResultViewer({ locale, state, dispatch, error, busy = false }: ResultViewerProps) {
  const run: RunResponse | null = state.runResponse;
  const focusedResult = findFocusedResult(run, state.focusedResultId);
  const strategyRuns = run?.result?.strategyRuns ?? [];
  const selectedIds = state.selectedResultIds;
  const [candidateView, setCandidateView] = useState<{ runId: string; parentId: string; result: StrategyRun } | null>(null);
  const [candidatePending, setCandidatePending] = useState(false);
  const [candidateErrorKey, setCandidateErrorKey] = useState<string | null>(null);
  const candidateController = useRef<AbortController | null>(null);
  useEffect(() => { setCandidateView(null); setCandidatePending(false); setCandidateErrorKey(null);
    return () => candidateController.current?.abort();
  }, [run?.runId, focusedResult?.id]);
  const candidateResult = candidateView?.runId === run?.runId && candidateView?.parentId === focusedResult?.id ? candidateView?.result : null;
  const selectCandidate = async (candidateId: string) => {
    if (busy || !run || !focusedResult) return;
    candidateController.current?.abort();
    const controller = new AbortController();
    candidateController.current = controller;
    setCandidatePending(true); setCandidateErrorKey(null);
    try {
      const result = await fetchCandidate(run.runId, candidateId, controller.signal);
      if (!controller.signal.aborted) setCandidateView({ runId: run.runId, parentId: focusedResult.id, result });
    } catch (error) {
      if (!controller.signal.aborted) setCandidateErrorKey(error instanceof RunApiError ? error.messageKey : "api.errors.connection_failed");
    }
    finally { if (!controller.signal.aborted) setCandidatePending(false); }
  };
  const chartResult = candidateResult ?? (focusedResult && isCompletedResult(focusedResult) ? focusedResult
    : strategyRuns.find((result) => isCompletedResult(result) && selectedIds.includes(result.id))
      ?? strategyRuns.find(isCompletedResult));
  const volatility = run ? selectedVolatilitySeries(run, strategyRuns, selectedIds, candidateResult, focusedResult) : [];
  const selectedComparisons = strategyRuns
    .filter((result) => selectedIds.includes(result.id) && result.id !== (candidateResult ? focusedResult?.id : chartResult?.id) && isCompletedResult(result))
    .flatMap((result) => {
      if (!result.dailyAssets || result.dailyAssets.length === 0) return [];
      const index = strategyRuns.findIndex((item) => item.id === result.id);
      return [{
        id: result.id,
        label: resultDisplayName(locale, result, strategyRuns),
        color: resultColor(index),
        dailyAssets: result.dailyAssets,
        trades: result.trades ?? [],
      }];
    });
  const focusedIndex = chartResult ? strategyRuns.findIndex((result) => result.id === (candidateResult ? focusedResult?.id : chartResult.id)) : -1;
  const technicalResults = strategyRuns.filter(result => selectedIds.includes(result.id) && isCompletedResult(result)
    && result.id !== (candidateResult ? focusedResult?.id : null));
  if (candidateResult) technicalResults.push(candidateResult);
  const technicalIndicators = savedTechnicalIndicators(technicalResults);

  return (
    <div className="result-content">
      <ResultDetails
        busy={busy}
        key={run?.runId ?? "no-run"}
        locale={locale}
        run={run}
        focusedResult={focusedResult}
        state={state}
        dispatch={dispatch}
        error={error}
        candidateResult={candidateResult ?? null}
        candidatePending={candidatePending}
        candidateErrorKey={candidateErrorKey}
        onSelectCandidate={id => void selectCandidate(id)}
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
              busy={busy}
              key={run.runId}
              locale={locale}
              dailyAssets={chartResult.dailyAssets ?? []}
              trades={chartResult.trades ?? []}
              signals={volatility[0]?.signals ?? []}
              volatilitySeries={volatility}
              technicalIndicators={technicalIndicators}
              totalAssetLabel={resultDisplayName(locale, candidateResult && focusedResult ? focusedResult : chartResult, strategyRuns)}
              totalAssetResultId={chartResult.id}
              showFocusedAsset={Boolean(candidateResult) || selectedIds.includes(chartResult.id)}
              comparisonSeries={selectedComparisons}
              totalAssetColor={focusedIndex >= 0 ? resultColor(focusedIndex) : undefined}
              vixSymbol={volatility[0]?.symbol}
              vixThreshold={volatility[0]?.threshold}
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
