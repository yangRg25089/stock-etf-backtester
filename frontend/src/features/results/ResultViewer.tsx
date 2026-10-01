import type { RunResponse, StrategyRun, StrategyStatus } from "../../api/generated";
import type { RunApiError } from "../../api/runs";
import { translate, type Locale } from "../../i18n/messages";
import { CollapsiblePanel } from "../../shared/ui/CollapsiblePanel";
import type { WorkspaceAction, WorkspaceState } from "../strategies/model";
import { findFocusedResult } from "./model";
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
      />

      {run && focusedResult && (
        <CollapsiblePanel
          id="result-chart-panel"
          className="result-chart-panel"
          title={translate(locale, "chart.panelTitle")}
          expanded={state.showChart}
          onExpandedChange={(value) => dispatch({ type: "display.chart", value })}
        >
          {canShowSavedValues ? (
            <ResultsCharts
              key={focusedResult.id}
              locale={locale}
              dailyAssets={focusedResult.dailyAssets ?? []}
              trades={focusedResult.trades ?? []}
              signals={focusedResult.signals ?? []}
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
