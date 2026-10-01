import type { CSSProperties } from "react";
import type { StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { formatCurrency, formatMultiple, formatPercent } from "./format";
import { resultColor } from "./colors";
import { isCompletedResult, resultDisplayName } from "./model";

interface ResultComparisonProps {
  locale: Locale;
  strategyRuns: StrategyRun[];
  focusedResultId: string | null;
  selectedResultIds?: string[];
  onFocus(id: string): void;
  onToggleSelection?(id: string): void;
}

export function ResultComparison({
  locale,
  strategyRuns,
  focusedResultId,
  selectedResultIds = [],
  onFocus,
  onToggleSelection = () => undefined,
}: ResultComparisonProps) {
  if (strategyRuns.length === 0) {
    return <p className="metric-empty">{translate(locale, "results.noComparisons")}</p>;
  }
  return (
    <div className="comparison-table-scroll">
      <table className="comparison-table">
        <caption className="sr-only">{translate(locale, "results.comparisonTitle")}</caption>
        <thead>
          <tr>
            <th scope="col">{translate(locale, "results.strategy")}</th>
            <th scope="col">{translate(locale, "results.actualInvested")}</th>
            <th scope="col">{translate(locale, "results.totalContributed")}</th>
            <th scope="col">{translate(locale, "results.endingEquity")}</th>
            <th scope="col">{translate(locale, "results.netProfit")}</th>
            <th scope="col">{translate(locale, "results.returnOnContributions")}</th>
            <th scope="col">{translate(locale, "results.capitalMultiple")}</th>
            <th scope="col">{translate(locale, "results.xirr")}</th>
            <th scope="col">{translate(locale, "results.maximumDrawdown")}</th>
          </tr>
        </thead>
        <tbody>
          {strategyRuns.map((result, resultIndex) => {
            const metrics = isCompletedResult(result) ? result.metrics : null;
            const displayName = resultDisplayName(locale, result, strategyRuns);
            const color = resultColor(resultIndex);
            const isSelected = selectedResultIds.includes(result.id);
            return (
              <tr
                className={`${result.status === "running" || result.status === "loading" ? "is-running " : ""}${focusedResultId === result.id ? "is-focused " : ""}${isSelected ? "is-selected" : ""}`}
                style={{ "--result-color": color } as CSSProperties}
                key={`${result.role}-${result.id}`}
                onClick={() => { onFocus(result.id); onToggleSelection(result.id); }}
              >
                <th scope="row">
                  <div className="result-name-cell">
                    {["running", "loading"].includes(result.status ?? "queued") && <span className="run-button-spinner" role="status" aria-label={translate(locale, `status.${result.status}`)} />}
                    {result.status === "queued" && <span className="result-waiting" role="status" aria-label={translate(locale, "status.queued")}>◷</span>}
                    {result.status === "cancelled" && <span className="result-stopped" role="status" aria-label={translate(locale, "status.cancelled")}>■</span>}
                    <span className="result-color-swatch" aria-hidden="true" />
                    <button
                      className="result-select"
                      type="button"
                      aria-pressed={isSelected}
                      onClick={(event) => {
                        event.stopPropagation();
                        onFocus(result.id);
                        onToggleSelection(result.id);
                      }}
                    >
                      <span>{displayName}</span>
                    </button>
                  </div>
                </th>
                <td>{formatCurrency(metrics?.actualInvested, metrics?.currency, locale)}</td>
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
