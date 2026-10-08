import { ExpandedTableOverflow } from "./ExpandedTableOverflow";
import { useId, useState } from "react";
import type { PeriodReturn } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { formatExactPercent, formatPercent } from "./format";
import { TableExpandButton } from "./TableExpandButton";
import { SortableHeader } from "./SortableHeader";
import { sortTableRows, type TableSort, type TableSortDirection } from "./tableSorting";
import { ReturnPercent } from "./ReturnPercent";
import { heatmapLevel } from "./heatmapLevel";
import { returnTone } from "./returnTone";

type MonthlySortKey = "year" | "annual" | `month-${number}`;

export function MonthlyHeatmap({ locale, values, annualValues = [], busy = false }: { locale: Locale; values: PeriodReturn[]; annualValues?: PeriodReturn[]; busy?: boolean }) {
  const [inspected, setInspected] = useState<PeriodReturn | null>(null);
  const [heightExpanded, setHeightExpanded] = useState(false);
  const [sort, setSort] = useState<TableSort<MonthlySortKey> | null>(null);
  const tableId = useId();
  const years = [...new Set([...values, ...annualValues].map(row => row.year))];
  const cells = new Map(values.map(row => [`${row.year}-${row.month}`, row]));
  const annualCells = new Map(annualValues.map(row => [row.year, row]));
  const months = Array.from({ length: 12 }, (_, index) => index + 1);
  const orderedYears = sortTableRows(years.map(year => ({ year })), sort, (row, key) => key === "year" ? row.year
    : key === "annual" ? annualCells.get(row.year)?.navReturn : cells.get(`${row.year}-${Number(key.slice("month-".length))}`)?.navReturn, locale);
  const sortable = (key: MonthlySortKey, label: string, firstDirection: TableSortDirection = "ascending") =>
    <SortableHeader locale={locale} label={label} sortKey={key} sort={sort} firstDirection={firstDirection} disabled={busy} onSort={setSort} />;
  const label = (row: PeriodReturn, percent = formatPercent(row.navReturn, locale)) => `${row.year}${row.month == null ? ` · ${translate(locale, "performance.annual")}` : `-${String(row.month).padStart(2, "0")}`} · ${percent}${row.unavailableReason ? ` · ${translate(locale, `performance.reason.${row.unavailableReason}`)}` : ""}`;
  const cell = (row: PeriodReturn | undefined, key: string, annual = false) => {
    if (!row) return <td key={key} className={`heatmap-unobserved${annual ? " heatmap-annual" : ""}`}><span aria-hidden="true">—</span><span className="sr-only">{translate(locale, "performance.noObservation")}</span></td>;
    const tone = returnTone(row.navReturn);
    const level = heatmapLevel(row.navReturn, annual);
    const colorLevel = tone === "positive" || tone === "negative" ? Math.max(1, level) : 0;
    return <td key={key} className={annual ? "heatmap-annual" : undefined}><button type="button"
      className={`heatmap-cell is-${tone}${colorLevel ? ` is-level-${colorLevel}` : ""}${inspected === row ? " is-inspected" : ""}`}
      aria-label={label(row)} title={`${label(row, formatExactPercent(row.navReturn))} · ${row.startDate} → ${row.endDate}`}
      onMouseEnter={() => setInspected(row)} onFocus={() => setInspected(row)} onClick={() => setInspected(row)}>
      {tone === "positive" ? "+" : ""}{formatPercent(row.navReturn, locale)}
    </button></td>;
  };
  const table = <table className="data-table heatmap-table">
    <caption className="sr-only">{translate(locale, "performance.monthly")}</caption>
    <thead><tr>{sortable("year", translate(locale, "performance.year"))}{months.map(month => <SortableHeader key={month} locale={locale}
      label={translate(locale, "performance.month", { month: String(month) })} sortKey={`month-${month}`} sort={sort}
      firstDirection="descending" disabled={busy} onSort={setSort} />)}{sortable("annual", translate(locale, "performance.annual"), "descending")}</tr></thead>
    <tbody>{orderedYears.map(({ year }) => <tr key={year}><th scope="row">{year}</th>{months.map(month => cell(cells.get(`${year}-${month}`), `month-${month}`))}{cell(annualCells.get(year), "annual", true)}</tr>)}</tbody>
  </table>;
  return <section className={`performance-group monthly-performance${heightExpanded ? " is-height-expanded" : ""}`}>
    <div className="performance-group-heading">
      <h4 id="performance-monthly-heading">{translate(locale, "performance.monthly")}</h4>
      <TableExpandButton locale={locale} tableName={translate(locale, "performance.monthly")} controls={tableId}
        expanded={heightExpanded} disabled={busy} onToggle={() => setHeightExpanded(value => !value)} />
    </div>
    <div id={tableId} className={`data-table-scroll performance-table-scroll${heightExpanded ? " is-height-expanded" : ""}`} role="region" tabIndex={0} aria-label={translate(locale, "performance.monthly")}>
      {heightExpanded ? <ExpandedTableOverflow>{table}</ExpandedTableOverflow> : table}
    </div>
    <p className="heatmap-detail" role="status">{inspected ? <>
      {inspected.year}{inspected.month == null ? ` · ${translate(locale, "performance.annual")}` : `-${String(inspected.month).padStart(2, "0")}`} · <ReturnPercent value={inspected.navReturn} locale={locale} />
      {inspected.unavailableReason && ` · ${translate(locale, `performance.reason.${inspected.unavailableReason}`)}`}
    </> : translate(locale, "performance.heatmapHint")}</p>
  </section>;
}
