import { useId } from "react";
import type { PerformanceAnalysis, StrategyRun } from "../../api/generated";
import { isSuccessfulRunStatus } from "../../api/runStatus";
import { translate, type Locale } from "../../i18n/messages";
import { formatPercent, formatPlainNumber } from "./format";

type AnalysisKey = keyof Pick<PerformanceAnalysis, "annualizedReturn" | "annualizedVolatility" | "sharpeRatio" | "sortinoRatio" | "calmarRatio"
  | "maximumDrawdownDuration" | "recoveryDuration" | "buyCount" | "sellCount" | "turnover" | "averageCashRatio">;
const GROUPS: { name: string; fields: AnalysisKey[] }[] = [
  { name: "risk", fields: ["annualizedReturn", "annualizedVolatility", "sharpeRatio", "sortinoRatio", "calmarRatio"] },
  { name: "drawdown", fields: ["maximumDrawdownDuration", "recoveryDuration"] },
  { name: "trading", fields: ["buyCount", "sellCount", "turnover", "averageCashRatio"] },
];
const PERCENT_FIELDS = new Set<AnalysisKey>(["annualizedReturn", "annualizedVolatility", "turnover", "averageCashRatio"]);

export function PerformancePanel({ locale, result }: { locale: Locale; result: StrategyRun | null }) {
  const descriptionId = useId();
  if (!isSuccessfulRunStatus(result?.status)) return <p className="metric-empty">{translate(locale, "performance.unavailable")}</p>;
  const analysis = result?.metrics?.analysis;
  if (!analysis) return <p className="metric-empty">{translate(locale, "performance.notSaved")}</p>;
  return <section className="performance-panel">
    <p className="performance-basis" title={translate(locale, "performance.help.basis")}>{translate(locale, "performance.basis", { rate: formatPercent(analysis.riskFreeAnnualRate, locale),
      days: String(analysis.tradingDaysPerYear ?? "—") })}</p>
    {GROUPS.map(group => <section className="performance-group" key={group.name}>
      <h4>{translate(locale, `performance.group.${group.name}`)}</h4>
      <dl className="performance-grid">{group.fields.map(key => {
        const value = analysis[key];
        const formatted = PERCENT_FIELDS.has(key) ? formatPercent(value, locale) : formatPlainNumber(value, locale);
        const duration = key === "maximumDrawdownDuration" || key === "recoveryDuration";
        const reason = analysis.unavailableReasons?.[key];
        const help = translate(locale, `performance.help.${key}`);
        const helpId = `${descriptionId}-${key}`;
        return <div className="performance-stat" key={key} title={help} tabIndex={0} aria-describedby={helpId}>
          <dt>{translate(locale, `performance.${key}`)}</dt>
          <dd>{formatted}{duration && value != null && <small> {translate(locale, "unit.calendar_day")}</small>}
            {value == null && reason && <small className="performance-reason">{translate(locale, `performance.reason.${reason}`)}</small>}
          </dd>
        </div>;
      })}</dl>
      {group.fields.map(key => <span className="sr-only" id={`${descriptionId}-${key}`} key={key}>{translate(locale, `performance.help.${key}`)}</span>)}
    </section>)}
  </section>;
}
