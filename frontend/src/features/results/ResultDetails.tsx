import { useEffect, useState, type KeyboardEvent } from "react";
import type { RunResponse, StrategyRun } from "../../api/generated";
import type { RunApiError } from "../../api/runs";
import { translate, type Locale } from "../../i18n/messages";
import { CollapsiblePanel } from "../../shared/ui/CollapsiblePanel";
import type { WorkspaceAction, WorkspaceState } from "../strategies/model";
import { StatusView } from "../runs/StatusView";
import { ExportControls } from "./ExportControls";
import { ResultComparison } from "./ResultSummary";
import { SearchResults } from "./SearchResults";
import { TradeTable } from "./TradeTable";

type ResultTab = "comparison" | "trades" | "search";

interface ResultDetailsProps {
  locale: Locale;
  run: RunResponse | null;
  focusedResult: StrategyRun | null;
  state: WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  error: RunApiError | null;
}

const TAB_KEYS: Record<ResultTab, string> = {
  comparison: "results.tab.comparison",
  trades: "results.tab.trades",
  search: "results.tab.search",
};

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
}: ResultDetailsProps) {
  const strategyRuns = run?.result?.strategyRuns ?? [];
  const searchAvailable = focusedResult?.presetId === "grid_search" && Boolean(focusedResult.searchResult);
  const tabs: ResultTab[] = run ? ["comparison", "trades"] : [];
  if (searchAvailable) tabs.push("search");
  const [selectedTab, setSelectedTab] = useState<ResultTab>("comparison");
  const [expanded, setExpanded] = useState(true);
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

  const panelId = (tab: ResultTab) => `result-panel-${tab}`;
  const tabId = (tab: ResultTab) => `result-tab-${tab}`;
  const saved = run?.snapshot.config.shared.run;

  const headerDetails = (
    <div className="result-saved-context">
      {saved && (
        <details className="result-snapshot-info">
          <summary aria-label={translate(locale, "results.savedSettings")} title={translate(locale, "results.savedSettings")}>
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <circle cx="10" cy="10" r="8" /><path d="M10 9v5M10 5v1" />
            </svg>
          </summary>
          <div className="result-snapshot-info-content">
            <strong>{translate(locale, "results.savedSettings")}</strong>
            <p>{saved.symbol} · {saved.startDate} — {saved.endDate}</p>
            {focusedResult && <p>{resultOptionLabel(locale, focusedResult)}</p>}
          </div>
        </details>
      )}
    </div>
  );
  const headerActions = (
    <div className="result-context-actions">
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
                  <h4 className="sr-only" id="result-comparison-heading">
                    {translate(locale, "results.comparisonTitle")}
                  </h4>
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
                  <h4 className="sr-only" id="result-trades-heading">
                    {translate(locale, "results.tab.trades")}
                  </h4>
                  <div className="result-section-heading result-display-heading">
                    <button
                      className="display-toggle icon-only-button"
                      type="button"
                      aria-pressed={state.showTrades}
                      aria-label={translate(locale, state.showTrades ? "trade.hide" : "trade.toggle")}
                      title={translate(locale, state.showTrades ? "trade.hide" : "trade.toggle")}
                      onClick={() => dispatch({ type: "display.trades", value: !state.showTrades })}
                    >
                      <svg className="trade-display-icon" viewBox="0 0 20 20" focusable="false" aria-hidden="true">
                        <path d="M1.7 10s3-5.1 8.3-5.1 8.3 5.1 8.3 5.1-3 5.1-8.3 5.1S1.7 10 1.7 10Z" />
                        <circle cx="10" cy="10" r="2.2" />
                        {!state.showTrades && <path d="m3 17 14-14" />}
                      </svg>
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
