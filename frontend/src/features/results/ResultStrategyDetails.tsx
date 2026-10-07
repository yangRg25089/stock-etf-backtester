import { useState, type CSSProperties } from "react";
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
  const [expanded, setExpanded] = useState(true);
  const [drawdownLocation, setDrawdownLocation] = useState<(DrawdownLocation & { resultId: string }) | null>(null);
  if (!run) return null;

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
            <h4 className="result-detail-name">{detailOwnerName}{candidateNumber && <span> · #{candidateNumber}</span>}{phaseLabel}</h4>
          </div>
        </section>
      )}
      <div id="result-panel-performance" className="result-detail-section">
        <PerformancePanel locale={locale} result={displayedResult} onEpisodeSelect={peakDate => {
          if (displayedResult) setDrawdownLocation(previous => ({ resultId: displayedResult.id, peakDate, sequence: (previous?.sequence ?? 0) + 1 }));
        }} />
        <PeriodPerformance key={displayedResult?.id} locale={locale} result={displayedResult} busy={busy || candidatePending} location={drawdownLocation?.resultId === displayedResult?.id ? drawdownLocation : null} />
        {displayedResult?.metrics && <TradingCostsPanel locale={locale} currency={displayedResult.metrics.currency} costs={displayedResult.metrics.tradingCosts} />}
      </div>
      {searchAvailable && focusedResult?.searchResult && <details id="result-panel-search" className="result-detail-section result-search-section" open>
        <summary>{translate(locale, "search.title", {count: String(focusedResult.searchResult.totalCandidateCount)})}</summary>
        <SearchResults locale={locale} searchResult={focusedResult.searchResult} selectedCandidateId={candidateResult?.id}
          onSelectCandidate={onSelectCandidate} pending={candidatePending} errorKey={candidateErrorKey} />
      </details>}
      <div id="result-panel-trades" className="result-detail-section">
        <TradeTable busy={busy || candidatePending} locale={locale} status={displayedResult?.status}
          trades={displayedResult?.trades ?? []} onTradeSelect={onTradeSelect}
          unexecutedSignals={displayedResult?.unexecutedSignals} onSignalSelect={onSignalSelect} />
      </div>
    </CollapsiblePanel>
  );
}
