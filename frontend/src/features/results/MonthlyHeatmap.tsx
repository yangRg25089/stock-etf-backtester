import { useState } from "react";
import type { PeriodReturn } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { formatExactPercent, formatPercent } from "./format";

export function MonthlyHeatmap({ locale, values }: { locale: Locale; values: PeriodReturn[] }) {
  const [inspected, setInspected] = useState<PeriodReturn | null>(null);
  const years = [...new Set(values.map(row => row.year))];
  const cells = new Map(values.map(row => [`${row.year}-${row.month}`, row]));
  const months = Array.from({ length: 12 }, (_, index) => index + 1);
  const label = (row: PeriodReturn) => `${row.year}-${String(row.month).padStart(2, "0")} · ${formatExactPercent(row.navReturn)}${row.unavailableReason ? ` · ${translate(locale, `performance.reason.${row.unavailableReason}`)}` : ""}`;
  return <section className="performance-group monthly-performance" aria-labelledby="performance-monthly-heading">
    <h4 id="performance-monthly-heading">{translate(locale, "performance.monthly")}</h4>
    <div className="data-table-scroll performance-table-scroll" role="region" tabIndex={0} aria-label={translate(locale, "performance.monthly")}>
      <table className="data-table heatmap-table">
        <caption className="sr-only">{translate(locale, "performance.monthly")}</caption>
        <thead><tr><th scope="col">{translate(locale, "performance.year")}</th>{months.map(month => <th scope="col" key={month}>{translate(locale, "performance.month", { month: String(month) })}</th>)}</tr></thead>
        <tbody>{years.map(year => <tr key={year}><th scope="row">{year}</th>{months.map(month => {
          const row = cells.get(`${year}-${month}`);
          if (!row) return <td key={month} className="heatmap-unobserved"><span aria-hidden="true">—</span><span className="sr-only">{translate(locale, "performance.noObservation")}</span></td>;
          const exact = formatExactPercent(row.navReturn);
          const tone = row.navReturn == null ? "missing" : exact === "0%" ? "neutral" : exact.startsWith("-") ? "negative" : "positive";
          return <td key={month}><button type="button" className={`heatmap-cell is-${tone}${inspected === row ? " is-inspected" : ""}`}
            aria-label={label(row)} title={`${label(row)} · ${row.startDate} → ${row.endDate}`}
            onMouseEnter={() => setInspected(row)} onFocus={() => setInspected(row)} onClick={() => setInspected(row)}>
            {tone === "positive" ? "+" : ""}{formatPercent(row.navReturn, locale)}
          </button></td>;
        })}</tr>)}</tbody>
      </table>
    </div>
    <p className="heatmap-detail" role="status">{inspected ? label(inspected) : translate(locale, "performance.heatmapHint")}</p>
  </section>;
}
