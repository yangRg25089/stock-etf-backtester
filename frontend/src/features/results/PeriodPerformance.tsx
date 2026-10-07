import { ExpandedTableOverflow } from "./ExpandedTableOverflow";
import { useEffect, useId, useRef, useState } from "react";
import type { DrawdownEpisode, StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { formatExactPercent } from "./format";
import { ReturnPercent } from "./ReturnPercent";
import { MonthlyHeatmap } from "./MonthlyHeatmap";
import { TableExpandButton } from "./TableExpandButton";
import { SortableHeader } from "./SortableHeader";
import { visibleDrawdownEpisodes, type DrawdownLocation } from "./drawdownPresentation";
import { sortTableRows, type TableSort, type TableSortDirection } from "./tableSorting";

type DrawdownSortKey = "peakDate" | "bottomDate" | "drawdown" | "recoveredDate" | "durationDays" | "recoveryDays";

function DrawdownTable({ locale, episodes, busy, location }: { locale: Locale; episodes: DrawdownEpisode[]; busy: boolean; location?: DrawdownLocation | null }) {
  const [heightExpanded, setHeightExpanded] = useState(false);
  const [sort, setSort] = useState<TableSort<DrawdownSortKey> | null>(null);
  const tableId = useId();
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  const [highlighted, setHighlighted] = useState<string | null>(null);
  useEffect(() => {
    if (!location || !rows.current.has(location.peakDate)) return;
    setHighlighted(location.peakDate);
    rows.current.get(location.peakDate)?.scrollIntoView({ block: "center", behavior: "smooth" });
    const timeout = window.setTimeout(() => setHighlighted(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [location]);
  const visible = visibleDrawdownEpisodes(episodes);
  const orderedEpisodes = sortTableRows(visible, sort, (row, key) => row[key], locale);
  const sortable = (key: DrawdownSortKey, label: string, firstDirection: TableSortDirection = "ascending") =>
    <SortableHeader locale={locale} label={label} sortKey={key} sort={sort} firstDirection={firstDirection} disabled={busy} onSort={setSort} />;
  const table = <table className="data-table drawdown-episodes-table">
    <caption className="sr-only">{translate(locale, "performance.episodes")}</caption>
    <thead><tr>{sortable("peakDate", translate(locale, "performance.episode.peak"))}{sortable("bottomDate", translate(locale, "performance.episode.bottom"))}{sortable("drawdown", translate(locale, "performance.episode.depth"))}{sortable("recoveredDate", translate(locale, "performance.episode.recovered"))}{sortable("durationDays", translate(locale, "performance.episode.duration"))}{sortable("recoveryDays", translate(locale, "performance.episode.recovery"))}</tr></thead>
    <tbody>{orderedEpisodes.map(row => <tr key={row.peakDate} data-episode={row.peakDate} className={highlighted === row.peakDate ? "is-located" : undefined}
      ref={element => { if (element) rows.current.set(row.peakDate, element); else rows.current.delete(row.peakDate); }}>
      <th scope="row">{row.peakDate}</th><td>{row.bottomDate}</td><td title={formatExactPercent(row.drawdown)}><ReturnPercent value={row.drawdown} locale={locale} kind="drawdown" /></td>
      <td>{row.recoveredDate ?? translate(locale, "performance.reason.not_recovered")}</td>
      <td title={row.endDate}>{row.durationDays} {translate(locale, "unit.calendar_day")}</td>
      <td>{row.recoveryDays == null ? "—" : `${row.recoveryDays} ${translate(locale, "unit.calendar_day")}`}</td>
    </tr>)}</tbody>
  </table>;
  return <section className={`performance-group${heightExpanded ? " is-height-expanded" : ""}`}>
    <div className="performance-group-heading">
      <h4 id="performance-episodes-heading">{translate(locale, "performance.episodes")}</h4>
      <TableExpandButton locale={locale} tableName={translate(locale, "performance.episodes")} controls={tableId}
        expanded={heightExpanded} disabled={busy || visible.length === 0} onToggle={() => setHeightExpanded(value => !value)} />
    </div>
    {visible.length === 0 ? <p className="metric-empty">{translate(locale, "performance.noEpisodes")}</p> :
      <div id={tableId} className={`data-table-scroll performance-table-scroll${heightExpanded ? " is-height-expanded" : ""}`} tabIndex={0} role="region" aria-label={translate(locale, "performance.episodes")}>
        {heightExpanded ? <ExpandedTableOverflow>{table}</ExpandedTableOverflow> : table}
      </div>}
  </section>;
}

export function PeriodPerformance({ locale, result, busy = false, location }: { locale: Locale; result: StrategyRun | null; busy?: boolean; location?: DrawdownLocation | null }) {
  const analysis = result?.metrics?.analysis;
  if (!analysis) return null;
  if (analysis.annualReturns == null && analysis.monthlyReturns == null && analysis.drawdownEpisodes == null)
    return <p className="metric-empty">{translate(locale, "performance.periodsNotSaved")}</p>;
  return <div className="period-performance">
    {(analysis.monthlyReturns || analysis.annualReturns) && <MonthlyHeatmap key={result?.id} locale={locale} values={analysis.monthlyReturns ?? []} annualValues={analysis.annualReturns ?? []} busy={busy} />}
    {analysis.drawdownEpisodes != null ? <DrawdownTable locale={locale} episodes={analysis.drawdownEpisodes} busy={busy} location={location} />
      : <p className="metric-empty">{translate(locale, `performance.reason.${analysis.unavailableReasons?.drawdownEpisodes ?? "missing_nav"}`)}</p>}
  </div>;
}
