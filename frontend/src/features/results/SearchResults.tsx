import { ExpandedTableOverflow } from "./ExpandedTableOverflow";
import { TableExpandButton } from "./TableExpandButton";
import { useId, useState } from "react";
import type { SearchCandidate, SearchResult } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { DiagnosticList } from "../runs/DiagnosticList";
import { formatCurrency } from "./format";
import { ReturnPercent } from "./ReturnPercent";
import { SearchLab } from "./SearchLab";
import { SortableHeader } from "./SortableHeader";
import { sortTableRows, type TableSort } from "./tableSorting";

const INITIAL_CANDIDATE_LIMIT = 100;
type CandidateSortKey = "sequence" | "status" | "parameters" | "endingEquity" | "maximumDrawdown" | "trainXirr" | "testXirr" | "diagnostics";

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
      <td><ReturnPercent value={metrics?.maximumDrawdown} locale={locale} kind="drawdown" /></td>
      {split && <>
        <td><ReturnPercent value={metrics?.xirr} locale={locale} /></td>
        <td><button type="button" className="search-test-select" disabled={!candidate.testResult?.metrics}
          aria-pressed={selectedCandidateId === candidate.testResult?.resultId}
          aria-label={translate(locale, "search.viewTest", { number: String(candidate.sequence) })}
          onClick={event => { event.stopPropagation(); if (candidate.testResult) onSelect?.(candidate.testResult.resultId); }}>
          <ReturnPercent value={candidate.testResult?.metrics?.xirr} locale={locale} /> <span aria-hidden="true">↗</span>
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
  const [heightExpanded, setHeightExpanded] = useState(false);
  const tableId = useId();
  const [showAll, setShowAll] = useState(false);
  const [windowIndex, setWindowIndex] = useState(0);
  const [sort, setSort] = useState<TableSort<CandidateSortKey> | null>(null);
  const window = searchResult.walkForwardWindows?.[windowIndex] ?? searchResult.walkForwardWindows?.[0];
  const slice = { dimensions: searchResult.dimensions, optimizationMode: searchResult.optimizationMode,
    candidates: window ? searchResult.candidates.filter(item => window.candidateIds.includes(item.candidateId)) : searchResult.candidates,
    rankedCandidateIds: window?.rankedCandidateIds ?? searchResult.rankedCandidateIds };
  const rankedCandidates = orderedCandidates(slice);
  const dimensions = searchResult.dimensions.map(item => item.key);
  const candidates = sortTableRows(rankedCandidates, sort, (candidate, key) => {
    if (key === "sequence") return candidate.sequence;
    if (key === "status") return translate(locale, `status.${candidate.status}`);
    if (key === "parameters") return candidateParameters(candidate, dimensions).map(([name, value]) =>
      `${translate(locale, `parameters.${name}`)} ${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ");
    if (key === "endingEquity") return candidate.metrics?.endingEquity;
    if (key === "maximumDrawdown") return candidate.metrics?.maximumDrawdown;
    if (key === "trainXirr") return candidate.metrics?.xirr;
    if (key === "testXirr") return candidate.testResult?.metrics?.xirr;
    return [...(candidate.diagnostics ?? []), ...(candidate.metrics?.diagnostics ?? []), ...(candidate.testResult?.diagnostics ?? [])]
      .map(item => item.code).join(" · ");
  }, locale);
  const displayed = showAll ? candidates : candidates.slice(0, INITIAL_CANDIDATE_LIMIT);
  const hiddenCount = candidates.length - displayed.length;
  const split = searchResult.optimizationMode === "train_test";
  const sortable = (key: CandidateSortKey, label: string, firstDirection: "ascending" | "descending" = "ascending") =>
    <SortableHeader locale={locale} label={label} sortKey={key} sort={sort} firstDirection={firstDirection} disabled={pending} onSort={setSort} />;

  const table = <table className="data-table search-table">
          <caption className="sr-only">{translate(locale, "search.title", { count: String(searchResult.totalCandidateCount) })}</caption>
          <thead>
            <tr>
              {sortable("sequence", translate(locale, "search.sequence"))}
              {sortable("status", translate(locale, "results.status"))}
              {sortable("parameters", translate(locale, "search.parameters"))}
              {sortable("endingEquity", translate(locale, "results.endingEquity"), "descending")}
              {sortable("maximumDrawdown", translate(locale, "results.maximumDrawdown"), "ascending")}
              {split && <>{sortable("trainXirr", translate(locale, "search.trainXirr"), "descending")}{sortable("testXirr", translate(locale, "search.testXirr"), "descending")}</>}
              {sortable("diagnostics", translate(locale, "diagnostics.title"))}
            </tr>
          </thead>
          <tbody>
            {displayed.map((candidate) => (
              <CandidateRow key={candidate.candidateId} locale={locale} candidate={candidate}
                selectedCandidateId={selectedCandidateId} dimensions={dimensions} split={split}
                onSelect={onSelectCandidate} />
            ))}
          </tbody>
        </table>;
  return (
    <section className="search-results">
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
      <div className={`table-height-region search-table-region${heightExpanded ? " is-height-expanded" : ""}`}>
      <div className="table-height-controls"><h4 className="table-height-controls-title">{translate(locale, "search.title", {count: String(searchResult.totalCandidateCount)})}</h4>
        <TableExpandButton locale={locale} tableName={translate(locale, "search.title", {count: String(searchResult.totalCandidateCount)})} controls={tableId} expanded={heightExpanded} disabled={pending} onToggle={() => setHeightExpanded(value => !value)} />
      </div>
      <div id={tableId} className={`data-table-scroll search-table-scroll${heightExpanded ? " is-height-expanded" : ""}`} tabIndex={0} role="region"
        aria-label={translate(locale, "search.title", { count: String(searchResult.totalCandidateCount) })}>
        {heightExpanded ? <ExpandedTableOverflow>{table}</ExpandedTableOverflow> : table}
      </div>
      </div>
      {hiddenCount > 0 && (
        <button className="text-button search-show-all" type="button" onClick={() => setShowAll(true)}>
          {translate(locale, "search.showRemaining", { count: String(hiddenCount) })}
        </button>
      )}
    </section>
  );
}
