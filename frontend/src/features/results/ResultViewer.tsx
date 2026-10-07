import { useEffect, useRef, useState } from "react";
import { fetchCandidate, RunApiError } from "../../api/runs";
import type { Catalog, Diagnostic, RunResponse, StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { CollapsiblePanel } from "../../shared/ui/CollapsiblePanel";
import type { WorkspaceAction, WorkspaceState } from "../strategies/model";
import { findFocusedResult, isCompletedResult } from "./model";
import { isCandidateForSearch } from "./candidateReader";
import { ResultsCharts } from "./ResultsCharts";
import { ResultDetails } from "./ResultDetails";
import { ResultStrategyDetails } from "./ResultStrategyDetails";
import { buildResultSelection } from "./buildResultSelection";
import { DEFAULT_COMPARISON_SORT, sortedComparisons } from "./comparisonModel";
import type { DiagnosticFieldAction } from "../runs/DiagnosticList";
import { TradeExplanationDialog, type ResultInspection } from "./TradeExplanationDialog";
import { useScrollBoundary } from "../../shared/ui/useScrollBoundary";

interface ResultViewerProps {
  catalog?: Catalog | null;
  busy?: boolean;
  locale: Locale;
  state: WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  error: RunApiError | null;
  fieldAction?(diagnostic: Diagnostic): DiagnosticFieldAction | null;
}

export function ResultViewer({ locale, state, dispatch, error, fieldAction, busy = false, catalog }: ResultViewerProps) {
  const tableScrollRef = useScrollBoundary();
  const run: RunResponse | null = state.runResponse;
  const focusedResult = findFocusedResult(run, state.focusedResultId);
  const strategyRuns = run?.result?.strategyRuns ?? [];
  const selectedIds = state.selectedResultIds;
  const [seriesInspection, setSeriesInspection] = useState<{ runId: string; id: string | null } | null>(null);
  const inspectedSeriesId = seriesInspection?.runId === run?.runId ? seriesInspection?.id ?? null : null;
  const inspectSeries = (id: string | null) => {
    if (busy || !run) return;
    setSeriesInspection({ runId: run.runId, id });
    if (id) {
      const parentId = candidateView?.result.id === id ? candidateView.parentId : id;
      if (strategyRuns.some(result => result.id === parentId)) dispatch({ type: "result.focus", id: parentId });
    }
  };
  const selectStrategy = (id: string) => {
    if (busy || !run) return;
    const selected = selectedIds.includes(id);
    dispatch({ type: "result.focus", id });
    dispatch({ type: "result.toggleSelection", id });
    const displayedId = candidateView?.parentId === id ? candidateView.result.id : id;
    setSeriesInspection({ runId: run.runId, id: selected ? inspectedSeriesId === displayedId ? null : inspectedSeriesId : displayedId });
  };
  const [comparisonView, setComparisonView] = useState({ runId: run?.runId, sort: DEFAULT_COMPARISON_SORT });
  const comparisonSort = comparisonView.runId === run?.runId ? comparisonView.sort : DEFAULT_COMPARISON_SORT;
  const orderedResults = sortedComparisons(strategyRuns, comparisonSort, locale);
  const [candidateView, setCandidateView] = useState<{ runId: string; parentId: string; result: StrategyRun } | null>(null);
  const [candidatePending, setCandidatePending] = useState(false);
  const [candidateErrorKey, setCandidateErrorKey] = useState<string | null>(null);
  const candidateController = useRef<AbortController | null>(null);
  const [inspection, setInspection] = useState<{ runId: string; value: ResultInspection } | null>(null);
  useEffect(() => { setInspection(null); }, [run?.runId, busy, candidatePending]);
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
      if (!isCandidateForSearch(result, focusedResult, candidateId)) throw new RunApiError("invalid_response", "api.errors.invalid_response");
      if (!controller.signal.aborted) {
        setCandidateView({ runId: run.runId, parentId: focusedResult.id, result });
        if (!selectedIds.includes(focusedResult.id)) dispatch({ type: "result.toggleSelection", id: focusedResult.id });
        setSeriesInspection({ runId: run.runId, id: result.id });
      }
    } catch (error) {
      if (!controller.signal.aborted) setCandidateErrorKey(error instanceof RunApiError ? error.messageKey : "api.errors.connection_failed");
    }
    finally { if (!controller.signal.aborted) setCandidatePending(false); }
  };
  const selection = buildResultSelection({ run, focusedResult, candidateResult, selectedIds, orderedResults, locale });
  const { chartResult, volatility } = selection;
  const inspect = (value: ResultInspection) => {
    if (run && !busy && !candidatePending && isCompletedResult(value.result)) setInspection({ runId: run.runId, value });
  };
  const inspectTrade = (resultId: string, index: number) => {
    const result = selection.findTradeResult(resultId);
    if (result) inspect({ result, parent: result === candidateResult ? focusedResult : null, kind: "trade", index });
  };
  const tradeResult = candidateResult ?? focusedResult;

  return (
    <div className="result-content" ref={tableScrollRef}>
      <ResultDetails
        catalog={catalog}
        busy={busy}
        key={`run-results:${run?.runId ?? "empty"}`}
        locale={locale}
        run={run}
        focusedResult={focusedResult}
        state={state}
        error={error}
        fieldAction={fieldAction}
        comparisonSort={comparisonSort}
        onComparisonSortChange={sort => setComparisonView({ runId: run?.runId, sort })}
        candidateResult={candidateResult ?? null}
        candidatePending={candidatePending}
        onSelectStrategy={selectStrategy}
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
              technicalIndicators={selection.technicalIndicators}
              totalAssetLabel={selection.totalAssetLabel}
              totalAssetResultId={chartResult.id}
              showFocusedAsset={selection.showFocusedAsset}
              comparisonSeries={selection.selectedComparisons}
              strategyOrder={selection.strategyOrder}
              totalAssetColor={selection.totalAssetColor}
              vixSymbol={volatility[0]?.symbol}
              vixThreshold={volatility[0]?.threshold}
              visibleSeriesIds={state.visibleSeriesIds}
              onSeriesChange={(id, visible) => dispatch({ type: "chart.series", id, visible })}
              onTradeSelect={inspectTrade}
              inspectedSeriesId={inspectedSeriesId}
              onInspectedSeriesChange={inspectSeries}
            />
          ) : (
            <p className="metric-empty">{translate(locale, "results.metricsUnavailable")}</p>
          )}
        </CollapsiblePanel>
      )}
      {run && (
        <ResultStrategyDetails
          key={`strategy-details:${run.runId}`}
          busy={busy}
          locale={locale}
          run={run}
          focusedResult={focusedResult}
          candidateResult={candidateResult ?? null}
          candidatePending={candidatePending}
          candidateErrorKey={candidateErrorKey}
          onSelectCandidate={id => void selectCandidate(id)}
          onTradeSelect={index => { if (tradeResult) inspectTrade(tradeResult.id, index); }}
          onSignalSelect={signal => { if (tradeResult) inspect({ result: tradeResult, parent: candidateResult ? focusedResult : null, kind: "signal", signal }); }}
        />
      )}
      {run && inspection?.runId === run.runId && !busy && !candidatePending && <TradeExplanationDialog run={run} inspection={inspection.value} locale={locale} onClose={() => setInspection(null)} />}
    </div>
  );
}
