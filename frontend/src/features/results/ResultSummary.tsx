import type { StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { formatCurrency, formatMultiple, formatPercent } from "./format";

interface ResultComparisonProps {
  locale: Locale;
  strategyRuns: StrategyRun[];
  focusedResultId: string | null;
  onFocus(id: string): void;
}

export function ResultComparison({
  locale,
  strategyRuns,
  focusedResultId,
  onFocus,
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
            <th scope="col">{translate(locale, "results.role")}</th>
            <th scope="col">{translate(locale, "results.status")}</th>
            <th scope="col">{translate(locale, "results.totalContributed")}</th>
            <th scope="col">{translate(locale, "results.endingEquity")}</th>
            <th scope="col">{translate(locale, "results.netProfit")}</th>
            <th scope="col">{translate(locale, "results.returnOnContributions")}</th>
            <th scope="col">{translate(locale, "results.capitalMultiple")}</th>
            <th scope="col">{translate(locale, "results.xirr")}</th>
            <th scope="col">{translate(locale, "results.maximumDrawdown")}</th>
            <th scope="col">{translate(locale, "results.relativeToDca")}</th>
          </tr>
        </thead>
        <tbody>
          {strategyRuns.map((result) => {
            const metrics = ["completed", "completed_with_warning"].includes(result.status ?? "queued") ? result.metrics : null;
            const peers = strategyRuns.filter((item) => item.presetId === result.presetId && item.role === result.role);
            const name = translate(locale, `presets.${result.presetId}.name`);
            const displayName = peers.length > 1 ? `${name} · ${peers.findIndex((item) => item.id === result.id) + 1}` : name;
            return (
              <tr className={focusedResultId === result.id ? "is-focused" : ""} key={`${result.role}-${result.id}`} onClick={() => onFocus(result.id)}>
                <th scope="row">
                  <button
                    className="result-select"
                    type="button"
                    aria-pressed={focusedResultId === result.id}
                  >
                    <span>{displayName}</span>
                  </button>
                </th>
                <td>{translate(locale, `results.role.${result.role}`)}</td>
                <td><span className="status-tag">{translate(locale, `status.${result.status ?? "queued"}`)}</span></td>
                <td>{formatCurrency(metrics?.totalContributed, metrics?.currency, locale)}</td>
                <td>{formatCurrency(metrics?.endingEquity, metrics?.currency, locale)}</td>
                <td>{formatCurrency(metrics?.netProfit, metrics?.currency, locale)}</td>
                <td>{formatPercent(metrics?.returnOnContributions, locale)}</td>
                <td>{formatMultiple(metrics?.capitalMultiple, locale)}</td>
                <td>{formatPercent(metrics?.xirr, locale)}</td>
                <td>{formatPercent(metrics?.maximumDrawdown, locale)}</td>
                <td>{formatCurrency(metrics?.relativeToDca, metrics?.currency, locale)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
