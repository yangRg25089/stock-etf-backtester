import { useEffect, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { RunResponse, StrategyRun, UnexecutedSignal } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { CollapsiblePanel } from "../../shared/ui/CollapsiblePanel";
import { SearchResults } from "./SearchResults";
import { TradeTable } from "./TradeTable";
import { resultDisplayName } from "./model";
import { PerformancePanel } from "./PerformancePanel";
import { PeriodPerformance } from "./PeriodPerformance";
import { TradingCostsPanel } from "./TradingCostsPanel";
import { savedCandidate, savedEvaluationPhase } from "./savedConfiguration";
import type { DrawdownLocation } from "./drawdownPresentation";
import { resultColor } from "./colors";

type ResultTab = "details" | "search";

interface ResultStrategyDetailsProps {
  busy?: boolean;
  locale: Locale;
  run: RunResponse | null;
  focusedResult: StrategyRun | null;
  candidateResult?: StrategyRun | null;
  candidatePending?: boolean;
  candidateErrorKey?: string | null;
  onSelectCandidate?(id: string): void;
  onTradeSelect?(index: number): void;
  onSignalSelect?(signal: UnexecutedSignal): void;
}

const TAB_KEYS: Record<ResultTab, string> = {
  details: "results.tab.details",
  search: "results.tab.search",
};

export function ResultStrategyDetails({
  busy = false,
  locale,
  run,
  focusedResult,
  candidateResult = null,
  candidatePending = false,
  candidateErrorKey = null,
  onSelectCandidate,
  onTradeSelect,
  onSignalSelect,
}: ResultStrategyDetailsProps) {
  const displayedResult = candidateResult ?? focusedResult;
  const strategyRuns = run?.result?.strategyRuns ?? [];
  const searchAvailable = focusedResult?.presetId === "grid_search" && Boolean(focusedResult.searchResult);
  const tabs: ResultTab[] = run ? ["details"] : [];
  if (searchAvailable) tabs.push("search");
  const [selectedTab, setSelectedTab] = useState<ResultTab>("details");
  const [expanded, setExpanded] = useState(true);
  const [drawdownLocation, setDrawdownLocation] = useState<(DrawdownLocation & { resultId: string }) | null>(null);
  const visibleTab = tabs.includes(selectedTab) ? selectedTab : "details";

  useEffect(() => {
    if (selectedTab === "search" && !searchAvailable) setSelectedTab("details");
  }, [searchAvailable, selectedTab]);

  if (!run) return null;

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
  const detailOwner = focusedResult ?? displayedResult;
  const detailOwnerName = detailOwner ? resultDisplayName(locale, detailOwner, strategyRuns) : translate(locale, "results.tab.trades");
  const candidateNumber = candidateResult && savedCandidate(focusedResult?.searchResult, candidateResult.id)?.sequence;
  const phase = displayedResult?.evaluationPeriod;
  const phaseLabel = phase && displayedResult ? ` · ${translate(locale, `search.phase.${savedEvaluationPhase(displayedResult, candidateResult ? focusedResult : null)}`)} · ${phase.startDate} → ${phase.endDate}` : "";

  return (
    <CollapsiblePanel
      id="result-strategy-details"
      className="result-details result-strategy-details"
      title={translate(locale, "results.strategyDetails")}
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {detailOwner && (
        <section className="result-detail-target" aria-label={translate(locale, "results.detailTarget")} aria-live="polite" aria-atomic="true"
          style={{ "--result-color": resultColor(strategyRuns.indexOf(detailOwner)) } as CSSProperties}>
          <span className="result-detail-target-swatch" aria-hidden="true" />
          <div>
            <span className="result-detail-target-label">{translate(locale, "results.detailTarget")}</span>
            <h4 className="result-detail-name">{detailOwnerName}{candidateNumber && <span> · #{candidateNumber}</span>}{phaseLabel}</h4>
          </div>
        </section>
      )}
      <div className="result-tabs" role="tablist" aria-label={translate(locale, "results.detailTabs")}>
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
          {tab === "details" && <>
            <div id="result-panel-trades" className="result-detail-section">
              <TradeTable
                busy={busy || candidatePending}
                locale={locale}
                status={displayedResult?.status}
                trades={displayedResult?.trades ?? []}
                onTradeSelect={onTradeSelect}
                unexecutedSignals={displayedResult?.unexecutedSignals}
                onSignalSelect={onSignalSelect}
              />
            </div>
            <div id="result-panel-performance" className="result-detail-section">
              <PerformancePanel locale={locale} result={displayedResult} onEpisodeSelect={peakDate => {
                if (displayedResult) setDrawdownLocation(previous => ({ resultId: displayedResult.id, peakDate, sequence: (previous?.sequence ?? 0) + 1 }));
              }} />
              {displayedResult?.metrics && <TradingCostsPanel locale={locale} currency={displayedResult.metrics.currency} costs={displayedResult.metrics.tradingCosts} />}
              <PeriodPerformance key={displayedResult?.id} locale={locale} result={displayedResult} busy={busy || candidatePending} location={drawdownLocation?.resultId === displayedResult?.id ? drawdownLocation : null} />
            </div>
          </>}

          {tab === "search" && searchAvailable && focusedResult?.searchResult && (
            <SearchResults locale={locale} searchResult={focusedResult.searchResult} selectedCandidateId={candidateResult?.id}
              onSelectCandidate={onSelectCandidate} pending={candidatePending} errorKey={candidateErrorKey} />
          )}
        </div>
      ))}
    </CollapsiblePanel>
  );
}
