import type { RunResponse, StrategyRun, StrategyStatus } from "../../api/generated";
import type { RunApiError } from "../../api/runs";
import { translate, type Locale } from "../../i18n/messages";
import type { WorkspaceAction, WorkspaceState } from "../strategies/model";
import { findFocusedResult, isRunSnapshotStale } from "./model";
import { ResultsCharts } from "./ResultsCharts";
import { ResultDetails } from "./ResultDetails";

interface ResultViewerProps {
  locale: Locale;
  state: WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  error: RunApiError | null;
}

const SUCCESS_STATUSES = new Set<StrategyStatus>(["completed", "completed_with_warning"]);

function savedParameters(run: RunResponse, result: StrategyRun): Record<string, unknown> {
  const strategy = run.snapshot.config.strategies?.find((item) => item.id === result.id);
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
  const canShowSavedValues = focusedResult !== null && SUCCESS_STATUSES.has(focusedResult.status ?? "queued");
  const params = run && focusedResult ? savedParameters(run, focusedResult) : {};

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
        snapshotStale={isRunSnapshotStale(state)}
      />

      {run && focusedResult && (
        <section aria-labelledby="result-display-heading">
          <div className="result-section-heading result-display-heading">
            <h3 id="result-display-heading">{translate(locale, "results.displayTitle")}</h3>
            <button
              className="display-toggle"
              type="button"
              aria-label={translate(locale, "chart.toggle")}
              title={translate(locale, "chart.toggle")}
              aria-pressed={state.showChart}
              onClick={() => dispatch({ type: "display.chart", value: !state.showChart })}
            >
              <span aria-hidden="true">
                <svg viewBox="0 0 20 20" focusable="false">
                  <path d="M2 17.5h16M3.5 14l4-4 3 2 5.5-7" />
                </svg>
              </span>
            </button>
          </div>
          {state.showChart && canShowSavedValues && (
            <ResultsCharts
              key={focusedResult.id}
              locale={locale}
              dailyAssets={focusedResult.dailyAssets ?? []}
              trades={focusedResult.trades ?? []}
              signals={focusedResult.signals ?? []}
              vixSymbol={savedParameterText(params, "vix.symbol")}
              vixThreshold={savedParameterText(params, "vix.buyThreshold")}
              assetSymbol={run.snapshot.config.shared.run.symbol}
              visibleSeriesIds={state.visibleSeriesIds}
              overlayMode={state.overlayMode}
              onSeriesChange={(id, visible) => dispatch({ type: "chart.series", id, visible })}
              onOverlayModeChange={(value) => dispatch({ type: "chart.overlay", value })}
            />
          )}
          {state.showChart && !canShowSavedValues && (
            <p className="metric-empty">{translate(locale, "results.metricsUnavailable")}</p>
          )}
        </section>
      )}
    </div>
  );
}
