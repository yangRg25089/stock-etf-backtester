import { useEffect, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { RunResponse, StrategyRun } from "../../api/generated";
import type { RunApiError } from "../../api/runs";
import { translate, type Locale } from "../../i18n/messages";
import { CollapsiblePanel } from "../../shared/ui/CollapsiblePanel";
import type { WorkspaceAction, WorkspaceState } from "../strategies/model";
import { StatusView } from "../runs/StatusView";
import { ExportControls } from "./ExportControls";
import { MetricGrid, ResultComparison } from "./ResultSummary";
import { SearchResults } from "./SearchResults";
import { TradeTable } from "./TradeTable";

type ResultTab = "overview" | "comparison" | "trades" | "metrics" | "search";

interface ResultDetailsProps {
  locale: Locale;
  run: RunResponse | null;
  focusedResult: StrategyRun | null;
  state: WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  error: RunApiError | null;
  snapshotStale: boolean;
}

const TAB_KEYS: Record<ResultTab, string> = {
  overview: "results.tab.overview",
  comparison: "results.tab.comparison",
  trades: "results.tab.trades",
  metrics: "results.tab.metrics",
  search: "results.tab.search",
};

const CORE_METRIC_STATUSES = new Set(["completed", "completed_with_warning"]);

function savedRunLabel(run: RunResponse | null): string | null {
  const saved = run?.snapshot.config.shared?.run;
  if (!saved) return null;
  return `${saved.symbol} · ${saved.startDate} — ${saved.endDate}`;
}

function resultOptionLabel(locale: Locale, result: StrategyRun): string {
  return `${translate(locale, `presets.${result.presetId}.name`)} · ${translate(locale, `results.role.${result.role}`)}`;
}

export function ResultDetails({
  locale,
  run,
  focusedResult,
  state,
  dispatch,
  error,
  snapshotStale,
}: ResultDetailsProps) {
  const strategyRuns = run?.result?.strategyRuns ?? [];
  const searchAvailable = focusedResult?.presetId === "grid_search" && Boolean(focusedResult.searchResult);
  const tabs: ResultTab[] = run ? ["overview", "comparison", "trades", "metrics"] : [];
  if (searchAvailable) tabs.push("search");
  const [selectedTab, setSelectedTab] = useState<ResultTab>("overview");
  const [expanded, setExpanded] = useState(true);
  const visibleTab = tabs.includes(selectedTab) ? selectedTab : "overview";

  useEffect(() => {
    if (selectedTab === "search" && !searchAvailable) setSelectedTab("overview");
  }, [searchAvailable, selectedTab]);

  const selectRelativeTab = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    setSelectedTab(nextTab);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>("[role='tab']")[nextIndex]
      ?.focus();
  };

  const focusResult = (event: ChangeEvent<HTMLSelectElement>) => {
    dispatch({ type: "result.focus", id: event.target.value || null });
  };
  const panelId = (tab: ResultTab) => `result-panel-${tab}`;
  const tabId = (tab: ResultTab) => `result-tab-${tab}`;
  const contextLabel = savedRunLabel(run);

  const headerDetails = (
    <div className="result-saved-context">
      {contextLabel && <strong className="result-saved-range">{contextLabel}</strong>}
      {run && <code className="result-run-id">{run.runId}</code>}
      {snapshotStale && (
        <p className="snapshot-warning" role="status">{translate(locale, "results.snapshotStale")}</p>
      )}
    </div>
  );
  const headerActions = (
    <div className="result-context-actions">
      <label className="sr-only" htmlFor="result-focus-select">
        {translate(locale, "results.focusSelector")}
      </label>
      <select
        id="result-focus-select"
        className="result-focus-select"
        aria-label={translate(locale, "results.focusSelector")}
        value={focusedResult?.id ?? ""}
        disabled={!run || strategyRuns.length === 0}
        onChange={focusResult}
      >
        {strategyRuns.length === 0 ? (
          <option value="">{translate(locale, "results.focusPending")}</option>
        ) : strategyRuns.map((result) => (
          <option key={`${result.role}-${result.id}`} value={result.id}>
            {resultOptionLabel(locale, result)}
          </option>
        ))}
      </select>
      <ExportControls locale={locale} runId={run?.runId ?? null} result={focusedResult} />
    </div>
  );

  return (
    <CollapsiblePanel
      id="result-details"
      className="result-details"
      title={translate(locale, "results.details")}
      expanded={expanded}
      onExpandedChange={setExpanded}
      headerDetails={headerDetails}
      headerActions={headerActions}
      alwaysVisible={<StatusView locale={locale} run={run} error={error} hideCleanSuccess />}
    >
      {tabs.length > 0 && (
        <>
          <div className="result-tabs" role="tablist" aria-label={translate(locale, "results.details")}>
            {tabs.map((tab, index) => (
              <button
                id={tabId(tab)}
                className="result-tab"
                key={tab}
                type="button"
                role="tab"
                aria-selected={visibleTab === tab}
                aria-controls={panelId(tab)}
                tabIndex={visibleTab === tab ? 0 : -1}
                onClick={() => setSelectedTab(tab)}
                onKeyDown={(event) => selectRelativeTab(event, index)}
              >
                {translate(locale, TAB_KEYS[tab])}
              </button>
            ))}
          </div>

          <div
            id={panelId("overview")}
            className="result-tab-panel result-overview-panel"
            role="tabpanel"
            aria-labelledby={tabId("overview")}
            tabIndex={0}
            hidden={visibleTab !== "overview"}
          >
            <h4 className="sr-only">{translate(locale, "results.tab.overview")}</h4>
            {focusedResult && CORE_METRIC_STATUSES.has(focusedResult.status ?? "queued") ? (
              <MetricGrid locale={locale} metrics={focusedResult.metrics} variant="core" />
            ) : (
              <p className="metric-empty" role="status">
                {translate(locale, focusedResult ? "results.metricsUnavailable" : "results.focusPending")}
              </p>
            )}
          </div>

          {tabs.filter((tab) => tab !== "overview").map((tab) => (
            <div
              id={panelId(tab)}
              key={tab}
              className="result-tab-panel"
              role="tabpanel"
              aria-labelledby={tabId(tab)}
              tabIndex={0}
              hidden={visibleTab !== tab}
            >
              {tab === "comparison" && (
                <section aria-labelledby="result-comparison-heading">
                  <div className="result-section-heading">
                    <h4 id="result-comparison-heading">{translate(locale, "results.comparisonTitle")}</h4>
                  </div>
                  <ResultComparison
                    locale={locale}
                    strategyRuns={strategyRuns}
                    focusedResultId={state.focusedResultId}
                    onFocus={(id) => dispatch({ type: "result.focus", id })}
                  />
                </section>
              )}

              {tab === "trades" && (
                <section aria-labelledby="result-trades-heading">
                  <div className="result-section-heading result-display-heading">
                    <h4 id="result-trades-heading">{translate(locale, "results.tab.trades")}</h4>
                    <button
                      className="display-toggle"
                      type="button"
                      aria-pressed={state.showTrades}
                      onClick={() => dispatch({ type: "display.trades", value: !state.showTrades })}
                    >
                      {translate(locale, "trade.toggle")}
                    </button>
                  </div>
                  {state.showTrades ? (
                    <TradeTable
                      locale={locale}
                      status={focusedResult?.status}
                      trades={focusedResult?.trades ?? []}
                    />
                  ) : (
                    <p className="metric-empty" role="status">{translate(locale, "trade.hidden")}</p>
                  )}
                </section>
              )}

              {tab === "metrics" && (
                <section aria-labelledby="result-all-metrics-heading">
                  <div className="result-section-heading">
                    <h4 id="result-all-metrics-heading">{translate(locale, "results.tab.metrics")}</h4>
                  </div>
                  <MetricGrid
                    locale={locale}
                    metrics={focusedResult && CORE_METRIC_STATUSES.has(focusedResult.status ?? "queued")
                      ? focusedResult.metrics
                      : null}
                    variant="additional"
                  />
                </section>
              )}

              {tab === "search" && searchAvailable && focusedResult?.searchResult && (
                <SearchResults locale={locale} searchResult={focusedResult.searchResult} />
              )}
            </div>
          ))}
        </>
      )}
    </CollapsiblePanel>
  );
}
