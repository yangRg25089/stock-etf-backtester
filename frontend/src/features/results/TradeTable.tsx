import { useId, useState } from "react";
import type { StrategyStatus, Trade, UnexecutedSignal } from "../../api/generated";
import { isSuccessfulRunStatus } from "../../api/runStatus";
import { translate, type Locale } from "../../i18n/messages";
import { formatCurrency, formatQuantity } from "./format";
import { TableExpandButton } from "./TableExpandButton";

interface TradeTableProps {
  busy?: boolean;
  locale: Locale;
  status: StrategyStatus | undefined;
  trades: Trade[];
  onTradeSelect?(index: number): void;
  unexecutedSignals?: UnexecutedSignal[];
  onSignalSelect?(signal: UnexecutedSignal): void;
}

function signalLabel(locale: Locale, signalId: string | null | undefined): string {
  if (!signalId) return "—";
  const key = `trade.signal.${signalId}`;
  const label = translate(locale, key);
  return label === key ? translate(locale, "trade.signalOther") : label;
}

export function TradeTable({ locale, status, trades, busy = false, onTradeSelect, unexecutedSignals = [], onSignalSelect }: TradeTableProps) {
  const [heightExpanded, setHeightExpanded] = useState(false);
  const scrollId = useId();
  if (!isSuccessfulRunStatus(status)) {
    return <p className="metric-empty" role="status">{translate(locale, "trade.unavailable")}</p>;
  }
  return (
    <div className="trade-table-content">
      <div id={scrollId} className={`data-table-scroll trade-table-scroll${heightExpanded ? " is-height-expanded" : ""}`}
        tabIndex={0}
        role="region"
        aria-label={translate(locale, "trade.tableTitle", { count: String(trades.length) })}>
        <div className="table-height-controls">
          <TableExpandButton locale={locale} tableName={translate(locale, "results.tab.trades")}
            controls={scrollId} expanded={heightExpanded} disabled={busy || trades.length === 0}
            onToggle={() => setHeightExpanded(previous => !previous)} />
        </div>
        <table className="data-table trade-table">
          <caption className="sr-only">
            {translate(locale, "trade.tableTitle", { count: String(trades.length) })}
          </caption>
          <thead>
            <tr>
              <th scope="col">{translate(locale, "trade.date")}</th>
              <th scope="col">{translate(locale, "trade.side")}</th>
              <th scope="col">{translate(locale, "trade.reason")}</th>
              <th scope="col">{translate(locale, "trade.quantity")}</th>
              <th scope="col">{translate(locale, "trade.price")}</th>
              <th scope="col">{translate(locale, "trade.cashAmount")}</th>
              <th scope="col">{translate(locale, "trade.signal")}</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade, index) => (
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
        </table>
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
