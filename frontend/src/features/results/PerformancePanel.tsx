import { useId } from "react";
import type { PerformanceAnalysis, StrategyRun } from "../../api/generated";
import { isSuccessfulRunStatus } from "../../api/runStatus";
import { translate, type Locale } from "../../i18n/messages";
import { formatPercent, formatPlainNumber } from "./format";
import { ReturnPercent } from "./ReturnPercent";
import { durationEpisode } from "./drawdownPresentation";

type AnalysisKey = keyof Pick<PerformanceAnalysis, "annualizedReturn" | "annualizedVolatility" | "sharpeRatio" | "sortinoRatio" | "calmarRatio"
  | "maximumDrawdownDuration" | "recoveryDuration" | "buyCount" | "sellCount" | "turnover" | "averageCashRatio">;
const GROUPS: { name: string; fields: AnalysisKey[] }[] = [
  { name: "risk", fields: ["annualizedReturn", "annualizedVolatility", "sharpeRatio", "sortinoRatio", "calmarRatio"] },
  { name: "drawdown", fields: ["maximumDrawdownDuration", "recoveryDuration"] },
  { name: "trading", fields: ["buyCount", "sellCount", "turnover", "averageCashRatio"] },
];
const PERCENT_FIELDS = new Set<AnalysisKey>(["annualizedReturn", "annualizedVolatility", "turnover", "averageCashRatio"]);

export function PerformancePanel({ locale, result, onEpisodeSelect }: { locale: Locale; result: StrategyRun | null; onEpisodeSelect?(peakDate: string): void }) {
  const descriptionId = useId();
  if (!isSuccessfulRunStatus(result?.status)) return <p className="metric-empty">{translate(locale, "performance.unavailable")}</p>;
  const analysis = result?.metrics?.analysis;
  if (!analysis) return <p className="metric-empty">{translate(locale, "performance.notSaved")}</p>;
  const basisHelpId = `${descriptionId}-basis`;
  return <section className="performance-panel">
    <p className="performance-basis" tabIndex={0} aria-describedby={basisHelpId}>
      <span className="performance-help-tooltip" aria-hidden="true">{translate(locale, "performance.help.basis")}</span>
      {translate(locale, "performance.basis", { rate: formatPercent(analysis.riskFreeAnnualRate, locale),
      days: String(analysis.tradingDaysPerYear ?? "—") })}</p>
    <span className="sr-only" id={basisHelpId}>{translate(locale, "performance.help.basis")}</span>
    {GROUPS.map(group => <section className="performance-group" key={group.name}>
      <h4>{translate(locale, `performance.group.${group.name}`)}</h4>
      <dl className="performance-grid">{group.fields.map(key => {
        const value = analysis[key];
        const formatted = PERCENT_FIELDS.has(key) ? formatPercent(value, locale) : formatPlainNumber(value, locale);
        const duration = key === "maximumDrawdownDuration" || key === "recoveryDuration";
        const episode = duration ? durationEpisode(analysis, key) : undefined;
        const reason = analysis.unavailableReasons?.[key];
        const help = translate(locale, `performance.help.${key}`);
        const helpId = `${descriptionId}-${key}`;
        return <div className="performance-stat" key={key} tabIndex={0} aria-describedby={helpId}>
          <span className="performance-help-tooltip" aria-hidden="true">{help}</span>
          <dt>{translate(locale, `performance.${key}`)}</dt>
          <dd>{episode && onEpisodeSelect && value != null ? <button type="button" className="performance-episode-link"
            onClick={() => onEpisodeSelect(episode.peakDate)}>{formatted}<small> {translate(locale, "unit.calendar_day")}</small><span aria-hidden="true">↗</span></button>
            : <>{key === "annualizedReturn" ? <ReturnPercent value={value} locale={locale} /> : formatted}{duration && value != null && <small> {translate(locale, "unit.calendar_day")}</small>}</>}
            {value == null && reason && <small className="performance-reason">{translate(locale, `performance.reason.${reason}`)}</small>}
          </dd>
        </div>;
      })}</dl>
      {group.fields.map(key => <span className="sr-only" id={`${descriptionId}-${key}`} key={key}>{translate(locale, `performance.help.${key}`)}</span>)}
    </section>)}
  </section>;
}
