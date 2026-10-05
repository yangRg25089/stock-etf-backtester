import { useId, useState } from "react";
import type { StrategyStatus, Trade, UnexecutedSignal } from "../../api/generated";
import { isSuccessfulRunStatus } from "../../api/runStatus";
import { translate, type Locale } from "../../i18n/messages";
import { formatCurrency, formatQuantity } from "./format";
import { TableExpandButton } from "./TableExpandButton";
import { SortableHeader } from "./SortableHeader";
import { sortTableRows, type TableSort, type TableSortDirection } from "./tableSorting";
import { signalLabel } from "./tradeSignalLabel";

type TradeSortKey = "date" | "side" | "reason" | "quantity" | "price" | "cashAmount" | "signal";

interface TradeTableProps {
  busy?: boolean;
  locale: Locale;
  status: StrategyStatus | undefined;
  trades: Trade[];
  onTradeSelect?(index: number): void;
  unexecutedSignals?: UnexecutedSignal[];
  onSignalSelect?(signal: UnexecutedSignal): void;
}

export function TradeTable({ locale, status, trades, busy = false, onTradeSelect, unexecutedSignals = [], onSignalSelect }: TradeTableProps) {
  const [heightExpanded, setHeightExpanded] = useState(false);
  const [sort, setSort] = useState<TableSort<TradeSortKey> | null>(null);
  const scrollId = useId();
  if (!isSuccessfulRunStatus(status)) {
    return <p className="metric-empty" role="status">{translate(locale, "trade.unavailable")}</p>;
  }
  const indexedTrades = trades.map((trade, index) => ({ trade, index }));
  const orderedTrades = sortTableRows(indexedTrades, sort, ({ trade }, key) => {
    if (key === "side") return translate(locale, `trade.side.${trade.side}`);
    if (key === "reason") return translate(locale, `trade.reason.${trade.reason}`);
    if (key === "signal") return trade.signalId ? signalLabel(locale, trade.signalId) : null;
    return trade[key];
  }, locale);
  const sortable = (key: TradeSortKey, label: string, firstDirection: TableSortDirection = "ascending") =>
    <SortableHeader locale={locale} label={label} sortKey={key} sort={sort} firstDirection={firstDirection} disabled={busy}
      onSort={setSort} />;
  const table = <table className="data-table trade-table">
    <caption className="sr-only">
      {translate(locale, "trade.tableTitle", { count: String(trades.length) })}
    </caption>
    <thead>
      <tr>
        {sortable("date", translate(locale, "trade.date"))}
        {sortable("side", translate(locale, "trade.side"))}
        {sortable("reason", translate(locale, "trade.reason"))}
        {sortable("quantity", translate(locale, "trade.quantity"))}
        {sortable("price", translate(locale, "trade.price"))}
        {sortable("cashAmount", translate(locale, "trade.cashAmount"))}
        {sortable("signal", translate(locale, "trade.signal"))}
      </tr>
    </thead>
    <tbody>
      {orderedTrades.map(({ trade, index }) => (
        <tr key={`${trade.date}-${trade.side}-${index}`} className={onTradeSelect ? "is-inspectable" : undefined}
          onClick={() => { if (!busy) onTradeSelect?.(index); }}>
          <td>{onTradeSelect ? <button className="table-cell-action" type="button" disabled={busy}
            aria-label={translate(locale, "trade.explain.open", { date: trade.date, side: translate(locale, `trade.side.${trade.side}`) })}
            onClick={event => { event.stopPropagation(); onTradeSelect(index); }}>{trade.date}</button> : trade.date}</td>
          <td>{translate(locale, `trade.side.${trade.side}`)}</td>
          <td>{translate(locale, `trade.reason.${trade.reason}`)}</td>
          <td>{formatQuantity(trade.quantity, locale)}</td>
          <td>{formatCurrency(trade.price, trade.currency, locale)}</td>
          <td>{formatCurrency(trade.cashAmount, trade.currency, locale)}</td>
          <td>{signalLabel(locale, trade.signalId)}</td>
        </tr>
      ))}
    </tbody>
  </table>;
  return (
    <div className="trade-table-content">
      <div className={`table-height-region trade-table-region${heightExpanded ? " is-height-expanded" : ""}`}>
        <div className="table-height-controls">
          {heightExpanded && <strong className="table-height-controls-title">{translate(locale, "results.tab.trades")}</strong>}
          <TableExpandButton locale={locale} tableName={translate(locale, "results.tab.trades")}
            controls={scrollId} expanded={heightExpanded} disabled={busy || trades.length === 0}
            onToggle={() => setHeightExpanded(previous => !previous)} />
        </div>
        <div id={scrollId} className={`data-table-scroll trade-table-scroll${heightExpanded ? " is-height-expanded" : ""}`}
        tabIndex={0}
        role="region"
        aria-label={translate(locale, "trade.tableTitle", { count: String(trades.length) })}>
          {heightExpanded ? <div className="table-expanded-overflow">{table}</div> : table}
        </div>
      </div>
      {trades.length === 0 && (
        <p className="trade-empty" role="status">{translate(locale, "trade.none")}</p>
      )}
      {unexecutedSignals.length > 0 && <details className="unexecuted-signals">
        <summary>{translate(locale, "trade.explain.unexecutedCount", { count: String(unexecutedSignals.length) })}</summary>
        {unexecutedSignals.map(signal => <button key={`${signal.signalDate}-${signal.signalId}`} type="button" className="table-cell-action" disabled={busy || !onSignalSelect}
          onClick={() => onSignalSelect?.(signal)}>{signal.signalDate} · {signalLabel(locale, signal.signalId)} <span aria-hidden="true">›</span></button>)}
      </details>}
    </div>
  );
}
