import type { RunResponse, StrategyRun, StrategyStatus } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import type { WorkspaceAction, WorkspaceState } from "../strategies/model";
import { DiagnosticList } from "../runs/StatusView";
import { findFocusedResult, isRunSnapshotStale } from "./model";
import { ExportControls } from "./ExportControls";
import { MetricGrid, ResultComparison } from "./ResultSummary";
import { ResultsCharts } from "./ResultsCharts";
import { SearchResults } from "./SearchResults";
import { TradeTable } from "./TradeTable";

interface ResultViewerProps {
  locale: Locale;
  state: WorkspaceState;
  dispatch(action: WorkspaceAction): void;
}

const SUCCESS_STATUSES = new Set<StrategyStatus>(["completed", "completed_with_warning"]);

function resultDiagnostics(result: StrategyRun | null): NonNullable<StrategyRun["diagnostics"]> {
  return [
    ...(result?.diagnostics ?? []),
    ...(result?.metrics?.diagnostics ?? []),
  ];
}

export function ResultViewer({ locale, state, dispatch }: ResultViewerProps) {
  const run: RunResponse | null = state.runResponse;
  if (!run) {
    return (
      <div className="result-content">
        <ExportControls locale={locale} runId={null} result={null} />
      </div>
    );
  }

  const strategyRuns = run.result?.strategyRuns ?? [];
  const focusedResult = findFocusedResult(run, state.focusedResultId);
  const canShowSavedValues = focusedResult !== null && SUCCESS_STATUSES.has(focusedResult.status ?? "queued");
  const diagnostics = resultDiagnostics(focusedResult);

  return (
    <div className="result-content">
      {isRunSnapshotStale(state) && (
        <p className="snapshot-warning" role="status">{translate(locale, "results.snapshotStale")}</p>
      )}
      <section aria-labelledby="result-comparison-heading">
        <div className="result-section-heading">
          <h3 id="result-comparison-heading">{translate(locale, "results.comparisonTitle")}</h3>
        </div>
        <ResultComparison
          locale={locale}
          strategyRuns={strategyRuns}
          focusedResultId={state.focusedResultId}
          onFocus={(id) => dispatch({ type: "result.focus", id })}
        />
      </section>

      {focusedResult ? (
        <>
          <section aria-labelledby="focused-metrics-heading">
            <div className="result-section-heading">
              <h3 id="focused-metrics-heading">
                {translate(locale, "results.focusedTitle", {
                  name: translate(locale, `presets.${focusedResult.presetId}.name`),
                })}
              </h3>
            </div>
            <MetricGrid locale={locale} metrics={canShowSavedValues ? focusedResult.metrics : null} />
            <DiagnosticList locale={locale} diagnostics={diagnostics} />
          </section>

          <section aria-labelledby="result-display-heading">
            <div className="result-section-heading result-display-heading">
              <h3 id="result-display-heading">{translate(locale, "results.displayTitle")}</h3>
              <div className="result-display-toggles">
                <button
                  className="display-toggle"
                  type="button"
                  aria-pressed={state.showChart}
                  onClick={() => dispatch({ type: "display.chart", value: !state.showChart })}
                >
                  {translate(locale, "chart.toggle")}
                </button>
                <button
                  className="display-toggle"
                  type="button"
                  aria-pressed={state.showTrades}
                  onClick={() => dispatch({ type: "display.trades", value: !state.showTrades })}
                >
                  {translate(locale, "trade.toggle")}
                </button>
              </div>
            </div>
            {state.showChart && canShowSavedValues && (
              <ResultsCharts
                locale={locale}
                dailyAssets={focusedResult.dailyAssets ?? []}
                trades={focusedResult.trades ?? []}
                visibleSeriesIds={state.visibleSeriesIds}
                onSeriesChange={(id, visible) => dispatch({ type: "chart.series", id, visible })}
              />
            )}
            {state.showChart && !canShowSavedValues && (
              <p className="metric-empty">{translate(locale, "results.metricsUnavailable")}</p>
            )}
            {state.showTrades && (
              <TradeTable
                locale={locale}
                status={focusedResult.status}
                trades={focusedResult.trades ?? []}
              />
            )}
          </section>

          {focusedResult.searchResult && focusedResult.presetId === "grid_search" && (
            <SearchResults locale={locale} searchResult={focusedResult.searchResult} />
          )}
        </>
      ) : (
        <p className="metric-empty" role="status">{translate(locale, "results.focusPending")}</p>
      )}
      <ExportControls key={focusedResult?.id ?? "no-focused-result"} locale={locale} runId={run.runId} result={focusedResult} />
    </div>
  );
}
