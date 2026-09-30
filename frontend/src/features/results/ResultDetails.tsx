import { useEffect, useState, type KeyboardEvent } from "react";
import type { RunResponse, StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import type { WorkspaceAction, WorkspaceState } from "../strategies/model";
import { ExportControls } from "./ExportControls";
import { MetricGrid, ResultComparison } from "./ResultSummary";
import { SearchResults } from "./SearchResults";
import { TradeTable } from "./TradeTable";

type ResultTab = "comparison" | "trades" | "metrics" | "search" | "exports";

interface ResultDetailsProps {
  locale: Locale;
  run: RunResponse;
  focusedResult: StrategyRun | null;
  state: WorkspaceState;
  dispatch(action: WorkspaceAction): void;
}

const TAB_KEYS: Record<ResultTab, string> = {
  comparison: "results.tab.comparison",
  trades: "results.tab.trades",
  metrics: "results.tab.metrics",
  search: "results.tab.search",
  exports: "results.tab.exports",
};

export function ResultDetails({ locale, run, focusedResult, state, dispatch }: ResultDetailsProps) {
  const searchAvailable = focusedResult?.presetId === "grid_search" && Boolean(focusedResult.searchResult);
  const tabs: ResultTab[] = ["comparison", "trades", "metrics"];
  if (searchAvailable) tabs.push("search");
  tabs.push("exports");
  const [selectedTab, setSelectedTab] = useState<ResultTab>("comparison");
  const visibleTab = tabs.includes(selectedTab) ? selectedTab : "comparison";

  useEffect(() => {
    if (selectedTab === "search" && !searchAvailable) setSelectedTab("comparison");
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

  const strategyRuns = run.result?.strategyRuns ?? [];
  const panelId = (tab: ResultTab) => `result-panel-${tab}`;
  const tabId = (tab: ResultTab) => `result-tab-${tab}`;

  return (
    <section id="result-details" className="result-details" aria-labelledby="result-details-heading" tabIndex={-1}>
      <h3 id="result-details-heading" className="sr-only">{translate(locale, "results.details")}</h3>
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

      {tabs.map((tab) => (
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
                metrics={focusedResult && SUCCESS_STATUSES.has(focusedResult.status ?? "queued")
                  ? focusedResult.metrics
                  : null}
              />
            </section>
          )}

          {tab === "search" && searchAvailable && focusedResult?.searchResult && (
            <SearchResults locale={locale} searchResult={focusedResult.searchResult} />
          )}

          {tab === "exports" && (
            <section aria-labelledby="result-exports-heading">
              <div className="result-section-heading">
                <h4 id="result-exports-heading">{translate(locale, "results.tab.exports")}</h4>
              </div>
              <ExportControls locale={locale} runId={run.runId} result={focusedResult} />
            </section>
          )}
        </div>
      ))}
    </section>
  );
}

const SUCCESS_STATUSES = new Set(["completed", "completed_with_warning"]);
