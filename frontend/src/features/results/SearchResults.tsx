import { useState } from "react";
import type { SearchCandidate, SearchResult } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { DiagnosticList } from "../runs/DiagnosticList";
import { formatCurrency, formatPercent } from "./format";

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

function orderedCandidates(searchResult: SearchResult): SearchCandidate[] {
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

function CandidateRow({ locale, candidate, selected, onSelect, dimensions }: { locale: Locale; candidate: SearchCandidate; selected: boolean; onSelect?(): void; dimensions: string[] }) {
  const metrics = candidate.metrics;
  const diagnostics = [
    ...(candidate.diagnostics ?? []),
    ...(metrics?.diagnostics ?? []),
  ];
  return (
    <tr className={selected ? "is-selected" : ""} onClick={metrics ? onSelect : undefined}>
      <th scope="row">
        <button type="button" className="result-select" disabled={!metrics} aria-pressed={selected}
          onClick={event => { event.stopPropagation(); onSelect?.(); }}>{candidate.sequence}</button>
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
      <td>
        {candidate.reusedCalculation && <span className="search-reused">{translate(locale, "search.reused")}</span>}
        <DiagnosticList locale={locale} diagnostics={diagnostics} />
      </td>
    </tr>
  );
}

export function SearchResults({ locale, searchResult, selectedCandidateId, onSelectCandidate, pending, errorKey }: SearchResultsProps) {
  const [showAll, setShowAll] = useState(false);
  const candidates = orderedCandidates(searchResult);
  const displayed = showAll ? candidates : candidates.slice(0, INITIAL_CANDIDATE_LIMIT);
  const hiddenCount = candidates.length - displayed.length;

  return (
    <section className="search-results" aria-labelledby="search-results-title">
      <h3 className="sr-only" id="search-results-title">
        {translate(locale, "search.title", { count: String(searchResult.totalCandidateCount) })}
      </h3>
      {pending && <p role="status">{translate(locale, "search.loadingCurve")}</p>}
      {errorKey && <p className="field-error" role="alert">{translate(locale, errorKey)}</p>}
      <div className="data-table-scroll">
        <table className="data-table search-table">
          <caption className="sr-only">{translate(locale, "search.title", { count: String(searchResult.totalCandidateCount) })}</caption>
          <thead>
            <tr>
              <th scope="col">{translate(locale, "search.sequence")}</th>
              <th scope="col">{translate(locale, "results.status")}</th>
              <th scope="col">{translate(locale, "search.parameters")}</th>
              <th scope="col">{translate(locale, "results.endingEquity")}</th>
              <th scope="col">{translate(locale, "results.maximumDrawdown")}</th>
              <th scope="col">{translate(locale, "diagnostics.title")}</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((candidate) => (
              <CandidateRow key={candidate.candidateId} locale={locale} candidate={candidate}
                selected={selectedCandidateId === candidate.candidateId} dimensions={searchResult.dimensions.map(item => item.key)}
                onSelect={() => onSelectCandidate?.(candidate.candidateId)} />
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
