import type { DrawdownEpisode, PeriodReturn, StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { formatExactPercent, formatPercent } from "./format";
import { MonthlyHeatmap } from "./MonthlyHeatmap";

function AnnualReturns({ locale, values, benchmark }: { locale: Locale; values: PeriodReturn[]; benchmark?: StrategyRun | null }) {
  const dca = new Map((benchmark?.metrics?.analysis?.annualReturns ?? []).map(row => [row.year, row]));
  return <section className="performance-group" aria-labelledby="performance-annual-heading">
    <h4 id="performance-annual-heading">{translate(locale, "performance.annual")}</h4>
    <p className="performance-period-basis">{translate(locale, "performance.periodBasis")}</p>
    <div className="data-table-scroll performance-table-scroll" tabIndex={0} role="region" aria-label={translate(locale, "performance.annual")}>
      <table className="data-table annual-performance-table">
        <caption className="sr-only">{translate(locale, "performance.annual")}</caption>
        <thead><tr><th scope="col">{translate(locale, "performance.year")}</th><th scope="col">{translate(locale, "performance.strategy")}</th><th scope="col">{translate(locale, "performance.price")}</th><th scope="col">{translate(locale, "presets.monthly_dca.name")}</th></tr></thead>
        <tbody>{values.map(row => <tr key={row.year}>
          <th scope="row" title={`${row.startDate} → ${row.endDate}`}>{row.year}</th>
          <td title={row.unavailableReason ? translate(locale, `performance.reason.${row.unavailableReason}`) : formatExactPercent(row.navReturn)}>{formatPercent(row.navReturn, locale)}</td>
          <td title={formatExactPercent(row.priceReturn)}>{formatPercent(row.priceReturn, locale)}</td>
          <td title={formatExactPercent(dca.get(row.year)?.navReturn)}>{formatPercent(dca.get(row.year)?.navReturn, locale)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

function DrawdownTable({ locale, episodes }: { locale: Locale; episodes: DrawdownEpisode[] }) {
  return <section className="performance-group" aria-labelledby="performance-episodes-heading">
    <h4 id="performance-episodes-heading">{translate(locale, "performance.episodes")}</h4>
    {episodes.length === 0 ? <p className="metric-empty">{translate(locale, "performance.noEpisodes")}</p> :
      <div className="data-table-scroll performance-table-scroll" tabIndex={0} role="region" aria-label={translate(locale, "performance.episodes")}>
        <table className="data-table drawdown-episodes-table">
          <caption className="sr-only">{translate(locale, "performance.episodes")}</caption>
          <thead><tr>{["peak", "bottom", "depth", "recovered", "duration", "recovery"].map(key => <th key={key} scope="col">{translate(locale, `performance.episode.${key}`)}</th>)}</tr></thead>
          <tbody>{episodes.map(row => <tr key={row.peakDate}>
            <th scope="row">{row.peakDate}</th><td>{row.bottomDate}</td><td title={formatExactPercent(row.drawdown)}>{formatPercent(row.drawdown, locale)}</td>
            <td>{row.recoveredDate ?? translate(locale, "performance.reason.not_recovered")}</td>
            <td title={row.endDate}>{row.durationDays} {translate(locale, "unit.calendar_day")}</td>
            <td>{row.recoveryDays == null ? "—" : `${row.recoveryDays} ${translate(locale, "unit.calendar_day")}`}</td>
          </tr>)}</tbody>
        </table>
      </div>}
  </section>;
}

export function PeriodPerformance({ locale, result, benchmark }: { locale: Locale; result: StrategyRun | null; benchmark?: StrategyRun | null }) {
  const analysis = result?.metrics?.analysis;
  if (!analysis) return null;
  if (analysis.annualReturns == null && analysis.monthlyReturns == null && analysis.drawdownEpisodes == null)
    return <p className="metric-empty">{translate(locale, "performance.periodsNotSaved")}</p>;
  return <div className="period-performance">
    {analysis.annualReturns && <AnnualReturns locale={locale} values={analysis.annualReturns} benchmark={benchmark} />}
    {analysis.monthlyReturns && <MonthlyHeatmap key={result?.id} locale={locale} values={analysis.monthlyReturns} />}
    {analysis.drawdownEpisodes != null ? <DrawdownTable locale={locale} episodes={analysis.drawdownEpisodes} />
      : <p className="metric-empty">{translate(locale, `performance.reason.${analysis.unavailableReasons?.drawdownEpisodes ?? "missing_nav"}`)}</p>}
  </div>;
}
