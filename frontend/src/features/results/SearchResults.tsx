import { useState } from "react";
import type { SearchCandidate, SearchResult } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { DiagnosticList } from "../runs/DiagnosticList";
import { formatCurrency, formatPercent } from "./format";
import { SearchLab } from "./SearchLab";

const INITIAL_CANDIDATE_LIMIT = 100;

interface SearchResultsProps {
  locale: Locale;
  searchResult: SearchResult;
  selectedCandidateId?: string;
  onSelectCandidate?(id: string): void;
  pending?: boolean;
  errorKey?: string | null;
}

function candidateParameters(candidate: SearchCandidate, dimensions: string[]): Array<[string, unknown]> {
  if (typeof candidate.parameterValues !== "object" || candidate.parameterValues === null || Array.isArray(candidate.parameterValues)) {
    return [];
  }
  return Object.entries(candidate.parameterValues as Record<string, unknown>).filter(([key]) => dimensions.includes(key));
}

function orderedCandidates(searchResult: Pick<SearchResult, "candidates" | "rankedCandidateIds">): SearchCandidate[] {
  const candidatesById = new Map(searchResult.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const ranked = searchResult.rankedCandidateIds.flatMap((candidateId) => {
    const candidate = candidatesById.get(candidateId);
    return candidate ? [candidate] : [];
  });
  const rankedIds = new Set(searchResult.rankedCandidateIds);
  const unranked = searchResult.candidates
    .filter((candidate) => !rankedIds.has(candidate.candidateId))
    .sort((left, right) => left.sequence - right.sequence);
  return [...ranked, ...unranked];
}

function CandidateRow({ locale, candidate, selectedCandidateId, onSelect, dimensions, split }: { locale: Locale; candidate: SearchCandidate; selectedCandidateId?: string; onSelect?(id: string): void; dimensions: string[]; split: boolean }) {
  const metrics = candidate.metrics;
  const selected = selectedCandidateId === candidate.candidateId || selectedCandidateId === candidate.testResult?.resultId;
  const diagnostics = [
    ...(candidate.diagnostics ?? []),
    ...(metrics?.diagnostics ?? []),
    ...(candidate.testResult?.diagnostics ?? []),
  ];
  return (
    <tr className={selected ? "is-selected" : ""} onClick={metrics ? () => onSelect?.(candidate.candidateId) : undefined}>
      <th scope="row">
        <button type="button" className="result-select" disabled={!metrics} aria-pressed={selectedCandidateId === candidate.candidateId}
          onClick={event => { event.stopPropagation(); onSelect?.(candidate.candidateId); }}>{candidate.sequence}</button>
      </th>
      <td><span className="status-tag">{translate(locale, `status.${candidate.status}`)}</span></td>
      <td>
        <dl className="search-parameters">
          {candidateParameters(candidate, dimensions).map(([key, value]) => (
            <div key={key}>
              <dt>{translate(locale, `parameters.${key}`)}</dt>
              <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      </td>
      <td>{formatCurrency(metrics?.endingEquity, metrics?.currency, locale)}</td>
      <td>{formatPercent(metrics?.maximumDrawdown, locale)}</td>
      {split && <>
        <td>{formatPercent(metrics?.xirr, locale)}</td>
        <td><button type="button" className="search-test-select" disabled={!candidate.testResult?.metrics}
          aria-pressed={selectedCandidateId === candidate.testResult?.resultId}
          aria-label={translate(locale, "search.viewTest", { number: String(candidate.sequence) })}
          onClick={event => { event.stopPropagation(); if (candidate.testResult) onSelect?.(candidate.testResult.resultId); }}>
          {formatPercent(candidate.testResult?.metrics?.xirr, locale)} <span aria-hidden="true">↗</span>
        </button>{candidate.testResult && !candidate.testResult.metrics && <span className="search-test-status">{translate(locale, `status.${candidate.testResult.status}`)}</span>}</td>
      </>}
      <td>
        {candidate.reusedCalculation && <span className="search-reused">{translate(locale, "search.reused")}</span>}
        <DiagnosticList locale={locale} diagnostics={diagnostics} />
      </td>
    </tr>
  );
}

export function SearchResults({ locale, searchResult, selectedCandidateId, onSelectCandidate, pending, errorKey }: SearchResultsProps) {
  const [showAll, setShowAll] = useState(false);
  const [windowIndex, setWindowIndex] = useState(0);
  const window = searchResult.walkForwardWindows?.[windowIndex] ?? searchResult.walkForwardWindows?.[0];
  const slice = { dimensions: searchResult.dimensions, optimizationMode: searchResult.optimizationMode,
    candidates: window ? searchResult.candidates.filter(item => window.candidateIds.includes(item.candidateId)) : searchResult.candidates,
    rankedCandidateIds: window?.rankedCandidateIds ?? searchResult.rankedCandidateIds };
  const candidates = orderedCandidates(slice);
  const displayed = showAll ? candidates : candidates.slice(0, INITIAL_CANDIDATE_LIMIT);
  const hiddenCount = candidates.length - displayed.length;
  const split = searchResult.optimizationMode === "train_test";

  return (
    <section className="search-results" aria-labelledby="search-results-title">
      <h3 className="sr-only" id="search-results-title">
        {translate(locale, "search.title", { count: String(searchResult.totalCandidateCount) })}
      </h3>
      {pending && <p role="status">{translate(locale, "search.loadingCurve")}</p>}
      {errorKey && <p className="field-error" role="alert">{translate(locale, errorKey)}</p>}
      {window && <div className="search-walk-controls">
        <label>{translate(locale, "search.walkWindow")}<select className="input search-window-select" value={windowIndex} disabled={pending}
          onChange={event => { setWindowIndex(Number(event.target.value)); setShowAll(false); }}>
          {searchResult.walkForwardWindows?.map((item, index) => <option value={index} key={item.sequence}>
            {item.sequence} · {item.trainPeriod.startDate} → {item.trainPeriod.endDate}
          </option>)}
        </select></label>
        <button type="button" className="button search-oos-select" disabled={pending || !searchResult.outOfSample?.metrics}
          aria-pressed={!selectedCandidateId || selectedCandidateId === searchResult.outOfSample?.resultId}
          onClick={() => { if (searchResult.outOfSample) onSelectCandidate?.(searchResult.outOfSample.resultId); }}>
          {translate(locale, "search.viewOutOfSample")} <span aria-hidden="true">↗</span>
        </button>
      </div>}
      {window && <dl className="search-periods">{[window.trainPeriod, window.testPeriod].map(period => <div key={period.phase}>
        <dt>{translate(locale, `search.phase.${period.phase}`)}</dt><dd>{period.startDate} → {period.endDate}</dd>
      </div>)}</dl>}
      {split && <dl className="search-periods">
        {[searchResult.trainPeriod, searchResult.testPeriod].map(period => period && <div key={period.phase}>
          <dt>{translate(locale, `search.phase.${period.phase}`)}</dt><dd>{period.startDate} → {period.endDate}</dd>
        </div>)}
      </dl>}
      {searchResult.dimensions.length > 0 && <SearchLab key={`${searchResult.strategyId}:${window?.sequence ?? 0}`} result={slice} locale={locale}
        selectedId={selectedCandidateId} pending={pending} onSelect={onSelectCandidate} />}
      <div className="data-table-scroll search-table-scroll" tabIndex={0} role="region"
        aria-label={translate(locale, "search.title", { count: String(searchResult.totalCandidateCount) })}>
        <table className="data-table search-table">
          <caption className="sr-only">{translate(locale, "search.title", { count: String(searchResult.totalCandidateCount) })}</caption>
          <thead>
            <tr>
              <th scope="col">{translate(locale, "search.sequence")}</th>
              <th scope="col">{translate(locale, "results.status")}</th>
              <th scope="col">{translate(locale, "search.parameters")}</th>
              <th scope="col">{translate(locale, "results.endingEquity")}</th>
              <th scope="col">{translate(locale, "results.maximumDrawdown")}</th>
              {split && <><th scope="col">{translate(locale, "search.trainXirr")}</th><th scope="col">{translate(locale, "search.testXirr")}</th></>}
              <th scope="col">{translate(locale, "diagnostics.title")}</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((candidate) => (
              <CandidateRow key={candidate.candidateId} locale={locale} candidate={candidate}
                selectedCandidateId={selectedCandidateId} dimensions={searchResult.dimensions.map(item => item.key)} split={split}
                onSelect={onSelectCandidate} />
            ))}
          </tbody>
        </table>
      </div>
      {hiddenCount > 0 && (
        <button className="text-button search-show-all" type="button" onClick={() => setShowAll(true)}>
          {translate(locale, "search.showRemaining", { count: String(hiddenCount) })}
        </button>
      )}
    </section>
  );
}
