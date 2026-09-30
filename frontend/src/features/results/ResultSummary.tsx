import type { MetricSummary, StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { formatCurrency, formatMultiple, formatPercent } from "./format";

interface MetricGridProps {
  locale: Locale;
  metrics: MetricSummary | null | undefined;
  variant?: "core" | "full";
}

interface ResultComparisonProps {
  locale: Locale;
  strategyRuns: StrategyRun[];
  focusedResultId: string | null;
  onFocus(id: string): void;
}

export function MetricGrid({ locale, metrics, variant = "full" }: MetricGridProps) {
  if (!metrics) {
    return <p className="metric-empty">{translate(locale, "results.metricsUnavailable")}</p>;
  }
  const cards = [
    {
      key: "totalContributed",
      label: "results.totalContributed",
      value: formatCurrency(metrics.totalContributed, metrics.currency, locale),
    },
    {
      key: "endingEquity",
      label: "results.endingEquity",
      value: formatCurrency(metrics.endingEquity, metrics.currency, locale),
    },
    {
      key: "netProfit",
      label: "results.netProfit",
      value: formatCurrency(metrics.netProfit, metrics.currency, locale),
    },
    {
      key: "returnOnContributions",
      label: "results.returnOnContributions",
      value: formatPercent(metrics.returnOnContributions, locale),
    },
    {
      key: "capitalMultiple",
      label: "results.capitalMultiple",
      value: formatMultiple(metrics.capitalMultiple, locale),
    },
    {
      key: "xirr",
      label: "results.xirr",
      value: formatPercent(metrics.xirr, locale),
    },
    {
      key: "maximumDrawdown",
      label: "results.maximumDrawdown",
      value: formatPercent(metrics.maximumDrawdown, locale),
    },
    {
      key: "relativeToDca",
      label: "results.relativeToDca",
      value: formatCurrency(metrics.relativeToDca, metrics.currency, locale),
    },
  ];
  const visibleCards = variant === "core"
    ? cards.filter((card) => ["endingEquity", "returnOnContributions", "xirr", "maximumDrawdown"].includes(card.key))
    : cards;
  return (
    <dl className={`metric-grid${variant === "core" ? " metric-grid-core" : ""}`} aria-label={translate(locale, "results.metricsTitle")}>
      {visibleCards.map((card) => (
        <div className="metric-card" key={card.key}>
          <dt>{translate(locale, card.label)}</dt>
          <dd>{card.value}</dd>
          {card.key === "xirr" && metrics.xirr == null && (
            <small>{translate(locale, "results.metricUnavailable")}</small>
          )}
        </div>
      ))}
    </dl>
  );
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
            <th scope="col">{translate(locale, "results.returnOnContributions")}</th>
            <th scope="col">{translate(locale, "results.capitalMultiple")}</th>
            <th scope="col">{translate(locale, "results.xirr")}</th>
            <th scope="col">{translate(locale, "results.maximumDrawdown")}</th>
          </tr>
        </thead>
        <tbody>
          {strategyRuns.map((result) => {
            const metrics = result.metrics;
            return (
              <tr className={focusedResultId === result.id ? "is-focused" : ""} key={`${result.role}-${result.id}`}>
                <th scope="row">
                  <button
                    className="result-select"
                    type="button"
                    aria-pressed={focusedResultId === result.id}
                    onClick={() => onFocus(result.id)}
                  >
                    <span>{translate(locale, `presets.${result.presetId}.name`)}</span>
                    <small>{result.id}</small>
                  </button>
                </th>
                <td>{translate(locale, `results.role.${result.role}`)}</td>
                <td><span className="status-tag">{translate(locale, `status.${result.status ?? "queued"}`)}</span></td>
                <td>{formatCurrency(metrics?.totalContributed, metrics?.currency, locale)}</td>
                <td>{formatCurrency(metrics?.endingEquity, metrics?.currency, locale)}</td>
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
