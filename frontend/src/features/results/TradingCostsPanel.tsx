import type { TradingCosts } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { formatCurrency } from "./format";
import { TRADING_COST_FIELDS } from "./tradingCosts";

/** Read saved costs for a whole result or an individual fill, without recalculation. */
export function TradingCostsPanel({ locale, currency, costs }: { locale: Locale; currency?: string | null; costs?: TradingCosts | null }) {
  return <section className="performance-group trading-costs-panel">
    <h4>{translate(locale, "costs.heading")}</h4>
    {costs ? <dl className="performance-grid">{TRADING_COST_FIELDS.map(key => <div className="trading-cost-stat" key={key}>
      <dt>{translate(locale, `costs.${key}`)}</dt><dd>{formatCurrency(costs[key], currency, locale)}</dd>
    </div>)}</dl> : <p className="metric-empty">{translate(locale, "costs.notSaved")}</p>}
  </section>;
}
