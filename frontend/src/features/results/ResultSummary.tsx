import { ExpandedTableOverflow } from "./ExpandedTableOverflow";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { savedEvaluationPhase } from "./savedConfiguration";
import { formatCurrency, formatMultiple } from "./format";
import { ReturnPercent } from "./ReturnPercent";
import { resultColor } from "./colors";
import { investedPrincipalValue, isCompletedResult, resultDisplayName } from "./model";
import { hasTaxColumn, COMPARISON_COLUMNS, DEFAULT_COMPARISON_SORT, sortedComparisons, type ComparisonSort } from "./comparisonModel";
import { TaxValue } from "./TaxValue";
import { TableExpandButton } from "./TableExpandButton";
import { SortableHeader } from "./SortableHeader";

const useRowLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface ResultComparisonProps {
  busy?: boolean;
  locale: Locale;
  strategyRuns: StrategyRun[];
  selectedResultIds?: string[];
  sort?: ComparisonSort;
  onSortChange?(sort: ComparisonSort): void;
  onSelect?(id: string): void;
}

export function ResultComparison({
  busy = false,
  locale,
  strategyRuns,
  selectedResultIds = [],
  sort = DEFAULT_COMPARISON_SORT,
  onSortChange = () => undefined,
  onSelect = () => undefined,
}: ResultComparisonProps) {
  const [heightExpanded, setHeightExpanded] = useState(false);
  const scrollId = useId();
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  const previousTops = useRef(new Map<string, number>());
  const showTax = hasTaxColumn(strategyRuns);
  const effectiveSort = !showTax && sort.key === "capitalGainsTax" ? DEFAULT_COMPARISON_SORT : sort;
  const ordered = sortedComparisons(strategyRuns, effectiveSort, locale);
  useEffect(() => { if (!showTax && sort.key === "capitalGainsTax") onSortChange(DEFAULT_COMPARISON_SORT); }, [showTax, sort.key, onSortChange]);
  useRowLayoutEffect(() => {
    const nextTops = new Map<string, number>();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const [id, element] of rows.current) {
      // Layout positions exclude an animation already running on this row.
      const top = element.offsetTop;
      const previous = previousTops.current.get(id);
      if (previous !== undefined && top !== previous && !reduceMotion) {
        element.getAnimations().forEach(animation => animation.cancel());
        element.animate([{ transform: `translateY(${previous - top}px)` }, { transform: "translateY(0)" }], { duration: 240, easing: "ease-out" });
      }
      nextTops.set(id, top);
    }
    previousTops.current = nextTops;
  }, [ordered]);
  if (strategyRuns.length === 0) {
    return <p className="metric-empty">{translate(locale, "results.noComparisons")}</p>;
  }
  const table = <table className="comparison-table">
    <caption className="sr-only">{translate(locale, "results.comparisonTitle")}</caption>
    <thead>
      <tr>
        {COMPARISON_COLUMNS.filter(column => showTax || column.key !== "capitalGainsTax").map(column => <SortableHeader key={column.key} locale={locale} label={translate(locale, column.labelKey)}
          sortKey={column.key} sort={effectiveSort} disabled={busy} className="comparison-sort"
          firstDirection={column.key === "strategy" || column.key === "maximumDrawdown" ? "ascending" : "descending"}
          onSort={onSortChange} />)}
      </tr>
    </thead>
    <tbody>
      {ordered.map((result, rankIndex) => {
        const metrics = isCompletedResult(result) ? result.metrics : null;
        const displayName = resultDisplayName(locale, result, strategyRuns);
        const color = resultColor(strategyRuns.indexOf(result));
        const isSelected = selectedResultIds.includes(result.id);
        return (
          <tr
            ref={element => { if (element) rows.current.set(result.id, element); else rows.current.delete(result.id); }}
            data-result-id={result.id}
            className={`${result.status === "running" || result.status === "loading" ? "is-running " : ""}${isSelected ? "is-selected" : ""}`.trim()}
            style={{ "--result-color": color } as CSSProperties}
            key={`${result.role}-${result.id}`}
            onClick={() => { if (!busy) onSelect(result.id); }}
          >
            <th scope="row">
              <div className="result-name-cell">
                <span className="result-rank" aria-hidden="true">{rankIndex + 1}</span>
                {["running", "loading"].includes(result.status ?? "queued") && <span className="run-button-spinner" role="status" aria-label={translate(locale, `status.${result.status}`)} />}
                {result.status === "queued" && <span className="result-waiting" role="status" aria-label={translate(locale, "status.queued")}>◷</span>}
                {result.status === "cancelled" && <span className="result-stopped" role="status" aria-label={translate(locale, "status.cancelled")}>■</span>}
                <span className="result-color-swatch" aria-hidden="true" />
                <button
                  className="result-select"
                  type="button"
                  disabled={busy}
                  aria-pressed={isSelected}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (busy) return;
                    onSelect(result.id);
                  }}
                >
                  <span>{displayName}</span>
                </button>
                {result.evaluationPeriod && <small className="comparison-period"
                  title={`${result.evaluationPeriod.startDate} → ${result.evaluationPeriod.endDate}`}>
                  {translate(locale, `search.phase.${savedEvaluationPhase(result)}`)}
                </small>}
              </div>
            </th>
            <td>{formatCurrency(investedPrincipalValue(metrics), metrics?.currency, locale)}</td>
            <td>{formatCurrency(metrics?.endingEquity, metrics?.currency, locale)}</td>
            <td>{formatCurrency(metrics?.netProfit, metrics?.currency, locale)}</td>
            <td><ReturnPercent value={metrics?.returnOnContributions} locale={locale} /></td>
            <td>{formatMultiple(metrics?.capitalMultiple, locale)}</td>
            <td><ReturnPercent value={metrics?.xirr} locale={locale} /></td>
            <td><ReturnPercent value={metrics?.maximumDrawdown} locale={locale} kind="drawdown" /></td>
            {showTax && <td><TaxValue value={metrics?.tradingCosts?.capitalGainsTax} currency={metrics?.currency} locale={locale} /></td>}
          </tr>
        );
      })}
    </tbody>
  </table>;
  return (
    <div className={`table-height-region comparison-table-region${heightExpanded ? " is-height-expanded" : ""}`}>
      <div className="table-height-controls"><h4 className="table-height-controls-title">{translate(locale, "results.tab.comparison")}</h4>
        <TableExpandButton locale={locale} tableName={translate(locale, "results.tab.comparison")}
          controls={scrollId} expanded={heightExpanded} disabled={busy}
          onToggle={() => setHeightExpanded(previous => !previous)} />
      </div>
      <div id={scrollId} className={`comparison-table-scroll${heightExpanded ? " is-height-expanded" : ""}`} tabIndex={0} role="region"
        aria-label={translate(locale, "results.comparisonTitle")}>
        {heightExpanded ? <ExpandedTableOverflow>{table}</ExpandedTableOverflow> : table}
      </div>
    </div>
  );
}
