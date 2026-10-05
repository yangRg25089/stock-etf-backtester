import type { ConditionGroup, ConditionKind, ConditionLeaf, RunResponse, SignalEvaluation, SignalState, StrategyRun, Trade, UnexecutedSignal } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { conditionParameters } from "../strategies/conditions";
import { savedResultConfiguration } from "./savedConfiguration";

export interface ExplanationCondition {
  id: string;
  label: string;
  operator?: "AND" | "OR";
  state: SignalState | null;
  stateLabelKey?: string;
  expression?: string;
  sourceSymbol?: string | null;
  children: ExplanationCondition[];
}

export interface TradeExplanation {
  trade: Trade;
  signalDate?: string;
  sellRatio?: string | null;
  conditions: ExplanationCondition[];
}

function conditionText(kind: ConditionKind, side: "buy" | "sell", params: Record<string, unknown>, signal: SignalEvaluation | undefined, locale: Locale) {
  const buy = side === "buy";
  const value = signal?.observedValue ?? "—";
  const threshold = (key: string) => String(params[key] ?? "—");
  let label = translate(locale, `conditions.${kind}`);
  let expression = value;
  if (kind === "vix") {
    label = (signal?.sourceSymbol ?? String(params["vix.symbol"] ?? "VIX")).replace(/^\^/, "");
    if (buy) expression = `${value} ≥ ${threshold("vix.buyThreshold")}`;
    else if (/\.low[12]$/.test(signal?.signalId ?? "")) expression = `${value} ≤ ${threshold(`exit.vix.low${signal!.signalId.at(-1)}`)}`;
  } else if (kind === "rsi") expression = `${value} ${buy ? "≤" : "≥"} ${threshold(buy ? "rsi.buyThreshold" : "exit.rsi.threshold")}`;
  else if (kind === "rate") expression = `${value} ${buy ? "≤" : "≥"} ${threshold("rate.thresholdPct")} %`;
  else if (kind === "pe") expression = `${value} ${buy ? "≤" : "≥"} ${threshold("pe.threshold")}`;
  else if (kind === "ma_deviation") {
    label = `MA(${threshold("ma.period")}) · ${label}`;
    expression = `${value} % ${buy ? "≤" : "≥"} ${threshold("ma.buyDeviationPct")} %`;
  } else if (kind === "ma_trend") {
    label = `MA(${threshold("ma.period")}) · ${translate(locale, "trade.explain.priceMinusMa")}`;
    expression = `${value} ${buy ? ">" : "≤"} 0`;
  } else if (kind === "bollinger") {
    label = `BOLL(${threshold("bollinger.period")}, ${threshold("bollinger.stddev")})`;
    if (signal?.signalId.endsWith(".vix")) {
      label = (signal.sourceSymbol ?? String(params["vix.symbol"] ?? "VIX")).replace(/^\^/, "");
      expression = `${value} < ${threshold("exit.bollinger.vixCeiling")}`;
    } else if (buy || signal?.signalId.endsWith(".price")) {
      label += ` · ${translate(locale, buy ? "trade.explain.priceMinusLower" : "trade.explain.priceMinusUpper")}`;
      expression = `${value} ${buy ? "≤" : "≥"} 0`;
    }
  }
  return { label, expression };
}

function leafExplanation(node: ConditionLeaf, side: "buy" | "sell", signals: SignalEvaluation[], overrides: Record<string, unknown>, locale: Locale): ExplanationCondition {
  const matching = signals.filter(signal => signal.conditionId === node.id);
  const signal = matching.find(signal => !/\.(low[12]|price|vix)$/.test(signal.signalId)) ?? matching[0];
  const params = { ...conditionParameters(node), ...Object.fromEntries(Object.entries(overrides).filter(([key]) => Object.hasOwn(node.params ?? {}, key))) };
  const children = matching.filter(item => /\.(low[12]|price|vix)$/.test(item.signalId)).map(item => ({
    id: item.signalId, ...conditionText(node.kind, side, params, item, locale),
    state: item.state, stateLabelKey: node.kind === "vix" ? item.state === "true" ? "trade.explain.selectedTier" : "trade.explain.unselectedTier" : undefined,
    sourceSymbol: item.sourceSymbol, children: [],
  }));
  return { id: node.id, ...conditionText(node.kind, side, params, signal, locale), state: signal?.state ?? null, sourceSymbol: signal?.sourceSymbol, children };
}

function explainNode(node: ConditionLeaf | ConditionGroup, side: "buy" | "sell", signals: SignalEvaluation[], overrides: Record<string, unknown>, locale: Locale): ExplanationCondition | null {
  if (node.enabled === false) return null;
  if ("kind" in node) return leafExplanation(node, side, signals, overrides, locale);
  const operator = node.operator ?? "AND";
  const signal = signals.find(item => item.conditionId === node.id && item.signalId === `conditions.${side}:${node.id}`);
  return { id: node.id, label: operator, operator, state: signal?.state ?? null,
    children: (node.children ?? []).flatMap(child => { const explained = explainNode(child, side, signals, overrides, locale); return explained ? [explained] : []; }) };
}

/** Retain old saved observations; do not supply current catalog defaults to old files. */
function legacyConditions(signals: SignalEvaluation[], params: Record<string, unknown>, side: "buy" | "sell", locale: Locale): ExplanationCondition[] {
  return signals.filter(signal => side === "buy" ? /(?:\.buy|ma\.trend$)/.test(signal.signalId) : /\.exit|ma\.trend\.sell/.test(signal.signalId)).flatMap(signal => {
    const base = signal.signalId.split(".")[0];
    const kind: ConditionKind | undefined = signal.conditionKind ?? (base === "ma" ? signal.signalId.startsWith("ma.trend") ? "ma_trend" : "ma_deviation" : ["vix", "rsi", "bollinger", "rate", "pe"].includes(base) ? base as ConditionKind : undefined);
    const text = kind && !signal.conditionKind && ["ma_trend", "ma_deviation", "bollinger"].includes(kind)
      ? { label: translate(locale, `conditions.${kind}`), expression: signal.observedValue ?? "—" }
      : kind ? conditionText(kind, side, params, signal, locale) : null;
    return text ? [{ id: signal.signalId, ...text, state: signal.state, sourceSymbol: signal.sourceSymbol, children: [] }] : [];
  });
}

function conditionsOnDate(run: RunResponse, result: StrategyRun, date: string | undefined, side: "buy" | "sell", locale: Locale, parent?: StrategyRun | null): ExplanationCondition[] {
  if (!date) return [];
  const signals = (result.signals ?? []).filter(signal => signal.date === date);
  const { strategy, overrides, parameters } = savedResultConfiguration(run, result, parent, date);
  const root = strategy?.rules?.[side];
  if (!root) return strategy?.rules ? [] : legacyConditions(signals, parameters, side, locale);
  const explained = explainNode(root, side, signals, overrides, locale);
  return explained ? [explained] : [];
}

export function explainTrade(run: RunResponse, result: StrategyRun, index: number, locale: Locale, parent?: StrategyRun | null): TradeExplanation | null {
  const trade = Number.isInteger(index) && index >= 0 ? result.trades?.[index] : undefined;
  if (!trade) return null;
  const signalTrade = trade.reason === "signal_buy" || trade.reason === "signal_sell";
  const dateIndex = result.dailyAssets?.findIndex(asset => asset.date === trade.date) ?? -1;
  const signalDate = signalTrade && dateIndex > 0 ? result.dailyAssets![dateIndex - 1].date : undefined;
  const signal = (result.signals ?? []).find(item => item.date === signalDate && item.signalId === trade.signalId);
  return { trade, signalDate, sellRatio: trade.side === "sell" ? signal?.sellRatio : undefined,
    conditions: signalTrade ? conditionsOnDate(run, result, signalDate, trade.side, locale, parent) : [] };
}

export function explainUnexecutedSignal(run: RunResponse, result: StrategyRun, signal: UnexecutedSignal, locale: Locale, parent?: StrategyRun | null) {
  const baseSignalId = signal.signalId.split(":", 1)[0];
  const side = baseSignalId === "accumulation.buy" || baseSignalId === "ma.trend" || baseSignalId.endsWith(".buy")
    ? "buy" : "sell";
  return { signal, conditions: conditionsOnDate(run, result, signal.signalDate, side, locale, parent) };
}
