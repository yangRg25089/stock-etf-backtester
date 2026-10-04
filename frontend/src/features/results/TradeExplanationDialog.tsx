import type { RunResponse, StrategyRun, UnexecutedSignal } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { ResultDialog } from "../../shared/ui/ResultDialog";
import { formatCurrency, formatPercent, formatQuantity } from "./format";
import { resultDisplayName } from "./model";
import { explainTrade, explainUnexecutedSignal, type ExplanationCondition } from "./tradeExplanation";
import { savedResultConfiguration } from "./savedConfiguration";
import { TradingCostsPanel } from "./TradingCostsPanel";

function ConditionTree({ nodes, locale }: { nodes: ExplanationCondition[]; locale: Locale }) {
  return <ul className="explanation-conditions">
    {nodes.map(node => <li key={node.id}>
      <div className={`explanation-condition is-${node.state ?? "missing"}`}>
        <strong title={node.sourceSymbol ?? undefined}>{node.label}</strong>
        {node.expression && <span className="explanation-observation">{node.expression}</span>}
        <span className="explanation-state">
          <span aria-hidden="true">{node.state === "true" ? "✓" : node.state === "false" ? "×" : "?"}</span>{" "}
          {translate(locale, node.stateLabelKey ?? `trade.explain.state.${node.state ?? "missing"}`)}
        </span>
      </div>
      {node.children.length > 0 && <ConditionTree nodes={node.children} locale={locale} />}
    </li>)}
  </ul>;
}

export type ResultInspection = { result: StrategyRun; parent?: StrategyRun | null } & (
  { kind: "trade"; index: number } | { kind: "signal"; signal: UnexecutedSignal }
);

export function TradeExplanationDialog({ run, inspection, locale, onClose }: {
  run: RunResponse;
  inspection: ResultInspection;
  locale: Locale;
  onClose(): void;
}) {
  const { result, parent } = inspection;
  const tradeExplanation = inspection.kind === "trade" ? explainTrade(run, result, inspection.index, locale, parent) : null;
  const unexecuted = inspection.kind === "signal" ? explainUnexecutedSignal(run, result, inspection.signal, locale, parent) : null;
  if (!tradeExplanation && !unexecuted) return null;
  const { candidate } = savedResultConfiguration(run, result, parent);
  const owner = parent ?? result;
  const title = resultDisplayName(locale, owner, run.result?.strategyRuns ?? []) + (candidate ? ` · #${candidate.sequence}` : "")
    + (result.evaluationPeriod ? ` · ${translate(locale, `search.phase.${result.evaluationPeriod.phase}`)}` : "");
  const trade = tradeExplanation?.trade;
  const conditions = tradeExplanation?.conditions ?? unexecuted?.conditions ?? [];
  const currency = trade?.currency;
  const beforeAfter = (before?: string | null, after?: string | null, monetary = false) => (
    <>{monetary ? formatCurrency(before, currency, locale) : formatQuantity(before, locale)} <span aria-hidden="true">→</span>{" "}
      {monetary ? formatCurrency(after, currency, locale) : formatQuantity(after, locale)}</>
  );
  return <ResultDialog title={title} locale={locale} onClose={onClose}>
    <div className="explanation-summary">
      <time>{trade?.date ?? unexecuted?.signal.signalDate}</time>
      <strong className={trade?.side === "sell" ? "explanation-sell" : "explanation-buy"}>
        {trade ? `${translate(locale, `trade.side.${trade.side}`)} ${formatCurrency(trade.cashAmount, trade.currency, locale)}` : translate(locale, "trade.explain.unexecuted")}
      </strong>
      {trade && <span>{translate(locale, `trade.reason.${trade.reason}`)}</span>}
    </div>
    {tradeExplanation?.signalDate && <p className="explanation-signal-date">{translate(locale, "trade.explain.signalDate")} <time>{tradeExplanation.signalDate}</time></p>}
    {unexecuted && <p className="explanation-notice">{translate(locale, `trade.explain.reason.${unexecuted.signal.reason}`)}</p>}
    <section className="explanation-section">
      <h3>{translate(locale, "trade.explain.conditions")}</h3>
      {conditions.length ? <ConditionTree nodes={conditions} locale={locale} /> : <p className="explanation-muted">{translate(locale, trade?.signalId ? "trade.explain.state.missing" : "trade.explain.planned")}</p>}
    </section>
    {trade && <>
      <section className="explanation-section">
        <h3>{translate(locale, "trade.explain.execution")}</h3>
        <dl className="explanation-values">
          <div><dt>{translate(locale, "trade.explain.basePrice")}</dt><dd>{formatCurrency(trade.executionBasePrice, currency, locale)}</dd></div>
          <div><dt>{translate(locale, "trade.price")}</dt><dd>{formatCurrency(trade.executionPrice ?? trade.price, currency, locale)}</dd></div>
          <div><dt>{translate(locale, "trade.quantity")}</dt><dd>{formatQuantity(trade.quantity, locale)}</dd></div>
          <div><dt>{translate(locale, "trade.explain.grossAmount")}</dt><dd>{formatCurrency(trade.grossAmount, currency, locale)}</dd></div>
          {trade.side === "sell" && <div><dt>{translate(locale, "trade.explain.sellRatio")}</dt><dd>{formatPercent(tradeExplanation?.sellRatio, locale)}</dd></div>}
        </dl>
      </section>
      <TradingCostsPanel locale={locale} currency={currency} costs={trade.tradingCosts} />
      <section className="explanation-section">
        <h3>{translate(locale, "trade.explain.balances")}</h3>
        <dl className="explanation-values">
          <div><dt>{translate(locale, "trade.explain.cash")}</dt><dd>{beforeAfter(trade.cashBefore, trade.cashAfter, true)}</dd></div>
          <div><dt>{translate(locale, "trade.explain.holdings")}</dt><dd>{beforeAfter(trade.quantityBefore, trade.quantityAfter)}</dd></div>
        </dl>
      </section>
    </>}
  </ResultDialog>;
}
