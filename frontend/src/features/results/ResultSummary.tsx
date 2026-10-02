import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { formatCurrency, formatMultiple, formatPercent } from "./format";
import { resultColor } from "./colors";
import { investedPrincipalValue, isCompletedResult, resultDisplayName } from "./model";
import { COMPARISON_COLUMNS, DEFAULT_COMPARISON_SORT, sortedComparisons, type ComparisonSort, type ComparisonSortKey } from "./comparisonModel";

const useRowLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface ResultComparisonProps {
  busy?: boolean;
  locale: Locale;
  strategyRuns: StrategyRun[];
  selectedResultIds?: string[];
  onFocus(id: string): void;
  onToggleSelection?(id: string): void;
}

export function ResultComparison({
  busy = false,
  locale,
  strategyRuns,
  selectedResultIds = [],
  onFocus,
  onToggleSelection = () => undefined,
}: ResultComparisonProps) {
  const [sort, setSort] = useState<ComparisonSort>(DEFAULT_COMPARISON_SORT);
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  const previousTops = useRef(new Map<string, number>());
  const ordered = sortedComparisons(strategyRuns, sort, locale);
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
  const changeSort = (key: ComparisonSortKey) => {
    if (busy) return;
    setSort(current => ({ key, direction: current.key === key
      ? current.direction === "ascending" ? "descending" : "ascending"
      : key === "strategy" || key === "maximumDrawdown" ? "ascending" : "descending" }));
  };
  if (strategyRuns.length === 0) {
    return <p className="metric-empty">{translate(locale, "results.noComparisons")}</p>;
  }
  return (
    <div className="comparison-table-scroll" tabIndex={0} role="region"
      aria-label={translate(locale, "results.comparisonTitle")}>
      <table className="comparison-table">
        <caption className="sr-only">{translate(locale, "results.comparisonTitle")}</caption>
        <thead>
          <tr>
            {COMPARISON_COLUMNS.map(column => <th scope="col" key={column.key} aria-sort={sort.key === column.key ? sort.direction : undefined}>
              <button type="button" className={`comparison-sort${sort.key === column.key ? " is-sorted" : ""}`}
                disabled={busy} onClick={() => changeSort(column.key)}>
                {translate(locale, column.labelKey)}<span aria-hidden="true">{sort.key === column.key ? sort.direction === "ascending" ? "↑" : "↓" : "↕"}</span>
              </button>
            </th>)}
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
                className={`${result.status === "running" || result.status === "loading" ? "is-running " : ""}${isSelected ? "is-selected" : ""}`}
                style={{ "--result-color": color } as CSSProperties}
                key={`${result.role}-${result.id}`}
                onClick={() => { if (!busy) { onFocus(result.id); onToggleSelection(result.id); } }}
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
                        onFocus(result.id);
                        onToggleSelection(result.id);
                      }}
                    >
                      <span>{displayName}</span>
                    </button>
                  </div>
                </th>
                <td>{formatCurrency(investedPrincipalValue(metrics), metrics?.currency, locale)}</td>
                <td>{formatCurrency(metrics?.totalContributed, metrics?.currency, locale)}</td>
                <td>{formatCurrency(metrics?.endingEquity, metrics?.currency, locale)}</td>
                <td>{formatCurrency(metrics?.netProfit, metrics?.currency, locale)}</td>
                <td>{formatPercent(metrics?.returnOnContributions, locale)}</td>
                <td>{formatMultiple(metrics?.capitalMultiple, locale)}</td>
                <td>{formatPercent(metrics?.xirr, locale)}</td>
                <td>{formatPercent(metrics?.maximumDrawdown, locale)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
