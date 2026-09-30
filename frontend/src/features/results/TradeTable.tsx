import type { StrategyStatus, Trade } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { formatCurrency, formatQuantity } from "./format";

interface TradeTableProps {
  locale: Locale;
  status: StrategyStatus | undefined;
  trades: Trade[];
}

function tradeStatusIsComplete(status: StrategyStatus | undefined): boolean {
  return status === "completed" || status === "completed_with_warning";
}

function signalLabel(locale: Locale, signalId: string | null | undefined): string {
  if (!signalId) return "—";
  const key = `trade.signal.${signalId}`;
  const label = translate(locale, key);
  return label === key ? translate(locale, "trade.signalOther") : label;
}

export function TradeTable({ locale, status, trades }: TradeTableProps) {
  if (!tradeStatusIsComplete(status)) {
    return <p className="metric-empty" role="status">{translate(locale, "trade.unavailable")}</p>;
  }
  return (
    <div className="trade-table-content">
      <div className="data-table-scroll">
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
              <tr key={`${trade.date}-${trade.side}-${index}`}>
                <td>{trade.date}</td>
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
    </div>
  );
}
