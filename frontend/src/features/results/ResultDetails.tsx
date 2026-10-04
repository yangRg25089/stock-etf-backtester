import { useEffect, useState, type KeyboardEvent } from "react";
import type { Catalog, Diagnostic, RunResponse, StrategyRun, UnexecutedSignal } from "../../api/generated";
import type { RunApiError } from "../../api/runs";
import { translate, type Locale } from "../../i18n/messages";
import { CollapsiblePanel } from "../../shared/ui/CollapsiblePanel";
import type { WorkspaceAction, WorkspaceState } from "../strategies/model";
import { DiagnosticList, type DiagnosticFieldAction } from "../runs/DiagnosticList";
import { ExportControls } from "./ExportControls";
import { ReportDownloadButton } from "./ReportDownloadButton";
import { ResultComparison } from "./ResultSummary";
import { SearchResults } from "./SearchResults";
import { TradeTable } from "./TradeTable";
import { resultDisplayName } from "./model";
import { DEFAULT_COMPARISON_SORT, type ComparisonSort } from "./comparisonModel";
import { DataInformationButton } from "./DataInformationButton";
import { PerformancePanel } from "./PerformancePanel";
import { PeriodPerformance } from "./PeriodPerformance";
import { TradingCostsPanel } from "./TradingCostsPanel";
import { savedCandidate, savedEvaluationPhase, savedPeriodBenchmarks } from "./savedConfiguration";

type ResultTab = "comparison" | "trades" | "performance" | "search";

interface ResultDetailsProps {
  catalog?: Catalog | null;
  busy?: boolean;
  locale: Locale;
  run: RunResponse | null;
  focusedResult: StrategyRun | null;
  state: WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  error: RunApiError | null;
  fieldAction?(diagnostic: Diagnostic): DiagnosticFieldAction | null;
  comparisonSort?: ComparisonSort;
  onComparisonSortChange?(sort: ComparisonSort): void;
  candidateResult?: StrategyRun | null;
  candidatePending?: boolean;
  candidateErrorKey?: string | null;
  onSelectCandidate?(id: string): void;
  onTradeSelect?(index: number): void;
  onSignalSelect?(signal: UnexecutedSignal): void;
}

const TAB_KEYS: Record<ResultTab, string> = {
  comparison: "results.tab.comparison",
  trades: "results.tab.trades",
  search: "results.tab.search",
  performance: "results.tab.performance",
};

export function ResultDetails({
  catalog,
  busy = false,
  locale,
  run,
  focusedResult,
  state,
  dispatch,
  error,
  fieldAction,
  comparisonSort = DEFAULT_COMPARISON_SORT,
  onComparisonSortChange,
  candidateResult = null,
  candidatePending = false,
  candidateErrorKey = null,
  onSelectCandidate,
  onTradeSelect,
  onSignalSelect,
}: ResultDetailsProps) {
  const displayedResult = candidateResult ?? focusedResult;
  const strategyRuns = run?.result?.strategyRuns ?? [];
  const seenDiagnostics = new Set<string>();
  const diagnostics = [
    ...(error?.diagnostics ?? []),
    ...strategyRuns.flatMap((result) => [...(result.diagnostics ?? []), ...(result.metrics?.diagnostics ?? [])]),
  ].filter((diagnostic) => {
    const key = JSON.stringify([diagnostic.code, diagnostic.fieldPath ?? null, diagnostic.messageKey, diagnostic.details ?? null]);
    if (seenDiagnostics.has(key)) return false;
    seenDiagnostics.add(key);
    return true;
  });
  const searchAvailable = focusedResult?.presetId === "grid_search" && Boolean(focusedResult.searchResult);
  const tabs: ResultTab[] = run ? ["comparison", "trades", "performance"] : [];
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
  const tradeOwner = focusedResult ?? displayedResult;
  const tradeOwnerName = tradeOwner ? resultDisplayName(locale, tradeOwner, strategyRuns) : translate(locale, "results.tab.trades");
  const candidateNumber = candidateResult && savedCandidate(focusedResult?.searchResult, candidateResult.id)?.sequence;
  const phase = displayedResult?.evaluationPeriod;
  const phaseLabel = phase && displayedResult ? ` · ${translate(locale, `search.phase.${savedEvaluationPhase(displayedResult, candidateResult ? focusedResult : null)}`)} · ${phase.startDate} → ${phase.endDate}` : "";
  const headerActions = (
    <div className="result-context-actions">
      <DataInformationButton locale={locale} run={run} busy={busy || candidatePending} />
      <ExportControls locale={locale} runId={run?.runId ?? null} result={displayedResult} searchResult={focusedResult}
        importedRun={state.importedBacktest?.result} busy={busy || candidatePending} />
      <ReportDownloadButton locale={locale} run={run} result={displayedResult} catalog={catalog}
        parent={candidateResult ? focusedResult : null} busy={busy || candidatePending} />
    </div>
  );

  return (
    <CollapsiblePanel
      id="result-details"
      className="result-details"
      title={translate(locale, "results.details")}
      expanded={expanded}
      onExpandedChange={setExpanded}
      headerActions={headerActions}
      alwaysVisible={(!run || error || diagnostics.length > 0) ? (
        <>
          {error && !diagnostics.some((diagnostic) => diagnostic.messageKey === error.messageKey) && (
            <p className="field-error" role="alert">{translate(locale, error.messageKey)}</p>
          )}
          {diagnostics.length > 0 && (
            <div role="alert"><DiagnosticList locale={locale} diagnostics={diagnostics} fieldAction={busy ? undefined : fieldAction} /></div>
          )}
          {!run && !error && (
            <div className="empty-results" role="status">
              <span className="empty-mark" aria-hidden="true">⌁</span>
              <div>
                <strong>{translate(locale, "results.emptyTitle")}</strong>
                <p>{translate(locale, "results.emptyHelp")}</p>
              </div>
            </div>
          )}
        </>
      ) : undefined}
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
                <div>
                  <h4 className="sr-only" id="result-comparison-heading">
                    {translate(locale, "results.comparisonTitle")}
                  </h4>
                  <ResultComparison
                    busy={busy}
                    locale={locale}
                    strategyRuns={strategyRuns}
                    selectedResultIds={state.selectedResultIds ?? []}
                    sort={comparisonSort}
                    onSortChange={onComparisonSortChange}
                    onFocus={(id) => dispatch({ type: "result.focus", id })}
                    onToggleSelection={(id) => dispatch({ type: "result.toggleSelection", id })}
                  />
                </div>
              )}

              {tab === "trades" && (
                <section aria-labelledby="result-trades-heading">
                  <h4 className="result-trades-context" id="result-trades-heading" aria-live="polite">
                    {tradeOwnerName}{candidateNumber && <span> · #{candidateNumber}</span>}{phaseLabel}
                  </h4>
                  <TradeTable
                    busy={busy || candidatePending}
                    locale={locale}
                    status={displayedResult?.status}
                    trades={displayedResult?.trades ?? []}
                    onTradeSelect={onTradeSelect}
                    unexecutedSignals={displayedResult?.unexecutedSignals}
                    onSignalSelect={onSignalSelect}
                  />
                </section>
              )}

              {tab === "performance" && <>
                <h4 className="performance-owner">{tradeOwnerName}{candidateNumber && <span> · #{candidateNumber}</span>}{phaseLabel}</h4>
                <PerformancePanel locale={locale} result={displayedResult} />
                {displayedResult?.metrics && <TradingCostsPanel locale={locale} currency={displayedResult.metrics.currency} costs={displayedResult.metrics.tradingCosts} />}
                <PeriodPerformance locale={locale} result={displayedResult} benchmark={run && displayedResult ? savedPeriodBenchmarks(run, displayedResult, focusedResult).find(row => row.presetId === "monthly_dca") : undefined} />
              </>}

              {tab === "search" && searchAvailable && focusedResult?.searchResult && (
                <SearchResults locale={locale} searchResult={focusedResult.searchResult} selectedCandidateId={candidateResult?.id}
                  onSelectCandidate={onSelectCandidate} pending={candidatePending} errorKey={candidateErrorKey} />
              )}
            </div>
          ))}
        </>
      )}
    </CollapsiblePanel>
  );
}
